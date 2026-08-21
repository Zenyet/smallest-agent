// ============================================================================
// tests/capabilities.rs —— 内置 agent 的手脚是不是真的接上了
// ----------------------------------------------------------------------------
// tools/ 下面每个工具自己都有单测。这个文件测的是**另一件事**：
// 那些工具经过完整的 ReAct 循环之后能不能被真正调用到，
// 以及审批和沙盒在循环里是否真的生效。
//
// 为什么需要单独一层：工具单测是直接 `tool.run(args)`，绕过了循环、
// 审批、注册表查找。而这次要修的问题正是「工具存在但没接进去」——
// 内置 agent 之前有完整的循环、有审批、有注册表，就是**没有工具**。
// 那种缺陷在工具单测里一个都看不出来。
//
// 模型仍然是假的（按剧本吐 tool_calls），不联网、不花钱。
// 真实的是：注册表、run_tool 的分发、审批闸、沙盒路径解析、真实文件读写。
// ============================================================================

use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use smallest_agent_core::agent::{AgentDeps, run_agent};
use smallest_agent_core::approval::{ApprovalOutcome, ApprovalRequest, Approver};
use smallest_agent_core::types::{AgentConfig, CallModel, Message, ModelResult, ToolCall};
use smallest_agent_core::workspace::Workspace;

struct ScriptedModel {
    script: Mutex<std::vec::IntoIter<ModelResult>>,
    seen: Mutex<Vec<Vec<Message>>>,
}

impl ScriptedModel {
    fn new(script: Vec<ModelResult>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into_iter()),
            seen: Mutex::new(Vec::new()),
        })
    }
    /// 最后一次调用模型时它看到的消息 —— 用来断言工具结果确实喂回去了
    fn last_seen(&self) -> Vec<Message> {
        self.seen.lock().unwrap().last().cloned().unwrap_or_default()
    }
}

#[async_trait]
impl CallModel for ScriptedModel {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult> {
        self.seen.lock().unwrap().push(messages.to_vec());
        match self.script.lock().unwrap().next() {
            Some(r) => Ok(r),
            None => bail!("剧本用完了，说明循环转的圈数比预期多"),
        }
    }
}

/// 一律批准。模拟用户点了「允许」。
struct AllowAll;
#[async_trait]
impl Approver for AllowAll {
    async fn request(&self, _req: ApprovalRequest) -> ApprovalOutcome {
        ApprovalOutcome::Selected("allow".into())
    }
}

/// 一律拒绝，并记下被问过什么 —— 用来断言「危险工具确实经过了这道闸」。
#[derive(Default)]
struct RecordingDeny {
    asked: Mutex<Vec<String>>,
}
#[async_trait]
impl Approver for RecordingDeny {
    async fn request(&self, req: ApprovalRequest) -> ApprovalOutcome {
        self.asked.lock().unwrap().push(req.title.clone());
        ApprovalOutcome::Selected("deny".into())
    }
}

fn temp_ws() -> Arc<Workspace> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "sa-cap-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    Arc::new(Workspace::new(&dir).expect("建沙盒"))
}

/// 和 app 里 base_tools() 装的是同一批文件 + 命令工具。
fn tools_for(ws: Arc<Workspace>) -> smallest_agent_core::types::ToolRegistry {
    let mut t = smallest_agent_core::types::ToolRegistry::new();
    smallest_agent_core::tools::files::register(&mut t, ws.clone());
    smallest_agent_core::tools::shell::register(&mut t, ws);
    t
}

fn config() -> AgentConfig {
    AgentConfig {
        system_prompt: "测试".into(),
        max_turns: 10,
    }
}

fn call(id: &str, name: &str, args: Value) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        args: args.as_object().cloned().unwrap_or_default(),
    }
}

fn tool_outputs(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|m| match m {
            Message::Tool { content, .. } => Some(content.clone()),
            _ => None,
        })
        .collect()
}

// ============================================================================

