// ============================================================================
// agent.rs —— 整个项目的「心脏」：一个手写的 ReAct 循环
//             （对应 TS 版 src/agent.ts）
// ----------------------------------------------------------------------------
// ReAct = Reasoning + Acting：想一步 → 做一步(调工具) → 看结果 → 再想，反复，
// 直到模型不再要调工具、给出最终答案。
//
// TS 版从 Stage 0 到 Stage 5 这个文件几乎没动过——RAG / 记忆 / MCP / 缓存 / 评估
// 全是「在循环周围加东西」，循环本身一直是这 20 来行。Rust 版保持同样的性质。
//
// 与 TS 版的结构性差异只有一处：可选钩子的表达方式。
// TS 的 AgentDeps 是个对象字面量，不传的字段就是 undefined；
// Rust 没有可选字段，改成 new() 收三个必需依赖 + with_xxx() 链式加钩子。
// 「不加钩子就退化成 Stage 0 的纯循环」这个性质一样成立。
// ============================================================================

use std::sync::Arc;

use anyhow::{Result, bail};
use async_trait::async_trait;

use crate::approval::{
    ApprovalOutcome, ApprovalRequest, Approver, DenyAll, needs_approval, new_approval_id,
    standard_options,
};
use crate::cancel::{CancelToken, Cancelled};
use crate::tools::run_tool;
use crate::types::{AgentConfig, Args, CallModel, Message, ModelResult, ToolRegistry};

/// 单次工具执行的记录，进 TurnInfo 给外部观察用。
#[derive(Debug, Clone)]
pub struct ToolOutcome {
    pub name: String,
    pub args: Args,
    pub output: String,
}

/// 每一轮的快照，给外部观察用（UI 拿它渲染 trace、eval 拿它收集证据）。
#[derive(Debug, Clone)]
pub struct TurnInfo {
    pub turn: u32,
    /// 这一轮模型的输出（文本 + 想调的工具）
    pub result: ModelResult,
    /// 这一轮实际跑了哪些工具及其结果
    pub tool_results: Vec<ToolOutcome>,
}

/// Stage 2：开局压缩过长历史。
#[async_trait]
pub trait Compact: Send + Sync {
    async fn compact(&self, messages: Vec<Message>) -> Result<Vec<Message>>;
}

/// Stage 2：跑完把完整消息存回会话文件。
#[async_trait]
pub trait OnComplete: Send + Sync {
    async fn on_complete(&self, messages: &[Message]) -> Result<()>;
}

/// 每轮观察回调。装箱是因为 AgentDeps 要能被不同调用方用不同闭包填充，
/// 而闭包每个都是匿名类型，没法直接做成字段类型。
pub type OnTurn = Box<dyn Fn(&TurnInfo) + Send + Sync>;

/// run_agent 的「依赖」。
///
/// call_model / tools / config 是核心三件套；其余是后面阶段加的可选钩子，
/// 不设就退化成 Stage 0 的纯循环——这就是为什么加了它们也没破坏旧测试。
pub struct AgentDeps {
    /// 怎么调模型。注入的，所以测试能塞假模型、上层能套缓存/重试/降级。
    pub call_model: Arc<dyn CallModel>,
    /// 有哪些工具可调。
    pub tools: ToolRegistry,
    /// 系统提示 + 防死循环上限。
    pub config: AgentConfig,
    /// 每轮回调：渲染 trace / 收集证据。
    pub on_turn: Option<OnTurn>,
    /// Stage 2：上次会话的历史（记忆）。
    pub history: Vec<Message>,
    /// Stage 2：开局压缩过长历史。
    pub compact: Option<Arc<dyn Compact>>,
    /// Stage 2：跑完把完整消息存回去。
    pub on_complete: Option<Arc<dyn OnComplete>>,
    /// 取消令牌。默认是永不取消的空令牌，所以旧调用方不用改。
    pub cancel: CancelToken,
    /// 危险工具执行前问谁。
    ///
    /// 默认 DenyAll —— 安全默认值。没接审批 UI 的调用方（测试、脚本）
    /// 会看到写操作被拒，而不是它们静默改了用户的磁盘。
    pub approver: Arc<dyn Approver>,
}

