// ============================================================================
// provider/acp.rs —— 驱动外部 agent CLI（claude code / codex / opencode…）
// ----------------------------------------------------------------------------
// 走 ACP（Agent Client Protocol）标准协议，模型逻辑在别人进程里。
//
// ## 为什么一个实现就够，不用每家一个 driver
//
// waku 那边 `src/driver/` 有 12 个文件，因为它「用各家原生结构化协议」
// （README 明确的取舍）。走标准 ACP 的话，凡是提供 ACP 适配器的 CLI
// 都是同一套请求-通知流 —— claude code 和 codex 官方各有一个 npx 包，
// SDK 里直接有预设（AcpAgent::claude_agent() / codex()）。
//
// 代价是拿不到各家的独有能力（waku 的 rewind、computer-use 那些）。
// 对「一个界面管所有 agent」这个目标，标准协议的覆盖面更划算。
//
// ## 作用域式 API 与长命会话的矛盾（这个文件的主要复杂度）
//
// SDK 的连接是作用域式的：
//   Client.builder()...connect_with(agent, |connection| async { ... })
// 整个会话活在那个闭包里，闭包返回连接就断。
//
// 但我们要的是「建一次会话，多轮对话」—— 用户在同一个会话里连续提问，
// 而 CLI 那侧维护着上下文（这正是用外部 CLI 的意义，它自己管历史）。
//
// 解法和 mcp.rs 里那个 RunningService 不是 Sync 的问题同形：
// 让连接住在一个长任务里，外面只留一个 mpsc 发送端。这个文件里的
// AcpSession 就是那个「外面的把手」。
//
// 顺带解决了另一个问题：ConnectionTo<Agent> 不是 Send + Sync，
// 没法放进 Provider（要求 Send + Sync）。住在任务里就不用跨线程搬它。
// ============================================================================

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, Result, anyhow};
use async_trait::async_trait;
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::approval::{
    ApprovalOption, ApprovalOutcome, ApprovalRequest, Approver, DenyAll, new_approval_id,
};
use crate::cancel::{CancelToken, Cancelled};
use crate::provider::{EventSink, Provider, TurnEvent, TurnRequest};

/// 一个 ACP agent 的启动配置。
#[derive(Debug, Clone)]
pub struct AcpSpec {
    /// 显示名（"Claude Code"、"Codex"）
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    /// agent 的工作目录。ACP 的 session/new 要这个 —— CLI 靠它决定
    /// 「在哪个项目里干活」，这也是为什么项目分组对外部 CLI 特别有用。
    pub cwd: PathBuf,
}

impl AcpSpec {
    /// 官方 claude code 适配器。
    pub fn claude_code(cwd: PathBuf) -> Self {
        Self {
            name: "Claude Code".into(),
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@agentclientprotocol/claude-agent-acp@latest".into(),
            ],
            env: Default::default(),
            cwd,
        }
    }

    /// 官方 codex 适配器。
    pub fn codex(cwd: PathBuf) -> Self {
        Self {
            name: "Codex".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@agentclientprotocol/codex-acp@latest".into()],
            env: Default::default(),
            cwd,
        }
    }
}

/// 发给后台连接任务的请求。
enum SessionCommand {
    /// 发一轮 prompt。事件流经 sink，最终答案回 reply。
    Prompt {
        text: String,
        events: EventSink,
        approver: Arc<dyn Approver>,
        cancel: CancelToken,
        reply: oneshot::Sender<Result<String>>,
    },
}

/// 外部 CLI 作为一个 Provider。
///
/// 连接是**懒建**的：第一次 run_turn 才起子进程。理由是用户可能配了三个
/// provider 却只用一个，启动时全连上等于白起两个 node 进程
/// （每个都要几秒 + 几十 MB 内存）。
pub struct AcpProvider {
    spec: AcpSpec,
    /// 通往后台连接任务的发送端。None = 还没连。
    ///
    /// Mutex 而不是 OnceCell：连接可能因为子进程崩溃而失效，
    /// 那时要能换一个新的。OnceCell 只能设一次。
    tx: Mutex<Option<mpsc::UnboundedSender<SessionCommand>>>,
    approver: Arc<dyn Approver>,
}