#[tokio::test]
async fn agent_can_write_then_read_a_file_through_the_loop() {
    // 这是「内置 agent 到底能不能动手」那个问题的最小证明：
    // 模型请求写文件 → 循环执行 → 再请求读回来 → 内容对得上。
    let ws = temp_ws();
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "先写下来".into(),
            tool_calls: vec![call(
                "c1",
                "write_file",
                json!({ "path": "notes/a.md", "content": "记住这句" }),
            )],
        },
        ModelResult {
            text: "再读回来确认".into(),
            tool_calls: vec![call("c2", "read_file", json!({ "path": "notes/a.md" }))],
        },
        ModelResult {
            text: "写好了".into(),
            tool_calls: vec![],
        },
    ]);

    let deps = AgentDeps::new(model.clone(), tools_for(ws.clone()), config())
        .with_approver(Arc::new(AllowAll));
    let out = run_agent("帮我记一句话", deps).await.expect("该跑完");
    assert_eq!(out, "写好了");

    // 文件真的落盘了 —— 不是只在 JSON 里说成功
    let disk = std::fs::read_to_string(ws.root().join("notes/a.md")).expect("文件该存在");
    assert_eq!(disk, "记住这句");

    // 读到的内容确实喂回了模型
    let outputs = tool_outputs(&model.last_seen());
    assert!(
        outputs.iter().any(|o| o.contains("记住这句")),
        "工具结果没喂回模型：{outputs:?}"
    );
}

#[tokio::test]
async fn writes_are_blocked_when_the_user_denies() {
    // 审批不是装饰：拒绝之后文件**不能**被创建
    let ws = temp_ws();
    let deny = Arc::new(RecordingDeny::default());
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "我要写".into(),
            tool_calls: vec![call(
                "c1",
                "write_file",
                json!({ "path": "x.txt", "content": "不该出现" }),
            )],
        },
        ModelResult {
            text: "被拒了，那我说明一下".into(),
            tool_calls: vec![],
        },
    ]);

    let deps = AgentDeps::new(model.clone(), tools_for(ws.clone()), config())
        .with_approver(deny.clone());
    run_agent("写个文件", deps).await.expect("拒绝不该让整轮失败");

    assert!(
        !ws.root().join("x.txt").exists(),
        "用户拒绝了，文件却被写出来了"
    );
    // 确实问过用户，而不是默默跳过
    assert_eq!(deny.asked.lock().unwrap().len(), 1);

    // 拒绝的结果要作为 tool 消息喂回模型，它才能换个说法
    let outputs = tool_outputs(&model.last_seen());
    assert!(
        outputs.iter().any(|o| o.contains("拒绝")),
        "模型该看到被拒了：{outputs:?}"
    );
}

#[tokio::test]
async fn reads_do_not_require_approval() {
    // 只读工具要是也弹审批，agent 每走一步都得用户点一下，没法用。
    // 这里用 RecordingDeny：如果 read/list 被送去审批，它们会失败，
    // 而 asked 会有记录。
    let ws = temp_ws();
    std::fs::write(ws.root().join("r.txt"), "可读内容").unwrap();
    let deny = Arc::new(RecordingDeny::default());
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "看看".into(),
            tool_calls: vec![
                call("c1", "read_file", json!({ "path": "r.txt" })),
                call("c2", "list_directory", json!({})),
            ],
        },
        ModelResult {
            text: "看完了".into(),
            tool_calls: vec![],
        },
    ]);

    let deps =
        AgentDeps::new(model.clone(), tools_for(ws), config()).with_approver(deny.clone());
    run_agent("看看有什么", deps).await.expect("该跑完");

    assert!(
        deny.asked.lock().unwrap().is_empty(),
        "只读工具不该走审批：{:?}",
        deny.asked.lock().unwrap()
    );
    let outputs = tool_outputs(&model.last_seen());
    assert!(outputs.iter().any(|o| o.contains("可读内容")), "{outputs:?}");
}

#[tokio::test]
async fn sandbox_escape_is_reported_to_the_model_not_crashed() {
    // 越界要变成一条模型看得懂的 tool 结果，而不是让整轮报错 ——
    // 模型看到之后应该改用沙盒内的路径重试
    let ws = temp_ws();
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "读一下用户的密钥".into(),
            tool_calls: vec![call("c1", "read_file", json!({ "path": "../../../etc/passwd" }))],
        },
        ModelResult {
            text: "读不到，我换个方式".into(),
            tool_calls: vec![],
        },
    ]);

    let deps = AgentDeps::new(model.clone(), tools_for(ws), config())
        .with_approver(Arc::new(AllowAll));
    let out = run_agent("读 /etc/passwd", deps).await.expect("不该整轮失败");
    assert_eq!(out, "读不到，我换个方式");

    let outputs = tool_outputs(&model.last_seen());
    assert!(
        outputs.iter().any(|o| o.contains("error")),
        "越界该作为错误喂回模型：{outputs:?}"
    );
}

