// ============================================================================
// tests/agent.rs —— ReAct 循环的行为测试
// ----------------------------------------------------------------------------
// 全部用假 CallModel，不联网。这正是 types.rs 把 CallModel 做成 trait
// 而不是具体类型的收益：这里塞一个「按剧本吐结果」的实现就能测完整循环。
// ============================================================================

use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use smallest_agent_core::agent::{AgentDeps, TurnInfo, run_agent};
use smallest_agent_core::types::{
    AgentConfig, Args, CallModel, Message, ModelResult, Tool, ToolCall, ToolRegistry,
};

/// 按剧本逐轮返回预设结果的假模型，并记录每次收到的 messages，
/// 用来断言「工具结果确实被喂回了下一轮」。
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

/// 一个回显参数的假工具。
struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }
    fn description(&self) -> &str {
        "回显传入的 text"
    }
    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": { "text": { "type": "string" } } })
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        Ok(json!({ "echoed": args.get("text").and_then(|v| v.as_str()).unwrap_or("") }))
    }
}

/// 总是失败的假工具，用来验证「工具报错不中断循环」。
struct FailingTool;

#[async_trait]
impl Tool for FailingTool {
    fn name(&self) -> &str {
        "boom"
    }
    fn description(&self) -> &str {
        "总是失败"
    }
    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    async fn run(&self, _args: &Args) -> Result<Value> {
        bail!("炸了")
    }
}

fn registry(tools: Vec<Arc<dyn Tool>>) -> ToolRegistry {
    tools
        .into_iter()
        .map(|t| (t.name().to_string(), t))
        .collect()
}

fn config(max_turns: u32) -> AgentConfig {
    AgentConfig {
        system_prompt: "你是测试助手".into(),
        max_turns,
    }
}

fn call(id: &str, name: &str, args: Value) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        args: args.as_object().cloned().unwrap_or_default(),
    }
}

// ===== Stage 0：模型不调工具，一轮就收尾 =====
#[tokio::test]
async fn returns_immediately_when_no_tool_calls() {
    let model = ScriptedModel::new(vec![ModelResult {
        text: "直接回答".into(),
        tool_calls: vec![],
    }]);
    let deps = AgentDeps::new(model.clone(), registry(vec![]), config(10));

    let out = run_agent("问题", deps).await.unwrap();

    assert_eq!(out, "直接回答");
    // 只调了一次模型，且上下文是 system + user 两条
    let seen = model.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].len(), 2);
    assert_eq!(seen[0][0].role(), "system");
    assert_eq!(seen[0][1].content(), "问题");
}

// ===== ReAct 主路径：调工具 → 结果喂回 → 第二轮收尾 =====
#[tokio::test]
async fn feeds_tool_result_back_into_next_turn() {
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: "我需要回显一下".into(),
            tool_calls: vec![call("c1", "echo", json!({ "text": "hi" }))],
        },
        ModelResult {
            text: "最终答案".into(),
            tool_calls: vec![],
        },
    ]);
    let deps = AgentDeps::new(
        model.clone(),
        registry(vec![Arc::new(EchoTool)]),
        config(10),
    );

    let out = run_agent("问题", deps).await.unwrap();
    assert_eq!(out, "最终答案");

    // 第二轮的上下文应该是 system + user + assistant(带工具调用) + tool(结果)
    let seen = model.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    let second = &seen[1];
    assert_eq!(second.len(), 4);
    match &second[2] {
        Message::Assistant { tool_calls, .. } => assert_eq!(tool_calls.len(), 1),
        other => panic!("第 3 条应是 assistant，实际是 {}", other.role()),
    }
    match &second[3] {
        Message::Tool {
            content,
            tool_call_id,
            name,
        } => {
            // run_tool 把工具返回值序列化成 JSON 字符串
            assert_eq!(content, r#"{"echoed":"hi"}"#);
            // tool_call_id 必须和模型给的 id 对上，否则模型关联不起来
            assert_eq!(tool_call_id, "c1");
            assert_eq!(name, "echo");
        }
        other => panic!("第 4 条应是 tool，实际是 {}", other.role()),
    }
}

// ===== 工具报错不中断循环，错误以 JSON 交给模型 =====
#[tokio::test]
async fn tool_error_becomes_json_and_loop_continues() {
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: String::new(),
            tool_calls: vec![call("c1", "boom", json!({}))],
        },
        ModelResult {
            text: "工具挂了，我换个说法".into(),
            tool_calls: vec![],
        },
    ]);
    let deps = AgentDeps::new(
        model.clone(),
        registry(vec![Arc::new(FailingTool)]),
        config(10),
    );

    let out = run_agent("问题", deps).await.unwrap();
    assert_eq!(out, "工具挂了，我换个说法");

    let seen = model.seen.lock().unwrap();
    assert!(seen[1][3].content().contains("炸了"));
    assert!(seen[1][3].content().starts_with(r#"{"error":"#));
}

// ===== 模型幻想不存在的工具 =====
#[tokio::test]
async fn unknown_tool_reports_json_error() {
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: String::new(),
            tool_calls: vec![call("c1", "nope", json!({}))],
        },
        ModelResult {
            text: "算了".into(),
            tool_calls: vec![],
        },
    ]);
    let deps = AgentDeps::new(model.clone(), registry(vec![]), config(10));

    run_agent("问题", deps).await.unwrap();

    let seen = model.seen.lock().unwrap();
    assert_eq!(seen[1][3].content(), r#"{"error":"unknown tool: nope"}"#);
}

// ===== max_turns 保险：模型死循环调工具时主动报错 =====
#[tokio::test]
async fn errors_when_exceeding_max_turns() {
    // 两轮都要调工具，max_turns=2，第二轮结束后循环耗尽
    let looping = || ModelResult {
        text: String::new(),
        tool_calls: vec![call("c", "echo", json!({ "text": "x" }))],
    };
    let model = ScriptedModel::new(vec![looping(), looping()]);
    let deps = AgentDeps::new(model, registry(vec![Arc::new(EchoTool)]), config(2));

    let err = run_agent("问题", deps).await.unwrap_err();
    assert!(err.to_string().contains("exceeded maxTurns (2)"));
}

// ===== 可选钩子：on_turn 每轮都触发，history 前置进上下文 =====
#[tokio::test]
async fn hooks_observe_turns_and_prepend_history() {
    let model = ScriptedModel::new(vec![
        ModelResult {
            text: String::new(),
            tool_calls: vec![call("c1", "echo", json!({ "text": "a" }))],
        },
        ModelResult {
            text: "好了".into(),
            tool_calls: vec![],
        },
    ]);
    let turns: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = turns.clone();

    let deps = AgentDeps::new(
        model.clone(),
        registry(vec![Arc::new(EchoTool)]),
        config(10),
    )
    .with_history(vec![Message::User {
        content: "上次说的".into(),
    }])
    .with_on_turn(move |info: &TurnInfo| recorded.lock().unwrap().push(info.turn));

    run_agent("这次的问题", deps).await.unwrap();

    // 两轮都回调了
    assert_eq!(*turns.lock().unwrap(), vec![1, 2]);
    // 第一轮上下文 = system + history + user
    let seen = model.seen.lock().unwrap();
    assert_eq!(seen[0].len(), 3);
    assert_eq!(seen[0][1].content(), "上次说的");
    assert_eq!(seen[0][2].content(), "这次的问题");
}