impl AcpProvider {
    pub fn new(spec: AcpSpec) -> Self {
        Self {
            spec,
            tx: Mutex::new(None),
            approver: Arc::new(DenyAll),
        }
    }

    pub fn with_approver(mut self, approver: Arc<dyn Approver>) -> Self {
        self.approver = approver;
        self
    }

    /// 拿一个可用的发送端，没有就建连接。
    async fn sender(&self) -> Result<mpsc::UnboundedSender<SessionCommand>> {
        let mut guard = self.tx.lock().await;

        // 已有且还活着就复用。
        //
        // 查 is_closed 而不是无脑复用：子进程崩了之后通道会关，
        // 那时候必须重连而不是往一个死通道里发（发出去永远等不到回复，
        // 表现成「点了发送什么都没发生」）。
        if let Some(tx) = guard.as_ref()
            && !tx.is_closed()
        {
            return Ok(tx.clone());
        }

        let tx = spawn_session(self.spec.clone()).await?;
        *guard = Some(tx.clone());
        Ok(tx)
    }
}

#[async_trait]
impl Provider for AcpProvider {
    fn name(&self) -> &str {
        &self.spec.name
    }

    /// 外部 CLI 自己管工具 —— 它有哪些工具、怎么配，我们既不知道也不该插手。
    /// UI 靠这个决定不显示我们的工具状态那一行。
    fn manages_own_tools(&self) -> bool {
        true
    }

    async fn run_turn(&self, req: TurnRequest) -> Result<String> {
        let TurnRequest {
            question,
            // history 用不上：ACP 那侧的 CLI 自己维护会话上下文，
            // 这正是「一次连接、多轮对话」的意义。我们再发一遍历史等于
            // 让它把同样的话看两遍。
            history: _,
            events,
            cancel,
        } = req;

        let tx = self.sender().await?;
        let (reply_tx, reply_rx) = oneshot::channel();

        tx.send(SessionCommand::Prompt {
            text: question,
            events,
            approver: self.approver.clone(),
            cancel: cancel.clone(),
            reply: reply_tx,
        })
        .map_err(|_| anyhow!("ACP 连接任务已退出"))?;

        // 等回复，同时盯着取消 —— 用户点停止时不该继续等 CLI 跑完
        tokio::select! {
            r = reply_rx => r.context("等 ACP 回复失败")?,
            () = cancel.cancelled() => Err(anyhow::Error::new(Cancelled)),
        }
    }
}