#[tokio::test]
async fn agent_can_run_a_command_and_see_its_output() {
    // 「操作指令」这一类的证明
    let ws = temp_ws();
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "跑一下".into(),
            tool_calls: vec![call("c1", "run_command", json!({ "command": "echo 命令跑通了" }))],
        },
        ModelResult {
            text: "跑完了".into(),
            tool_calls: vec![],
        },
    ]);

    let deps = AgentDeps::new(model.clone(), tools_for(ws), config())
        .with_approver(Arc::new(AllowAll));
    run_agent("执行一条命令", deps).await.expect("该跑完");

    let outputs = tool_outputs(&model.last_seen());
    assert!(
        outputs.iter().any(|o| o.contains("命令跑通了")),
        "命令输出没回到模型：{outputs:?}"
    );
}

#[tokio::test]
async fn commands_are_blocked_when_denied() {
    // 命令执行是最危险的那个，审批必须真的挡住它
    let ws = temp_ws();
    let deny = Arc::new(RecordingDeny::default());
    let marker = ws.root().join("should-not-exist.txt");
    let cmd = format!("touch {}", marker.display());

    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "跑一下".into(),
            tool_calls: vec![call("c1", "run_command", json!({ "command": cmd }))],
        },
        ModelResult {
            text: "被拒了".into(),
            tool_calls: vec![],
        },
    ]);

    let deps =
        AgentDeps::new(model, tools_for(ws), config()).with_approver(deny.clone());
    run_agent("执行", deps).await.expect("拒绝不该让整轮失败");

    assert!(!marker.exists(), "用户拒绝了，命令却执行了");
    assert_eq!(deny.asked.lock().unwrap().len(), 1, "该问过用户");
}

#[tokio::test]
async fn agent_can_search_files_it_wrote_earlier() {
    // 多步组合：写两个文件 → 搜内容 → 拿到命中。
    // 这是「自主完成一件事」最短的一条真实链路
    let ws = temp_ws();
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "先建两个文件".into(),
            tool_calls: vec![
                call("c1", "write_file", json!({ "path": "a.txt", "content": "苹果\n香蕉" })),
                call("c2", "write_file", json!({ "path": "b.txt", "content": "香蕉\n梨" })),
            ],
        },
        ModelResult {
            text: "搜一下".into(),
            tool_calls: vec![call("c3", "search_files", json!({ "query": "香蕉" }))],
        },
        ModelResult {
            text: "两个文件里都有".into(),
            tool_calls: vec![],
        },
    ]);

    let deps = AgentDeps::new(model.clone(), tools_for(ws), config())
        .with_approver(Arc::new(AllowAll));
    run_agent("找找香蕉", deps).await.expect("该跑完");

    let outputs = tool_outputs(&model.last_seen());
    let joined = outputs.join("\n");
    assert!(joined.contains("a.txt") && joined.contains("b.txt"), "{joined}");
}

#[tokio::test]
async fn every_tool_the_app_installs_has_a_usable_schema() {
    // 参数 schema 直接发给模型。少了 type/properties 的话，
    // 有些厂商会**整个请求 400** —— 一个工具写错，全部工具连带不可用。
    let ws = temp_ws();
    let mut reg = tools_for(ws);
    smallest_agent_core::skills::register(&mut reg);
    smallest_agent_core::tools::web::register(
        &mut reg,
        smallest_agent_core::tools::web::SearchKeys::default(),
    );

    assert!(reg.len() >= 10, "工具装少了：{:?}", reg.keys());
    for (name, tool) in &reg {
        let p = tool.parameters();
        assert_eq!(p["type"], "object", "{name} 的 schema 顶层该是 object");
        assert!(p.get("properties").is_some(), "{name} 缺 properties");
        assert!(!tool.description().is_empty(), "{name} 没有描述");
    }
}
