// ============================================================================
// bridge.rs —— core 的 async 世界 → gpui 的主线程世界
// ----------------------------------------------------------------------------
// 这是整个 UI 层唯一有难度的地方，原因是三条约束撞在一起：
//
//   1. gpui 的实体状态只能在主线程改（Context<T> 不是 Send）
//   2. core 的流式回调跑在 tokio 工作线程上（llm/mod.rs 里 OnText 的注释）
//   3. run_agent 是 async 且可能跑几十秒，不能阻塞主线程
//
// 解法是单向消息流：后台任务只往 channel 里发 AgentEvent，主线程用
// gpui 的 spawn + 异步接收循环取出来、改状态、触发重绘。后台任务永远不碰
// 任何 gpui 类型 —— 这条约束一破，编译器会用 "not Send" 报错拦住，
// 所以它是被类型系统保证的，不靠自觉。
//
// 用 smol 的 channel 而不是 tokio 的：接收端在 gpui 的执行器上 await，
// 而 tokio 的 mpsc::Receiver::recv 要 tokio 上下文。smol 系的 channel
// 两边都能用，正好是这个场景要的。
// ============================================================================

use std::sync::Arc;

use smallest_agent_core::approval::{ApprovalRequest, ApprovalSink, Responder, SinkApprover};
use smallest_agent_core::cancel::{CancelToken, is_cancelled};
use smallest_agent_core::provider::{EventSink, Provider, TurnEvent, TurnRequest};

/// 后台 agent 任务发给 UI 的事件。
///
/// 不能 derive Clone/Debug：Approval 变体带着一个一次性的回信通道
/// （Responder），克隆它就意味着「两个人都能回答同一个请求」，语义上不成立。
/// 这个限制是好事 —— 它在类型层面保证了每个审批请求只被回答一次。
pub enum AgentEvent {
    /// 流式文本增量，逐 token 到达
    Delta(String),
    /// 某一轮跑完了工具，UI 拿它显示 trace
    ToolCall {
        turn: u32,
        name: String,
        args: String,
        output: String,
    },
    /// 降级到备用模型
    Fallback(String),
    /// 缓存命中，这一轮没联网
    CacheHit,
    /// 跑完了，带最终文本
    Done(String),
    /// 出错了
    Failed(String),
    /// 用户点了停止。和 Failed 分开，UI 不该把它显示成红色报错。
    Cancelled,
    /// provider 想说一句话（连接状态之类）
    Notice(String),
    /// 需要用户确认一个危险操作。
    ///
    /// **这是唯一一条带回信通道的事件** —— agent 任务在等 responder 被调用。
    /// 所以 UI 收到它之后必须最终回答（或者让 Responder 被 drop，
    /// 那样 core 那边会当取消处理，见 approval.rs 的 Drop 实现）。
    Approval(ApprovalRequest, Responder),
}

/// 事件通道的两端。
pub type EventTx = smol::channel::Sender<AgentEvent>;
pub type EventRx = smol::channel::Receiver<AgentEvent>;

pub fn channel() -> (EventTx, EventRx) {
    // 无界：模型吐 token 比 UI 消费快得多，有界会在渲染卡顿时反压到网络层，
    // 反而更糟。单次对话的 token 量在内存里不值一提。
    smol::channel::unbounded()
}

/// 把 core 的 TurnEvent 转成 UI 的 AgentEvent。
///
/// 两套事件类型几乎一样，为什么不直接用 core 的：UI 需要 Done / Failed /
/// Cancelled 这三个「一轮结束了」的变体，而 core 的 TurnEvent 只描述过程中
/// 发生的事 —— 结束是 run_turn 的返回值，不是事件。让 core 也带上结束变体
/// 会让 provider 实现有两条报告成功的路（返回值 + 事件），迟早不一致。
fn to_ui_event(ev: TurnEvent) -> AgentEvent {
    match ev {
        TurnEvent::Delta(d) => AgentEvent::Delta(d),
        TurnEvent::ToolCall {
            turn,
            name,
            args,
            output,
        } => AgentEvent::ToolCall {
            turn,
            name,
            args: serde_json::to_string(&args).unwrap_or_default(),
            output,
        },
        TurnEvent::CacheHit => AgentEvent::CacheHit,
        TurnEvent::Fallback(e) => AgentEvent::Fallback(e),
        TurnEvent::Notice(n) => AgentEvent::Notice(n),
    }
}

/// 在专用运行时上跑一轮，全程只往 tx 里发事件。
///
/// **这个函数里不能出现任何 gpui 类型**，见文件头。
#[allow(clippy::too_many_arguments)]
pub fn spawn_agent_turn(
    provider: Arc<dyn Provider>,
    session_id: String,
    question: String,
    history: Vec<smallest_agent_core::types::Message>,
    on_complete: Arc<dyn smallest_agent_core::agent::OnComplete>,
    cancel: CancelToken,
    tx: EventTx,
) {
    smallest_agent_core::runtime::handle().spawn(async move {
        let sink: EventSink = {
            let tx = tx.clone();
            Arc::new(move |ev: TurnEvent| {
                // send_blocking 而不是 send().await：sink 是同步回调，
                // 签名里没有 async。无界 channel 的 send 不会真的阻塞。
                let _ = tx.send_blocking(to_ui_event(ev));
            })
        };

        let req = TurnRequest::new(question, sink, cancel)
            // 会话 id 和存盘钩子都在请求上：provider 实例跨会话复用
            // （外部 CLI 的子进程起一次要几秒），绑在实例上就会串台。
            // 见 core 里 TurnRequest 的注释。
            .with_session(session_id)
            .with_history(history)
            .with_on_complete(on_complete);

        let event = match provider.run_turn(req).await {
            Ok(text) => AgentEvent::Done(text),
            // 取消和真错误分开：前者不该显示成报错
            Err(err) if is_cancelled(&err) => AgentEvent::Cancelled,
            // {:#} 展开 anyhow 的错误链，比 {} 信息量大得多
            Err(err) => AgentEvent::Failed(format!("{err:#}")),
        };
        let _ = tx.send(event).await;
    });
}

/// 建一个把审批请求发进事件流的 Approver。
///
/// 请求走的是同一条 channel（而不是另开一条）：这样 UI 那边的接收循环
/// 只有一处，顺序也和文字/工具事件保持一致 —— 审批卡片会出现在它对应的
/// 那次工具调用之后，而不是可能插在前面。
pub fn make_approver(tx: EventTx) -> Arc<SinkApprover> {
    let sink: ApprovalSink = Arc::new(move |req: ApprovalRequest, responder: Responder| {
        // send_blocking：sink 是同步回调。无界 channel 不会真阻塞。
        //
        // 发送失败（UI 已经关了）时 responder 在这里被 drop，
        // 它的 Drop 会回 Cancelled，agent 不会挂住。
        let _ = tx.send_blocking(AgentEvent::Approval(req, responder));
    });
    Arc::new(SinkApprover::new(sink))
}