impl AgentDeps {
    /// 只给核心三件套，钩子全空 —— 等价于 TS 版 Stage 0 的调用方式。
    pub fn new(call_model: Arc<dyn CallModel>, tools: ToolRegistry, config: AgentConfig) -> Self {
        Self {
            call_model,
            tools,
            config,
            on_turn: None,
            history: Vec::new(),
            compact: None,
            on_complete: None,
            cancel: CancelToken::new(),
            approver: Arc::new(DenyAll),
        }
    }

    pub fn with_approver(mut self, approver: Arc<dyn Approver>) -> Self {
        self.approver = approver;
        self
    }

    pub fn with_cancel(mut self, cancel: CancelToken) -> Self {
        self.cancel = cancel;
        self
    }

    pub fn with_on_turn(mut self, f: impl Fn(&TurnInfo) + Send + Sync + 'static) -> Self {
        self.on_turn = Some(Box::new(f));
        self
    }

    pub fn with_history(mut self, history: Vec<Message>) -> Self {
        self.history = history;
        self
    }

    pub fn with_compact(mut self, compact: Arc<dyn Compact>) -> Self {
        self.compact = Some(compact);
        self
    }

    pub fn with_on_complete(mut self, on_complete: Arc<dyn OnComplete>) -> Self {
        self.on_complete = Some(on_complete);
        self
    }
}

/// 取消时存盘。
///
/// 失败只吞掉不上抛：调用方已经在处理取消了，再叠一个存盘错误只会把
/// 「你点了停止」变成「出错了」，用户看到的信息反而更差。
/// 存盘失败的后果是这半截对话丢了，不影响正确性。
async fn save_on_cancel(deps: &AgentDeps, messages: &[Message]) {
    if let Some(on_complete) = &deps.on_complete
        && let Err(err) = on_complete.on_complete(messages).await
    {
        eprintln!("[agent] 取消后存盘失败：{err:#}");
    }
}