/// 起一个后台任务，里面住着 ACP 连接，返回通往它的发送端。
///
/// 这个函数是整个文件的核心：把作用域式的 connect_with 变成长命会话。
/// 连接、初始化、建会话都在任务里做完，然后进一个循环等命令 ——
/// 闭包一直不返回，所以连接一直活着。
async fn spawn_session(spec: AcpSpec) -> Result<mpsc::UnboundedSender<SessionCommand>> {
    use agent_client_protocol::schema::ProtocolVersion;
    use agent_client_protocol::schema::v1::{
        ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
        RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
        SelectedPermissionOutcome, SessionNotification, TextContent,
    };
    use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
    // 用来把「连上了没」告诉调用方 —— 起子进程 + 握手会失败（npx 拉包失败、
    // 网络不通），不能让调用方发了 prompt 才发现连不上。
    let (ready_tx, ready_rx) = oneshot::channel::<Result<()>>();
    // 放进共享格子：连接闭包里成功时发 Ok，闭包整体失败时在外面发 Err。
    // 两边都要能发，而 oneshot::Sender 是 move-only，所以得共享。
    let ready: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<()>>>>> =
        Arc::new(std::sync::Mutex::new(Some(ready_tx)));
    let ready_inner = ready.clone();

    // 每轮对话的事件去处。连接任务是长命的，而 sink 每轮不同，
    // 所以放在共享格子里而不是捕获进闭包 —— 通知回调（那个闭包）在连接建立时
    // 就固定了，没法每轮换。
    let slot: Arc<std::sync::Mutex<Option<TurnSlot>>> = Arc::new(std::sync::Mutex::new(None));

    let slot_notify = slot.clone();
    let slot_perm = slot.clone();
    // spec 会被 move 进闭包，名字先留一份给错误消息用
    let display_name = spec.name.clone();

    crate::runtime::handle().spawn(async move {
        let mut config = AcpAgentConfig::new(&spec.command).args(spec.args.clone());
        for (k, v) in &spec.env {
            config = config.env(k, v);
        }
        let agent = AcpAgent::new(config);

        let result = agent_client_protocol::Client
            .builder()
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    if let Some(slot) = slot_notify.lock().expect("事件槽锁").as_ref() {
                        forward_notification(notification, &slot.events);
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: RequestPermissionRequest, responder, _connection| {
                    // agent 要写文件/执行命令，转成我们的审批请求。
                    //
                    // **不能自动批准**（SDK 的例子是那么做的，但那是例子）——
                    // 自动批准等于绕过用户对这些 CLI 权限模型的预期。
                    // **先取出 approver 再放锁，然后才 await**。
                    //
                    // MutexGuard 不是 Send，跨 await 持有它会让整个 future
                    // 变成 !Send，而 SDK 要求回调是 Send。这不是风格问题 ——
                    // 编译器直接拒绝（"future cannot be sent between threads"）。
                    let approver = slot_perm
                        .lock()
                        .expect("事件槽锁")
                        .as_ref()
                        .map(|slot| slot.approver.clone());

                    let outcome = match approver {
                        Some(approver) => approver.request(to_approval_request(&request)).await,
                        // 没有正在跑的轮次却收到权限请求：不该发生，
                        // 保守起见拒绝
                        None => ApprovalOutcome::Cancelled,
                    };
                    let response = match outcome {
                        ApprovalOutcome::Selected(id) => RequestPermissionResponse::new(
                            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                                // id 是我们从 option_id.to_string() 存下来的，
                                // 这里转回协议类型
                                agent_client_protocol::schema::v1::PermissionOptionId::from(id),
                            )),
                        ),
                        ApprovalOutcome::Cancelled => {
                            RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)
                        }
                    };
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
                // 握手
                connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                // 建会话。cwd 决定 CLI 在哪个项目里干活。
                let session = connection
                    .send_request(NewSessionRequest::new(spec.cwd.clone()))
                    .block_task()
                    .await?;
                let session_id = session.session_id;

                // 到这里才算连上，通知调用方
                if let Some(tx) = ready_inner.lock().expect("ready 锁").take() {
                    let _ = tx.send(Ok(()));
                }

                // ===== 命令循环 =====
                // 闭包在这里不返回，所以连接一直活着 —— 这就是把作用域式 API
                // 变成长命会话的那一步。
                while let Some(cmd) = cmd_rx.recv().await {
                    match cmd {
                        SessionCommand::Prompt {
                            text,
                            events,
                            approver,
                            cancel,
                            reply,
                        } => {
                            // 装上本轮的事件去处，通知回调和权限回调都从这里读
                            *slot.lock().expect("事件槽锁") = Some(TurnSlot {
                                events: events.clone(),
                                approver,
                                text: Arc::new(std::sync::Mutex::new(String::new())),
                            });

                            let send = connection
                                .send_request(PromptRequest::new(
                                    session_id.clone(),
                                    vec![ContentBlock::Text(TextContent::new(text))],
                                ))
                                .block_task();

                            let outcome = tokio::select! {
                                r = send => match r {
                                    Ok(_) => {
                                        // 最终答案是流式片段拼起来的 ——
                                        // PromptResponse 只带 stop_reason，不带文本
                                        let text = slot
                                            .lock()
                                            .expect("事件槽锁")
                                            .as_ref()
                                            .map(|s| s.text.lock().expect("文本锁").clone())
                                            .unwrap_or_default();
                                        Ok(text)
                                    }
                                    Err(e) => Err(anyhow!("ACP prompt 失败：{e}")),
                                },
                                () = cancel.cancelled() => {
                                    // TODO: 该发 session/cancel 通知让 CLI 停下来。
                                    // 现在只是不等它了 —— CLI 会继续跑完这一轮，
                                    // 下一轮的上下文里会有它。要修得先确认
                                    // SDK 里 CancelNotification 的具体类型名。
                                    Err(anyhow::Error::new(Cancelled))
                                }
                            };

                            *slot.lock().expect("事件槽锁") = None;
                            let _ = reply.send(outcome);
                        }
                    }
                }
                Ok(())
            })
            .await;

        if let Err(e) = result
            && let Some(tx) = ready.lock().expect("ready 锁").take()
        {
            // 连接建立阶段就失败了（npx 拉包失败、握手不通）。
            // take 到 Some 说明还没报过就绪 —— 那就把错误报上去，
            // 否则调用方会一直等 ready_rx。
            let _ = tx.send(Err(anyhow!("{e}")));
        }
    });

    ready_rx
        .await
        .context("等 ACP 连接就绪失败")?
        .with_context(|| format!("连接 {display_name} 失败"))?;
    Ok(cmd_tx)
}