pub async fn run_agent(user_input: &str, deps: AgentDeps) -> Result<String> {
    // 上下文 = 系统提示 +（可选）历史 + 本轮用户问题。
    // messages 就是 agent 的「工作台 / 短期记忆」，整个循环都在往里加东西。
    let mut messages: Vec<Message> = vec![Message::System {
        content: deps.config.system_prompt.clone(),
    }];
    messages.extend(deps.history.iter().cloned()); // 没有历史就是空（Stage 0 行为）
    messages.push(Message::User {
        content: user_input.to_string(),
    });

    // Stage 2：太长就先摘要压缩，再进循环。
    // 压缩本身要调模型，所以也是个可能被取消的点。
    if let Some(compact) = &deps.compact {
        messages = compact.compact(messages).await?;
    }

    if deps.cancel.is_cancelled() {
        return Err(anyhow::Error::new(Cancelled));
    }

    // ===== ReAct 循环本体 =====
    // turn / max_turns 只是「最多转几圈」的保险，防止模型无限调工具卡死。
    for turn in 1..=deps.config.max_turns {
        // 【Reasoning 想】问模型：看了目前的 messages，你下一步干嘛？
        //
        // 取消的三个点，这是第一个（也是最常撞上的 —— agent 大部分时间
        // 卡在这次调用里）。call_model 内部的 HTTP 层会 abort 请求，
        // 所以这里拿到的是 Err(Cancelled) 而不是等它跑完。
        let result = match deps.call_model.call(&messages).await {
            Ok(r) => r,
            Err(err) => {
                // 取消时也要存盘：用户看到的那半截答案不该在重开会话后消失。
                // 此时 messages 是一致的（assistant 消息还没 push），直接存。
                if crate::cancel::is_cancelled(&err) {
                    save_on_cancel(&deps, &messages).await;
                }
                return Err(err);
            }
        };

        // 流式路径上取消会返回「已收到的部分」而不是 Err（见 llm/mod.rs 里
        // 那段两条路径的说明），所以这里要显式查一次：
        //   • 把那半截答案记进 messages 并存盘 —— 用户屏幕上看到的东西
        //     切走再回来还在
        //   • 但**不能**执行它声明的工具调用：那是个被截断的响应，
        //     里面的 tool_calls 可能只有一半，执行等于按不完整的意图行动
        if deps.cancel.is_cancelled() {
            if !result.text.is_empty() {
                messages.push(Message::Assistant {
                    content: result.text,
                    // 丢掉 tool_calls：不执行就不能留调用请求，
                    // 否则又是悬空 tool_calls
                    tool_calls: Vec::new(),
                });
            }
            save_on_cancel(&deps, &messages).await;
            return Err(anyhow::Error::new(Cancelled));
        }

        // 把模型这轮的输出记进 messages（可能是最终文本，也可能是「我要调这些工具」）。
        messages.push(Message::Assistant {
            content: result.text.clone(),
            tool_calls: result.tool_calls.clone(),
        });

        let mut tool_results: Vec<ToolOutcome> = Vec::new();

        // 【出口】模型没要调工具 = 它觉得能直接回答了 → 返回，循环结束。
        if result.tool_calls.is_empty() {
            let text = result.text.clone();
            if let Some(on_turn) = &deps.on_turn {
                on_turn(&TurnInfo {
                    turn,
                    result,
                    tool_results,
                });
            }
            // Stage 2：把这次完整对话存回会话文件
            if let Some(on_complete) = &deps.on_complete {
                on_complete.on_complete(&messages).await?;
            }
            return Ok(text);
        }

        // 【Act 做 + Observation 看结果】模型要调工具：逐个执行，把结果作为
        // Tool 消息喂回 messages。关键就在这——下一圈顶部的 call_model 会带着
        // 「工具结果」再问一次，模型于是能基于真实数据继续推理。
        // 这就是 messages「滚雪球」的地方。
        // 第三个取消点：工具执行中。
        //
        // 这里最麻烦 —— assistant 消息带着 tool_calls 已经进了 messages，
        // 如果直接存盘就留下**悬空的 tool_calls**（有调用请求、没有结果），
        // 下次加载时 OpenAI 兼容 API 会直接 400。
        //
        // 解法不是丢掉那条 assistant 消息（那样用户看到的工具调用轨迹会凭空
        // 消失），而是给没跑的调用补一条「已取消」的 tool 结果 ——
        // 协议上合法，语义上也是实话。
        for (i, call) in result.tool_calls.iter().enumerate() {
            if deps.cancel.is_cancelled() {
                // 给这个和后面所有没跑的调用补结果
                for pending in &result.tool_calls[i..] {
                    messages.push(Message::Tool {
                        content: serde_json::json!({ "error": "已取消" }).to_string(),
                        tool_call_id: pending.id.clone(),
                        name: pending.name.clone(),
                    });
                }
                save_on_cancel(&deps, &messages).await;
                return Err(anyhow::Error::new(Cancelled));
            }
            // 危险工具（写文件、执行命令）先问一句。
            //
            // 拒绝时把「用户拒绝了」作为工具结果喂回模型，而不是中断整轮 ——
            // 模型看到这个会换个做法或者解释为什么需要它，比直接失败有用。
            // 这也是为什么审批结果走 tool 消息而不是 Err。
            let output = if needs_approval(&call.name) {
                let req = ApprovalRequest {
                    id: new_approval_id(),
                    title: format!("允许执行 {}？", call.name),
                    // 参数原样展示 —— 用户要看的就是「往哪个文件写什么」
                    detail: serde_json::to_string_pretty(&call.args).unwrap_or_default(),
                    options: standard_options(),
                };
                match deps.approver.request(req).await {
                    ApprovalOutcome::Selected(id) if id == "allow" => {
                        run_tool(&deps.tools, &call.name, &call.args).await
                    }
                    _ => serde_json::json!({
                        "error": "用户拒绝了这个操作"
                    })
                    .to_string(),
                }
            } else {
                run_tool(&deps.tools, &call.name, &call.args).await
            };
            messages.push(Message::Tool {
                content: output.clone(),
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
            });
            tool_results.push(ToolOutcome {
                name: call.name.clone(),
                args: call.args.clone(),
                output,
            });
        }

        if let Some(on_turn) = &deps.on_turn {
            on_turn(&TurnInfo {
                turn,
                result,
                tool_results,
            });
        }

        // 第二个取消点：一轮跑完、准备进下一圈。
        // 此时 messages 是一致的（工具结果都补齐了），存盘安全。
        if deps.cancel.is_cancelled() {
            save_on_cancel(&deps, &messages).await;
            return Err(anyhow::Error::new(Cancelled));
        }
        // 循环回到顶部，带着新增的工具结果再问模型 → ReAct 的「再想一步」
    }

    // 转满 max_turns 还没收尾 = 大概率模型陷在反复调工具里，主动报错而不是无限跑。
    bail!(
        "Agent exceeded maxTurns ({}) without finishing",
        deps.config.max_turns
    )
}