/// 本轮的事件去处 + 累积的文本。
struct TurnSlot {
    events: EventSink,
    approver: Arc<dyn Approver>,
    /// 流式片段累积成最终答案。
    ///
    /// ACP 的 PromptResponse 只带 stop_reason 不带文本 —— 内容全在
    /// AgentMessageChunk 通知里，所以必须自己攒。
    text: Arc<std::sync::Mutex<String>>,
}

/// 把 ACP 的 session/update 通知翻译成我们的 TurnEvent。
fn forward_notification(
    notification: agent_client_protocol::schema::v1::SessionNotification,
    events: &EventSink,
) {
    use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate};

    /// 从 ContentBlock 取文本。非文本内容（图片、音频）暂时忽略 ——
    /// UI 还不能渲染它们，硬转成占位文字反而干扰阅读。
    fn text_of(block: &ContentBlock) -> Option<String> {
        match block {
            ContentBlock::Text(t) => Some(t.text.clone()),
            _ => None,
        }
    }

    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            if let Some(t) = text_of(&chunk.content) {
                events(TurnEvent::Delta(t));
            }
        }
        // 思考过程单独走 Notice 而不是混进正文 —— 它是过程不是答案，
        // 混进去会让最终答案里夹着模型的自言自语。
        SessionUpdate::AgentThoughtChunk(chunk) => {
            if let Some(t) = text_of(&chunk.content) {
                events(TurnEvent::Notice(format!("思考：{}", t.trim())));
            }
        }
        // 工具调用开始。ACP 分「开始」和「更新」两个通知，
        // 我们只在开始时报一次 —— UI 那边一个工具一行，
        // 状态变化（running → done）现在没地方显示。
        SessionUpdate::ToolCall(call) => {
            events(TurnEvent::ToolCall {
                // ACP 没有「第几轮」的概念（那是 ReAct 循环的东西）
                turn: 0,
                name: call.title.clone(),
                args: Default::default(),
                output: String::new(),
            });
        }
        // 别的变体（Plan、模式切换、可用命令）暂时不显示。
        // 忽略而不是报错：协议会加新变体，见到不认识的就崩掉太脆。
        _ => {}
    }
}

/// 把 ACP 的权限请求翻译成我们的审批请求。
///
/// 选项**原样转发**（连 id 一起），不映射成「批准/拒绝」两个 —— 各家 CLI
/// 的选项不一样（claude code 有「本会话都允许」），擅自映射是在替用户
/// 做他没做的决定。这也是 approval.rs 里 ApprovalOption 照 ACP 形状设计的原因。
fn to_approval_request(
    request: &agent_client_protocol::schema::v1::RequestPermissionRequest,
) -> ApprovalRequest {
    use agent_client_protocol::schema::v1::PermissionOptionKind;

    let options: Vec<ApprovalOption> = request
        .options
        .iter()
        .map(|o| ApprovalOption {
            id: o.option_id.to_string(),
            label: o.name.clone(),
            // 靠协议给的 kind 判断，不猜 label 的字面 ——
            // 各家文案不同，猜必然出错
            is_approve: matches!(
                o.kind,
                PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
            ),
        })
        .collect();

    ApprovalRequest {
        id: new_approval_id(),
        // title 是 Option —— agent 不一定给。没给时退回工具类型，
        // 总比显示「请求执行 None」好
        title: format!(
            "请求执行 {}",
            request
                .tool_call
                .fields
                .title
                .clone()
                .unwrap_or_else(|| "一个操作".into())
        ),
        detail: serde_json::to_string_pretty(&request.tool_call)
            .unwrap_or_default()
            .chars()
            .take(1200)
            .collect(),
        options,
    }
}
