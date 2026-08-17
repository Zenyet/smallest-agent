// ============================================================================
// chat.rs —— 主界面：侧边栏 + 对话区
//            对应 electron/renderer/src/{App,components/ChatWindow,MessageBubble}.tsx
// ----------------------------------------------------------------------------
// 状态分两层，和 Electron 版一致：
//   • 全局：会话列表、当前会话 id
//   • 每会话：消息、是否在跑、错误。存在 HashMap<session_id, SessionChat> 里，
//     所以切走了消息也还在（Electron 那边靠 reducer 按 sessionId 分桶，同理）。
//
// 关键约束（见 bridge.rs 文件头）：事件接收循环必须跑在主线程。
// 事件带 session_id，落到对应的桶上 —— 用户切走时后台那轮仍在跑，
// 回来还能看到完整结果。
// ============================================================================

use std::collections::HashMap;
use std::sync::Arc;

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::input::{InputEvent, Textarea, TextareaState};
use gpui_component::text::TextView;
use gpui_component::{Icon, IconName};
use smallest_agent_core::agent::{Compact, OnComplete};
use smallest_agent_core::approval::{ApprovalOutcome, ApprovalRequest, Responder};
use smallest_agent_core::cancel::CancelToken;
use smallest_agent_core::memory::{
    CompactHook, JsonSessionStore, ModelSummarizer, SaveSessionHook, SessionMeta, SessionStore,
    new_session_id,
};
use smallest_agent_core::provider::{BuiltinProvider, Provider};
use smallest_agent_core::types::{Config, Message, ToolRegistry};

use crate::assets::{FONT_MONO, FONT_SANS};
use crate::bridge::{self, AgentEvent, EventRx};
use crate::projects::{self, ProjectsState};
use crate::provider_config;
use crate::settings::{SettingsForm, render_settings};
use crate::sidebar::{SidebarCallbacks, SidebarProps, render_sidebar};
use crate::theme::{FontSize, Radius, Tokens, markdown_style, shadow_card, shadow_hairline};
use smallest_agent_core::mcp_config;

/// 长会话只渲染最近 N 条。不引虚拟滚动 —— 对聊天这种「几乎总是看底部」的场景，
/// 截断 + 一个「显示更早」按钮就够了，代码量和依赖都小得多。
/// 数值和 Electron 版 visible-window.ts 的 DEFAULT_LIMIT 一致。
const VISIBLE_LIMIT: usize = 100;

/// composer 的行数范围。
///
/// 随内容长高、封顶后内部滚动，靠 TextareaState::auto_grow 实现。
///
/// min=2：单行太矮，光标看着像挤在缝里；两行给出「这是可以写一段话的地方」
/// 的体量，也和右下角 26px 的发送按钮配平。
///
/// max=10：约 210px，是 720 高窗口的三分之一以内。Electron 版用的是
/// maxHeight=200px 并注明「composer 不该吃掉对话区」，同一个取舍。
/// 再高就该让用户自己去别处写长文粘进来。
const COMPOSER_MIN_ROWS: usize = 2;
const COMPOSER_MAX_ROWS: usize = 10;

/// 内容栏最大宽度。
///
/// 对话区不是「左右气泡」而是**一条居中定宽的文档流** —— 这是对标 waku 后
/// 改掉的最大一处。理由：
///   • 气泡布局在宽窗口下会把一行文字拉到一米宽，眼睛跳行；定宽栏保证
///     每行 70-90 字符，是长文阅读的舒适区间
///   • 助手输出常含代码块和列表，它们在 76% 宽的气泡里被挤压，
///     而定宽栏里能完整展开
///   • 用户消息不再是深色块靠右：它是这轮对话的「标题」，靠排版
///     （字重 + 上方留白）区分角色，比色块更安静
///
/// 720 是 waku 的值，实测在 980 宽窗口下左右留白舒服。
const CONTENT_MAX_WIDTH: f32 = 720.;

/// 删除会话的动作。右键菜单要 Box<dyn Action>，所以得是个具名 action。
///
/// session_id 直接带在 action 上：菜单是在渲染那一行时构造的，
/// 那时就知道是哪个会话，不必再让 handler 去猜「刚才右键的是哪一项」
/// （Electron 版靠主进程回传 id 做这件事）。
/// no_json：这个 action 只在进程内派发（右键菜单点一下），
/// 不需要从 keymap 的 JSON 反序列化，所以免掉 Deserialize 的约束。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct DeleteSession {
    pub session_id: String,
}

/// 移除项目的动作。同样只在进程内派发。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct RemoveProject {
    pub project_id: String,
}

/// 界面上的一条消息。不直接用 core 的 Message：UI 需要额外状态
/// （是否还在流式、这一轮调了哪些工具、是否缓存命中）。
pub struct DisplayMessage {
    pub role: Role,
    pub text: String,
    /// 这条 assistant 消息期间的工具调用，按轮分组显示在气泡内正文上方
    pub tools: Vec<ToolTrace>,
    pub streaming: bool,
    pub cache_hit: bool,
    /// 被用户中断的。UI 在末尾加一个「已停止」标记 ——
    /// 不标的话这条半截答案看着像模型自己说完了。
    pub interrupted: bool,
}

#[derive(PartialEq, Clone, Copy)]
pub enum Role {
    User,
    Assistant,
}

pub struct ToolTrace {
    pub turn: u32,
    pub name: String,
    pub args: String,
    pub output: String,
}

impl ToolTrace {
    /// 工具输出是不是一个错误。
    ///
    /// core 的 run_tool 把失败序列化成 {"error": ...}，所以查这个前缀就够 ——
    /// 对应 Electron 版 ToolCallIndicator 的 isFailed。
    fn failed(&self) -> bool {
        self.output.trim_start().starts_with("{\"error\"")
    }
}

/// 工具加载状态。
pub enum ToolsStatus {
    /// 正在连 MCP server
    Loading,
    /// 连好了。空 Vec 表示没配工具（不是错误）
    Ready { tool_names: Vec<String> },
    /// 连失败了。带上原因 —— 「工具静默消失」是最难查的一类问题，
    /// 用户会以为是模型不肯调工具。
    Failed(String),
}

/// 单个会话的界面状态。
#[derive(Default)]
pub struct SessionChat {
    pub messages: Vec<DisplayMessage>,
    pub running: bool,
    pub error: Option<String>,
    /// 展开了哪些轮的工具调用。默认全折叠 ——
    /// 「把推理证据放在一次点击之外」是 Electron 版明确的设计取舍。
    pub expanded_turns: Vec<u32>,
    /// 等用户回答的审批请求。
    ///
    /// 存 request 和 responder 两半：request 用来渲染卡片，
    /// responder 在用户点按钮时被 move 出去调用（一次性，见 core 的 approval.rs）。
    ///
    /// 存在**会话**上而不是 ChatView 上：用户可以切走再回来，
    /// 那张卡片得跟着它对应的会话。
    pub pending_approval: Option<(ApprovalRequest, Responder)>,
    /// 本轮的取消令牌。None = 没有正在跑的轮次。
    ///
    /// 存在会话上而不是 ChatView 上：agent 一次只跑一个会话，但用户可以
    /// 切走再切回来，令牌得跟着那个会话，否则回来之后停止按钮点了没反应。
    pub cancel: Option<CancelToken>,
    /// 是否展开了全部历史（点过「显示更早的 N 条」）。
    ///
    /// 这是**每会话**状态，不能提到 ChatView 上：Electron 版的注释记了这个坑 ——
    /// showAll 泄露到切换后的新会话会让长会话把几百条消息一次全渲染出来。
    pub show_all: bool,
}

pub struct ChatView {
    input: Entity<TextareaState>,
    /// 按 session_id 分桶。切走的会话状态不丢。
    chats: HashMap<String, SessionChat>,
    sessions: Vec<SessionMeta>,
    current_id: String,
    /// 项目分组状态。真相在磁盘上的 projects.json，这里是内存副本。
    projects: ProjectsState,
    /// 工具加载状态。
    ///
    /// 单独一个状态而不是「工具准备好了才让人说话」：连 MCP server 要起子进程、
    /// 握手，慢的能到几秒。让用户干等着看不到界面很糟，而没有工具也能正常聊天
    /// （模型只是不能调工具而已）。所以界面先起来，工具在后台连，连上了再热插进去。
    tools_status: ToolsStatus,
    /// 设置表单。None = 没打开设置，显示对话。
    ///
    /// 设置是同一棵树上的另一个分支，不是独立窗口 —— 见 settings.rs 的
    /// SettingsSection 注释里记的三条理由。
    settings: Option<SettingsForm>,
    /// 当前选中的项目：决定新会话落在哪儿。
    /// 跟 current_id 是两件事 —— 可以选中一个项目却不打开它下面任何会话。
    current_project_id: Option<String>,

    /// 消息区的滚动句柄，新消息到达时用它滚到底
    scroll: ScrollHandle,
    /// 上一帧渲染时的消息数。变了就说明有新消息，该滚到底。
    last_len: usize,

    config: Config,
    /// 当前 provider。内置 agent 或（将来）外部 CLI ——
    /// ChatView 只认 Provider trait，不知道背后是哪种。
    ///
    /// 用 Mutex 是因为工具后台连上时要换掉里面的（内置 provider 的注册表
    /// 被烤进了 HTTP 请求体构造里）。换的频率是「启动时一次」，
    /// 锁竞争不存在。
    provider: Arc<std::sync::Mutex<Arc<dyn Provider>>>,
    tools: ToolRegistry,
    store: Arc<dyn SessionStore>,
    /// 压缩钩子。存在这里是因为每轮重绑 on_complete 时要重建 provider，
    /// 那时还得把它带上。
    compact: Arc<dyn Compact>,
    /// 审批器。同上 —— 重建 provider 时要带上。
    approver: Arc<dyn smallest_agent_core::approval::Approver>,
    tx: bridge::EventTx,
    rx: EventRx,

    _subscriptions: Vec<Subscription>,
}

impl ChatView {
    pub fn new(
        config: Config,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> anyhow::Result<Self> {
        let input = cx.new(|cx| {
            // Textarea 而不是单行 InputState：auto_grow 让它随内容长高、
            // 到 COMPOSER_MAX_ROWS 封顶后内部滚动。
            // submit_on_enter 保住「回车发送」，Shift+回车换行是它自带的。
            TextareaState::new(window, cx)
                .placeholder("问点什么（Enter 发送，Shift+Enter 换行）")
                .auto_grow(COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS)
                .submit_on_enter(true)
        });

        let subscriptions =
            vec![
                cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| {
                    if matches!(ev, InputEvent::PressEnter { .. }) {
                        this.send(window, cx);
                    }
                }),
            ];

        let (tx, rx) = bridge::channel();
        let tools = ToolRegistry::new();
        let store: Arc<dyn SessionStore> = Arc::new(JsonSessionStore::new(&config.sessions_dir)?);

        // 摘要器需要一个 CallModel，而装配那摞装饰器现在是 provider 内部的事。
        // 所以摘要用一条独立的、不带取消也不带缓存的轻链 —— 压缩是「为了继续
        // 这轮」做的准备工作，给它绑本轮令牌会让「取消发生在压缩期间」
        // 变成一个要单独处理的状态。
        let summarizer = Arc::new(ModelSummarizer::new(Arc::new(
            smallest_agent_core::llm::HttpCallModel::new(&config, ToolRegistry::new())?,
        )));
        let compact: Arc<dyn Compact> = Arc::new(CompactHook::new(
            config.max_context_tokens as usize,
            config.keep_recent,
            summarizer,
        ));

        // on_complete 每轮不同（会话 id 会变），所以不在这儿绑，见 send()
        // 审批器把请求发进同一条事件通道，UI 收到后渲染卡片
        let approver = bridge::make_approver(tx.clone());

        // 读 provider 配置，按配置建 provider
        let provider_cfg = provider_config::load_config();
        let provider: Arc<dyn Provider> = if provider_cfg.active == "builtin" {
            Arc::new(
                BuiltinProvider::new(config.clone(), tools.clone())?
                    .with_compact(compact.clone())
                    .with_approver(approver.clone()),
            )
        } else {
            // 找对应的外部 provider 定义
            match provider_cfg
                .external
                .iter()
                .find(|e| e.id == provider_cfg.active)
            {
                Some(ext) => {
                    use smallest_agent_core::provider::AcpProvider;
                    let spec = smallest_agent_core::provider::AcpSpec {
                        name: ext.name.clone(),
                        command: ext.command.clone(),
                        args: ext.args.clone(),
                        env: ext.env.clone(),
                        // cwd：配置里没指定就用当前目录（启动时的工作目录）
                        cwd: ext.cwd.clone().unwrap_or_else(|| std::env::current_dir().unwrap()),
                    };
                    Arc::new(AcpProvider::new(spec).with_approver(approver.clone()))
                }
                None => {
                    // 配置的 active 指向一个不存在的 id：降级到内置
                    Arc::new(
                        BuiltinProvider::new(config.clone(), tools.clone())?
                            .with_compact(compact.clone())
                            .with_approver(approver.clone()),
                    )
                }
            }
        };

        let mut this = Self {
            input,
            chats: HashMap::new(),
            sessions: Vec::new(),
            projects: projects::load_projects(),
            tools_status: ToolsStatus::Loading,
            settings: None,
            current_project_id: None,
            scroll: ScrollHandle::new(),
            last_len: 0,
            // 开局先用配置里的 session_id，load_sessions 拿到列表后会切到最近那个
            current_id: config.session_id.clone(),
            config,
            provider: Arc::new(std::sync::Mutex::new(provider)),
            tools,
            store,
            compact,
            approver,
            tx,
            rx,
            _subscriptions: subscriptions,
        };
        this.start_event_loop(cx);
        this.load_sessions(cx);
        this.load_tools(cx);
        Ok(this)
    }

    /// 后台连 MCP server，连上了热插进工具注册表。
    ///
    /// 连接对象（McpTools）刻意**不保存**：它持有子进程句柄，drop 了子进程就
    /// 被杀。所以用 Box::leak 让它活到进程结束 —— 子进程的生命周期本来就该
    /// 等于 app 的生命周期，而 UI 这层没有比「泄漏」更简单的表达方式。
    /// （真正的做法是存在 ChatView 上并在 Drop 里 close，但 gpui 的实体销毁
    /// 时机不保证跑 Drop，反而更不可靠。）
    fn load_tools(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let config = match mcp_config::load_config() {
                Ok(c) => c,
                Err(err) => {
                    let _ = this.update(cx, |this, cx| {
                        this.tools_status = ToolsStatus::Failed(format!("{err:#}"));
                        cx.notify();
                    });
                    return;
                }
            };
            let specs = config.to_specs();
            if specs.is_empty() {
                let _ = this.update(cx, |this, cx| {
                    this.tools_status = ToolsStatus::Ready { tool_names: vec![] };
                    cx.notify();
                });
                return;
            }

            let result = smallest_agent_core::mcp::load_mcp_tools_from_servers(
                &specs,
                &smallest_agent_core::mcp::default_connect,
            )
            .await;

            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(mcp) => {
                        let mut names: Vec<String> = mcp.tools.keys().cloned().collect();
                        names.sort();
                        this.tools = mcp.tools.clone();
                        this.tools_status = ToolsStatus::Ready { tool_names: names };
                        // 让连接活到进程结束，见函数注释
                        Box::leak(Box::new(mcp));
                        // 工具变了要换 provider：内置 provider 把注册表烤进了
                        // HTTP 请求体构造里，不换的话模型看不到新工具。
                        //
                        // 只对内置 provider 有意义 —— 外部 CLI 自己管工具
                        // （manages_own_tools），换了也没用，所以查一下。
                        let needs_rebuild = {
                            let p = this.provider.lock().expect("provider 锁");
                            !p.manages_own_tools()
                        };
                        if needs_rebuild
                            && let Ok(p) =
                                BuiltinProvider::new(this.config.clone(), this.tools.clone()).map(
                                    |p| {
                                        p.with_compact(this.compact.clone())
                                            .with_approver(this.approver.clone())
                                    },
                                )
                        {
                            *this.provider.lock().expect("provider 锁") = Arc::new(p);
                        }
                    }
                    Err(err) => this.tools_status = ToolsStatus::Failed(format!("{err:#}")),
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// 主线程上的事件接收循环。
    fn start_event_loop(&mut self, cx: &mut Context<Self>) {
        let rx = self.rx.clone();
        cx.spawn(async move |this, cx| {
            while let Ok(event) = rx.recv().await {
                if this
                    .update(cx, |this, cx| {
                        this.apply(event, cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    // 实体已销毁（窗口关了）
                    break;
                }
            }
        })
        .detach();
    }

    /// 开局拉会话列表，打开最近的那个。
    ///
    /// 没有会话时不建空文件 —— 空会话不落盘（Electron 版同样处理），
    /// 第一条消息答完 SaveSessionHook 才写。
    fn load_sessions(&mut self, cx: &mut Context<Self>) {
        let store = self.store.clone();
        cx.spawn(async move |this, cx| {
            let Ok(list) = store.list().await else { return };
            let first = list.first().map(|s| s.id.clone());
            let history = match &first {
                Some(id) => store.load(id).await.unwrap_or_default(),
                None => Vec::new(),
            };
            let _ = this.update(cx, |this, cx| {
                this.sessions = list;
                if let Some(id) = first {
                    // 打开的会话属于哪个项目，就把那个项目也标成选中的 ——
                    // 否则用户接着点「新对话」会莫名落到「未分组」，
                    // 而他眼里明明正在某个项目里干活。
                    this.current_project_id = this.projects.session_project.get(&id).cloned();
                    this.current_id = id.clone();
                    this.chats.insert(id, Self::hydrate(&history));
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// 把磁盘上的历史消息铺成界面消息。
    ///
    /// 工具调用和结果不铺出来：它们的 turn 信息在持久化时没保留，
    /// 硬凑一个会让「本轮 N 次工具调用」显示错的轮次。历史只看正文。
    fn hydrate(history: &[Message]) -> SessionChat {
        let mut chat = SessionChat::default();
        for m in history {
            match m {
                Message::User { content } => chat.messages.push(DisplayMessage {
                    role: Role::User,
                    text: content.clone(),
                    tools: Vec::new(),
                    streaming: false,
                    cache_hit: false,
                    interrupted: false,
                }),
                Message::Assistant { content, .. } if !content.is_empty() => {
                    chat.messages.push(DisplayMessage {
                        role: Role::Assistant,
                        text: content.clone(),
                        tools: Vec::new(),
                        streaming: false,
                        interrupted: false,
                        cache_hit: false,
                    })
                }
                _ => {}
            }
        }
        chat
    }

    fn current(&mut self) -> &mut SessionChat {
        self.chats.entry(self.current_id.clone()).or_default()
    }

    /// 把一个事件落到状态上。
    ///
    /// 事件都属于「当前正在跑的那一轮」。因为 agent 一次只跑一个会话
    /// （和 Electron 版的全局串行锁同构），所以落到 current_id 上是对的。
    fn apply(&mut self, event: AgentEvent, cx: &mut Context<Self>) {
        match event {
            AgentEvent::Delta(delta) => {
                let chat = self.current();
                if !matches!(chat.messages.last(), Some(m) if m.streaming) {
                    chat.messages.push(DisplayMessage {
                        role: Role::Assistant,
                        text: String::new(),
                        tools: Vec::new(),
                        streaming: true,
                        cache_hit: false,
                        interrupted: false,
                    });
                }
                if let Some(last) = chat.messages.last_mut() {
                    last.text.push_str(&delta);
                }
            }
            AgentEvent::ToolCall {
                turn,
                name,
                args,
                output,
            } => {
                let trace = ToolTrace {
                    turn,
                    name,
                    args,
                    output,
                };
                let chat = self.current();
                match chat.messages.last_mut() {
                    Some(m) if m.streaming => m.tools.push(trace),
                    _ => chat.messages.push(DisplayMessage {
                        role: Role::Assistant,
                        text: String::new(),
                        tools: vec![trace],
                        streaming: true,
                        cache_hit: false,
                        interrupted: false,
                    }),
                }
            }
            AgentEvent::CacheHit => {
                let chat = self.current();
                // 命中时没有流式 delta，气泡还不存在；标记挂到下一条上
                match chat.messages.last_mut() {
                    Some(m) if m.streaming => m.cache_hit = true,
                    _ => chat.messages.push(DisplayMessage {
                        role: Role::Assistant,
                        text: String::new(),
                        tools: Vec::new(),
                        streaming: true,
                        cache_hit: true,
                        interrupted: false,
                    }),
                }
            }
            AgentEvent::Fallback(err) => {
                self.current().error = Some(format!("已降级到备用模型：{err}"));
            }
            // provider 的状态播报（外部 CLI 的连接进度、权限请求之类）。
            // 走 error 那个位置显示 —— 它其实是「一行提示」而不是专指错误，
            // 名字没改是因为改了要动一堆地方，不值。
            AgentEvent::Notice(msg) => {
                self.current().error = Some(msg);
            }
            AgentEvent::Approval(req, responder) => {
                // agent 任务正停在 await 上等这个答案。
                // 存起来渲染卡片，用户点按钮时才回答。
                self.current().pending_approval = Some((req, responder));
            }
            AgentEvent::Cancelled => {
                let chat = self.current();
                chat.running = false;
                chat.cancel = None;
                // 丢掉没回答的卡片 —— Responder 的 Drop 会回 Cancelled，
                // 但这一轮已经结束了，那个答案没人要了。
                // 不清的话卡片会一直挂在界面上。
                chat.pending_approval = None;
                // 把流式中的那条收尾，保住已经收到的半截答案。
                // 不显示成错误 —— 用户知道自己点了停止，红色报错只会让人
                // 以为出了别的问题。
                if let Some(m) = chat.messages.last_mut()
                    && m.streaming
                {
                    m.streaming = false;
                    m.interrupted = true;
                }
                self.do_refresh_sessions(cx);
            }
            AgentEvent::Done(text) => {
                let chat = self.current();
                chat.running = false;
                chat.cancel = None;
                // 丢掉没回答的卡片 —— Responder 的 Drop 会回 Cancelled，
                // 但这一轮已经结束了，那个答案没人要了。
                // 不清的话卡片会一直挂在界面上。
                chat.pending_approval = None;
                match chat.messages.last_mut() {
                    Some(m) if m.streaming => {
                        m.streaming = false;
                        if m.text.is_empty() && !text.is_empty() {
                            m.text = text;
                        }
                    }
                    _ if !text.is_empty() => chat.messages.push(DisplayMessage {
                        role: Role::Assistant,
                        text,
                        tools: Vec::new(),
                        streaming: false,
                        cache_hit: false,
                        interrupted: false,
                    }),
                    _ => {}
                }
                // 答完了才落盘，这时候刷新列表才能拿到标题
                self.do_refresh_sessions(cx);
            }
            AgentEvent::Failed(err) => {
                let chat = self.current();
                chat.running = false;
                chat.cancel = None;
                // 丢掉没回答的卡片 —— Responder 的 Drop 会回 Cancelled，
                // 但这一轮已经结束了，那个答案没人要了。
                // 不清的话卡片会一直挂在界面上。
                chat.pending_approval = None;
                if let Some(m) = chat.messages.last_mut()
                    && m.streaming
                {
                    m.streaming = false;
                }
                chat.error = Some(err);
            }
        }
    }

    fn do_refresh_sessions(&mut self, cx: &mut Context<Self>) {
        let store = self.store.clone();
        cx.spawn(async move |this, cx| {
            let Ok(list) = store.list().await else { return };
            let _ = this.update(cx, |this, cx| {
                this.sessions = merge_sessions(list, &this.sessions);
                cx.notify();
            });
        })
        .detach();
    }

    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        if id == self.current_id {
            return;
        }
        self.current_id = id.clone();
        // 选中会话时把它所属的项目也标成选中，理由同 load_sessions
        self.current_project_id = self.projects.session_project.get(&id).cloned();
        // 内存里已经有就不重新读盘 —— 那会丢掉这一轮还没落盘的消息
        if self.chats.contains_key(&id) {
            cx.notify();
            return;
        }
        let store = self.store.clone();
        cx.spawn(async move |this, cx| {
            let history = store.load(&id).await.unwrap_or_default();
            let _ = this.update(cx, |this, cx| {
                this.chats.insert(id, Self::hydrate(&history));
                cx.notify();
            });
        })
        .detach();
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let id = new_session_id();
        // 乐观加进列表：空会话不落盘，不这样做它在第一次回答前不会出现。
        // 这是 Electron 版 create() 的同一个处理。
        self.sessions.insert(
            0,
            SessionMeta {
                id: id.clone(),
                title: "新会话".into(),
                updated_at: u128::MAX, // 排最前
            },
        );
        // 新会话落在当前选中的项目里
        if let Some(pid) = self.current_project_id.clone() {
            projects::assign_session(&mut self.projects, &id, Some(&pid));
            self.persist_projects();
        }
        self.chats.insert(id.clone(), SessionChat::default());
        self.current_id = id;
        cx.notify();
    }

    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        // 正在跑的会话：先取消再删。
        //
        // Electron 版这里是直接拒绝（DELETE_BLOCKED），因为 TS 的 runAgent
        // 停不下来 —— 删了那一轮还会跑完并把文件写回来，会话「复活」。
        // 现在有取消机制了，可以先停掉再删，用户不用等。
        //
        // 仍然要先取消而不是直接删：后台任务在取消路径上会存盘
        // （save_on_cancel），如果先删文件、存盘后落地，文件又回来了。
        // 取消后 Cancelled 事件到达前这个会话已经从列表移除，
        // 那次存盘写的是个孤立文件 —— 下面用 forget + 延迟删兜住。
        if let Some(chat) = self.chats.get(&id)
            && chat.running
            && let Some(token) = &chat.cancel
        {
            token.cancel();
        }
        self.sessions.retain(|s| s.id != id);
        self.chats.remove(&id);
        // 会话没了它的项目映射就是垃圾数据，清掉 —— 见 projects.rs 的 forget_session
        projects::forget_session(&mut self.projects, &id);
        self.persist_projects();
        if self.current_id == id {
            self.current_id = self
                .sessions
                .first()
                .map(|s| s.id.clone())
                .unwrap_or_else(new_session_id);
        }
        let store = self.store.clone();
        let was_running = self.chats.get(&id).is_some_and(|c| c.running);
        cx.spawn(async move |_this, _cx| {
            // 刚取消的会话要等它的存盘落完再删，否则删完之后
            // save_on_cancel 才写盘，文件又回来了。
            //
            // 200ms 是个够用的经验值：取消路径上只剩一次小 JSON 写盘。
            // 严格做法是让 spawn_agent_turn 返回个完成信号在这里 await，
            // 但那要给 bridge 加一条反向通路，为一个删除时序不值。
            // 万一真晚了，下次启动列表里会多一个会话 —— 再删一次就好。
            if was_running {
                smallest_agent_core::runtime::sleep(std::time::Duration::from_millis(200)).await;
            }
            let _ = store.delete(&id).await;
        })
        .detach();
        cx.notify();
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.current().running {
            return;
        }
        let question = self.input.read(cx).value().trim().to_string();
        if question.is_empty() {
            return;
        }
        // TextareaState 没有 clean()，用 set_value 清空
        self.input.update(cx, |s, cx| s.set_value("", window, cx));

        let session_id = self.current_id.clone();
        // 每轮一个新令牌。一次性设计，见 core 的 cancel.rs。
        let cancel = CancelToken::new();
        {
            let chat = self.current();
            chat.error = None;
            chat.cancel = Some(cancel.clone());
            chat.messages.push(DisplayMessage {
                role: Role::User,
                text: question.clone(),
                tools: Vec::new(),
                streaming: false,
                interrupted: false,
                cache_hit: false,
            });
            chat.running = true;
        }
        cx.notify();

        let store = self.store.clone();
        let tx = self.tx.clone();
        // on_complete 要带当前会话 id，所以 provider 得每轮重绑一次这个钩子。
        // 其余部分（HTTP 基座、装饰器配置）都在 provider 里复用。
        let provider = {
            let current = self.provider.lock().expect("provider 锁").clone();
            let on_complete: Arc<dyn OnComplete> =
                Arc::new(SaveSessionHook::new(store.clone(), session_id.clone()));
            rebind_on_complete(
                current,
                on_complete,
                &self.config,
                &self.tools,
                &self.compact,
                &self.approver,
            )
        };

        cx.spawn(async move |_this, _cx| {
            let history = store.load(&session_id).await.unwrap_or_default();
            bridge::spawn_agent_turn(provider, question, history, cancel, tx);
        })
        .detach();
    }

    /// 落盘项目状态。失败只记一行 —— 分组是便利功能，写不进去不该打断对话。
    fn persist_projects(&self) {
        if let Err(err) = projects::save_projects(&self.projects) {
            eprintln!("[projects] 保存失败：{err:#}");
        }
    }

    /// 弹原生目录选择器，选中的目录变成一个项目。
    ///
    /// 用户取消时 prompt_for_paths 返回 Ok(None) —— 取消不是失败，原样不动。
    fn add_project(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(dir) = paths.first().map(|p| p.to_string_lossy().to_string()) else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                let project = projects::add_project(&mut this.projects, &dir);
                // 刚添加完就选中它：用户下一步大概率是在这个项目里开对话
                this.current_project_id = Some(project.id);
                this.persist_projects();
                cx.notify();
            });
        })
        .detach();
    }

    fn remove_project(&mut self, id: String, cx: &mut Context<Self>) {
        projects::remove_project(&mut self.projects, &id);
        // 选中的项目被移掉了，选中态得跟着放掉 —— 否则新会话会挂到一个
        // 已经不存在的项目 id 上（assign_session 会当 None 处理，但 UI 上
        // 那一行已经没了，用户不知道新会话要去哪儿）。
        if self.current_project_id.as_deref() == Some(id.as_str()) {
            self.current_project_id = None;
        }
        self.persist_projects();
        cx.notify();
    }

    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings.is_none() {
            let mut form = SettingsForm::new(window, cx);
            // 工具状态的真相在 self.tools_status 上，这里灌一份快照给表单显示。
            // 不让表单自己去读配置：那样会显示「配置里写了什么」而不是
            // 「实际连上了什么」，两者在 server 启动失败时不一致 ——
            // 而那正是用户来这一页要查的情况。
            let (line, names) = match &self.tools_status {
                ToolsStatus::Loading => ("正在连接工具…".to_string(), vec![]),
                ToolsStatus::Ready { tool_names } if tool_names.is_empty() => (
                    "还没配置工具。模型现在只能靠自己的知识回答。".to_string(),
                    vec![],
                ),
                ToolsStatus::Ready { tool_names } => (
                    format!("已连接，{} 个工具可用。", tool_names.len()),
                    tool_names.clone(),
                ),
                // 完整错误在这里显示（composer 那行是截断的）
                ToolsStatus::Failed(err) => (format!("连接失败：{err}"), vec![]),
            };
            form.tools_status_line = line;
            form.tool_names = names;
            self.settings = Some(form);
        }
        cx.notify();
    }

    fn close_settings(&mut self, cx: &mut Context<Self>) {
        // 丢掉表单状态而不是留着：下次打开该重新读磁盘上的值，
        // 否则用户改了没保存、关掉再打开还能看到脏数据，
        // 会以为已经保存了。
        self.settings = None;
        cx.notify();
    }

    /// 停止当前轮次。
    ///
    /// 只发信号，不改 running —— 真正的收尾等 Cancelled 事件回来再做。
    /// 直接在这里置 running=false 的话，后台任务还在收尾（存盘）时用户就能
    /// 再点发送，两轮会叠在一起。
    fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(token) = &self.current().cancel {
            token.cancel();
        }
        cx.notify();
    }

    /// 回答审批请求。
    ///
    /// take 出 responder 而不是借用：respond 消费 self（一次性），
    /// 这在类型上保证了同一个请求不会被答两次 —— 用户快速点两下时
    /// 第二次会发现 pending_approval 已经空了。
    fn answer_approval(&mut self, option_id: String, cx: &mut Context<Self>) {
        if let Some((_, responder)) = self.current().pending_approval.take() {
            responder.respond(ApprovalOutcome::Selected(option_id));
        }
        cx.notify();
    }

    fn toggle_turn(&mut self, turn: u32, cx: &mut Context<Self>) {
        let chat = self.current();
        if let Some(pos) = chat.expanded_turns.iter().position(|t| *t == turn) {
            chat.expanded_turns.remove(pos);
        } else {
            chat.expanded_turns.push(turn);
        }
        cx.notify();
    }
}

/// 给 provider 换一个 on_complete 钩子。
///
/// on_complete 带着「存到哪个会话」，而会话是每轮可能变的（用户切走再发送），
/// 所以不能在构造 provider 时绑死。
///
/// 内置 provider 重建一个（构造只是建 reqwest client，不算贵 —— 而且
/// 用户发一次消息本来就要走网络）。外部 CLI 那种自己管会话，不需要这个钩子，
/// 原样返回。
fn rebind_on_complete(
    current: Arc<dyn Provider>,
    on_complete: Arc<dyn OnComplete>,
    config: &Config,
    tools: &ToolRegistry,
    compact: &Arc<dyn Compact>,
    approver: &Arc<dyn smallest_agent_core::approval::Approver>,
) -> Arc<dyn Provider> {
    if current.manages_own_tools() {
        // 外部 CLI：会话由它自己维护，我们不存盘
        return current;
    }
    match BuiltinProvider::new(config.clone(), tools.clone()) {
        Ok(p) => Arc::new(
            p.with_compact(compact.clone())
                .with_on_complete(on_complete)
                .with_approver(approver.clone()),
        ),
        // 建不出来就用原来那个 —— 它只是不会存盘，比整轮跑不了好
        Err(err) => {
            eprintln!("[provider] 重绑 on_complete 失败，本轮不存盘：{err:#}");
            current
        }
    }
}

/// 合并磁盘列表和本地列表。
///
/// 直接拿磁盘列表整体覆盖会有个 bug：新建的空会话不落盘，一次刷新（比如另一轮
/// 答完触发的）就把它静默冲掉 —— 用户明明看见它在侧边栏，一转头就没了。
/// 磁盘列表是「已落盘」部分的真相，本地列表里磁盘没有的 id 就是「还没落盘」，
/// 两边取并集。这是 Electron 版 mergeSessions 的同一处理（见 App.tsx 顶部长注释）。
///
/// 那边还有一个 deletedIds tombstone 机制处理「删除的 IPC 往返期间发生的并发合并」。
/// 这边不需要：删除是同步改 self.sessions + 后台 spawn 删文件，没有那个能被
/// 旧闭包看见的空档。
fn merge_sessions(disk: Vec<SessionMeta>, local: &[SessionMeta]) -> Vec<SessionMeta> {
    let disk_ids: Vec<&str> = disk.iter().map(|s| s.id.as_str()).collect();
    let mut out: Vec<SessionMeta> = local
        .iter()
        .filter(|s| !disk_ids.contains(&s.id.as_str()))
        .cloned()
        .collect();
    out.extend(disk);
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    out
}

impl Render for ChatView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 分组逻辑在 projects.rs（纯函数、可单测），这里只把两份数据交给它
        let groups = projects::group_sessions(&self.sessions, &self.projects);
        let current_id = self.current_id.clone();
        let current_project = self.current_project_id.clone();

        // 新消息到达就滚到底。
        //
        // 比较消息数而不是每帧都滚：流式输出时每个 token 都会触发一次渲染，
        // 每帧都调 scroll_to_bottom 会把用户往上翻看历史的操作一直拽回去。
        // 只在「条数变了」时滚，流式追加文字不打扰阅读。
        let len = self
            .chats
            .get(&self.current_id)
            .map(|c| c.messages.len())
            .unwrap_or(0);
        if len != self.last_len {
            self.last_len = len;
            self.scroll.scroll_to_bottom();
        }

        div()
            .flex()
            .size_full()
            .bg(Tokens::page())
            .text_color(Tokens::ink())
            .text_size(FontSize::base())
            // 字体族在根节点设一次，整棵树继承。见 assets.rs ——
            // 这是和 Electron 版观感差距最大的一处。
            .font_family(FONT_SANS)
            .font_weight(FontWeight::MEDIUM)
            // 右键菜单选「删除」会派发这个 action，在这里接
            .on_action(cx.listener(|this, action: &DeleteSession, _window, cx| {
                this.delete(action.session_id.clone(), cx);
            }))
            .on_action(cx.listener(|this, action: &RemoveProject, _window, cx| {
                this.remove_project(action.project_id.clone(), cx);
            }))
            .child(render_sidebar(
                SidebarProps {
                    groups: &groups,
                    current_id: current_id.as_str(),
                    current_project_id: current_project.as_deref(),
                    settings_section: self.settings.as_ref().map(|f| f.section),
                },
                SidebarCallbacks {
                    on_select: Box::new(|this: &mut Self, id, _window, cx| this.select(id, cx)),
                    on_create: Box::new(|this: &mut Self, _window, cx| this.create(cx)),
                    on_add_project: Box::new(|this: &mut Self, _window, cx| this.add_project(cx)),
                    on_toggle_collapsed: Box::new(|this: &mut Self, id, _window, cx| {
                        projects::toggle_collapsed(&mut this.projects, &id);
                        this.persist_projects();
                        cx.notify();
                    }),
                    on_open_settings: Box::new(|this: &mut Self, window, cx| {
                        this.open_settings(window, cx)
                    }),
                    on_select_settings_section: Box::new(
                        |this: &mut Self, section, _window, cx| {
                            if let Some(f) = this.settings.as_mut() {
                                f.section = section;
                                // 切分区时清掉上一次的保存反馈，否则它会一直挂在
                                // 新分区底下，看着像刚保存了这一页
                                f.note = None;
                            }
                            cx.notify();
                        },
                    ),
                    on_close_settings: Box::new(|this: &mut Self, _window, cx| {
                        this.close_settings(cx)
                    }),
                    on_select_project: Box::new(|this: &mut Self, id, _window, cx| {
                        // 「未分组」不是真项目，选中它等于不选任何项目
                        this.current_project_id = if id == crate::sidebar::ungrouped_id() {
                            None
                        } else {
                            Some(id)
                        };
                        cx.notify();
                    }),
                },
                cx,
            ))
            .child(match &self.settings {
                Some(form) => render_settings(
                    form,
                    |this: &mut Self, _window, cx| {
                        if let Some(f) = this.settings.as_mut() {
                            f.save(cx);
                        }
                        cx.notify();
                    },
                    cx,
                )
                .into_any_element(),
                None => self.render_chat(cx).into_any_element(),
            })
    }
}

impl ChatView {
    fn render_chat(&self, cx: &Context<Self>) -> impl IntoElement {
        let chat = self.chats.get(&self.current_id);
        let empty = SessionChat::default();
        let chat = chat.unwrap_or(&empty);

        // 对话区：flex_1 吃掉剩余宽度，消息列表再 flex_1 吃掉剩余高度。
        // px-8 py-6 和 gap-2.5 抄 Electron 版 ChatWindow 的 .chat__scroll。
        let mut scroll = div()
            .id("transcript")
            .flex()
            .flex_col()
            .flex_1()
            // 不设 gap / padding：每条消息自己负责居中和上下留白
            // （轮次之间的间距不均等，用户消息上方要更大，见 render_message）
            .overflow_y_scroll()
            .track_scroll(&self.scroll);

        // 窗口化：只渲染最近 VISIBLE_LIMIT 条，更早的折起来。
        let total = chat.messages.len();
        let start = if chat.show_all {
            0
        } else {
            total.saturating_sub(VISIBLE_LIMIT)
        };
        if start > 0 {
            scroll = scroll.child(
                div()
                    .id("show-all")
                    .flex()
                    .h(px(28.))
                    .items_center()
                    .self_center()
                    .mt(px(20.))
                    .rounded_full()
                    .bg(Tokens::surface())
                    .shadow(shadow_hairline())
                    .px(px(14.))
                    .cursor_pointer()
                    .text_size(FontSize::sm())
                    .text_color(Tokens::ink_2())
                    .hover(|s| s.bg(Tokens::hover()))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _window, cx| {
                            this.current().show_all = true;
                            cx.notify();
                        }),
                    )
                    .child(format!("显示更早的 {start} 条消息")),
            );
        }

        if chat.messages.is_empty() {
            scroll = scroll.child(
                div()
                    .flex()
                    .flex_col()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap(px(6.))
                    .child(
                        Icon::new(IconName::Bot)
                            .size(px(28.))
                            .text_color(Tokens::line_strong()),
                    )
                    .child(
                        div()
                            .text_size(px(14.))
                            .text_color(Tokens::ink_3())
                            .child("开始一段对话"),
                    ),
            );
        }

        for (i, m) in chat.messages.iter().enumerate().skip(start) {
            scroll = scroll.child(self.render_message(i, m, chat, cx));
        }

        if let Some((req, _)) = &chat.pending_approval {
            scroll = scroll.child(self.render_approval(req, cx));
        }

        // 纯等待态：跑起来了但还没有任何文字或工具调用。
        // 有流式文字时不显示 —— 那会和气泡里的光标打架（Electron 版同样区分）。
        if chat.running
            && chat.pending_approval.is_none()
            && !matches!(chat.messages.last(), Some(m) if m.streaming)
        {
            scroll = scroll.child(
                div()
                    .w_full()
                    .flex()
                    .justify_center()
                    .px_5()
                    .py(px(6.))
                    .child(
                        div()
                            .w_full()
                            .max_w(px(CONTENT_MAX_WIDTH))
                            .text_size(FontSize::sm())
                            .text_color(Tokens::ink_3())
                            .child("正在思考…"),
                    ),
            );
        }

        if let Some(err) = &chat.error {
            scroll = scroll.child(
                div()
                    .w_full()
                    .flex()
                    .justify_center()
                    .px_5()
                    .py(px(6.))
                    .child(
                        div()
                            .w_full()
                            .max_w(px(CONTENT_MAX_WIDTH))
                            .rounded(Radius::card())
                            .bg(Tokens::red_tint())
                            .shadow(shadow_hairline())
                            .px(px(12.))
                            .py(px(8.))
                            .text_size(FontSize::sm())
                            .text_color(Tokens::red())
                            .child(err.clone()),
                    ),
            );
        }

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(scroll)
            .child(self.render_composer(chat, cx))
    }

    /// 渲染一条消息。
    ///
    /// 不是气泡 —— 见 CONTENT_MAX_WIDTH 的注释。用户消息靠字重和留白区分，
    /// 助手消息是裸的 markdown 正文，两者都在同一条居中栏里。
    fn render_message(
        &self,
        idx: usize,
        m: &DisplayMessage,
        chat: &SessionChat,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let is_user = m.role == Role::User;

        let mut inner = div().flex().flex_col().w_full().min_w_0();

        if is_user {
            // 用户消息：这轮对话的「标题」。
            // 字重提到 SEMIBOLD、字号大半档，左边一条 accent 竖线做锚点 ——
            // 比深色气泡安静，但在长对话里仍然一眼能定位每轮从哪开始。
            inner = inner.child(
                div()
                    .flex()
                    .gap_3()
                    .child(
                        div()
                            .w(px(2.))
                            .flex_none()
                            .rounded_full()
                            .bg(Tokens::accent())
                            .opacity(0.6),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .line_height(px(21.))
                            .text_color(Tokens::ink())
                            .child(m.text.clone()),
                    ),
            );
            return div()
                .w_full()
                .flex()
                .justify_center()
                .px_5()
                // 每轮之间的呼吸：用户消息上方留白大，形成明显的轮次分隔
                .pt(if idx == 0 { px(20.) } else { px(28.) })
                .pb(px(8.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(CONTENT_MAX_WIDTH))
                        .min_w_0()
                        .child(inner),
                );
        }

        // 助手消息：工具调用轨迹在上，正文在下
        for group in group_by_turn(&m.tools) {
            inner = inner.child(self.render_tool_group(idx, group, chat, cx));
        }

        if m.streaming {
            // 流式中不走 markdown：半截的 ``` 或表格会让解析器每个 token 重排一次
            inner = inner.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .text_size(FontSize::base())
                    .line_height(px(21.))
                    .text_color(Tokens::ink_2())
                    .child(m.text.clone())
                    .child(
                        div()
                            .id(SharedString::from(format!("cursor-{idx}")))
                            .w(px(7.))
                            .h(px(15.))
                            .ml(px(1.))
                            .bg(Tokens::accent())
                            .with_animation(
                                SharedString::from(format!("blink-{idx}")),
                                Animation::new(std::time::Duration::from_secs(1)).repeat(),
                                // steps(2, start)：前半程可见后半程隐藏，
                                // 不做平滑淡出 —— 那是另一种观感
                                |d, delta| d.opacity(if delta < 0.5 { 1.0 } else { 0.0 }),
                            ),
                    ),
            );
        } else if !m.text.is_empty() {
            inner = inner.child(
                div()
                    .text_size(FontSize::base())
                    .line_height(px(21.))
                    .text_color(Tokens::ink_2())
                    .child(
                        TextView::markdown(SharedString::from(format!("md-{idx}")), m.text.clone())
                            .style(markdown_style())
                            // 可选中才能复制。Electron 版靠浏览器天生的文本选中，
                            // gpui 里要显式开。
                            .selectable(true),
                    ),
            );
        }

        if m.interrupted {
            inner = inner.child(
                div().mt(px(8.)).flex().child(
                    div()
                        .rounded_full()
                        .bg(Tokens::orange_tint())
                        .shadow(shadow_hairline())
                        .px(px(8.))
                        .py(px(1.))
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::orange())
                        .child("已停止"),
                ),
            );
        }

        if m.cache_hit {
            inner = inner.child(
                div().mt(px(8.)).flex().child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .rounded_full()
                        .bg(Tokens::green_tint())
                        .shadow(shadow_hairline())
                        .px(px(8.))
                        .py(px(1.))
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::green())
                        .child("缓存命中"),
                ),
            );
        }

        div()
            .w_full()
            .flex()
            .justify_center()
            .px_5()
            .py(px(6.))
            .child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .min_w_0()
                    .child(inner),
            )
    }

    /// 同一轮的工具调用压成一行摘要，点开才展开。
    ///
    /// 「把推理证据放在一次点击之外」是 Electron 版 ToolCallGroup 的核心设计，
    /// 保持默认折叠。
    fn render_tool_group(
        &self,
        msg_idx: usize,
        group: Vec<&ToolTrace>,
        chat: &SessionChat,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let turn = group[0].turn;
        let open = chat.expanded_turns.contains(&turn);
        let failed_count = group.iter().filter(|t| t.failed()).count();
        let has_failed = failed_count > 0;
        let count = group.len();

        let mut wrapper = div()
            .mb(px(8.))
            .overflow_hidden()
            .rounded(px(10.))
            .bg(Tokens::inset())
            .shadow(shadow_hairline())
            .child(
                div()
                    .id(SharedString::from(format!("tg-{msg_idx}-{turn}")))
                    .flex()
                    .h(px(28.))
                    .w_full()
                    .items_center()
                    .gap(px(6.))
                    .px_2()
                    .cursor_pointer()
                    .text_size(FontSize::xs())
                    .text_color(Tokens::ink_2())
                    .hover(|s| s.bg(Tokens::hover_2()))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _window, cx| this.toggle_turn(turn, cx)),
                    )
                    .child(
                        Icon::new(if has_failed {
                            IconName::TriangleAlert
                        } else {
                            IconName::SquareTerminal
                        })
                        .size_4()
                        .text_color(if has_failed {
                            Tokens::red()
                        } else {
                            Tokens::ink_3()
                        }),
                    )
                    .child(format!("本轮 {count} 次工具调用"))
                    .when(has_failed, |d| {
                        d.child(
                            div()
                                // 等宽 + tabular：数字宽度一致，多组叠在一起时
                                // 「3/5」和「12/15」的斜杠能对齐
                                .font_family(FONT_MONO)
                                .text_size(FontSize::tiny())
                                .text_color(Tokens::red())
                                .child(format!("{failed_count}/{count}")),
                        )
                    })
                    .child(
                        div().ml_auto().text_color(Tokens::ink_3()).child(
                            Icon::new(if open {
                                IconName::ChevronDown
                            } else {
                                IconName::ChevronRight
                            })
                            .size_4(),
                        ),
                    ),
            );

        if open {
            let mut body = div().flex().flex_col().gap_1().px_2().pb_2();
            for t in group {
                // 输出可能很长，截断。完整内容不做展开 ——
                // 这一层已经是「点开之后」了，再嵌一层折叠没必要。
                let preview: String = t.output.chars().take(400).collect();
                let ellipsis = if t.output.chars().count() > 400 {
                    "…"
                } else {
                    ""
                };
                body = body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .rounded(Radius::chip())
                        .bg(Tokens::inset())
                        .p_2()
                        .text_size(FontSize::tiny())
                        .font_family(FONT_MONO)
                        .child(
                            div()
                                .text_color(if t.failed() {
                                    Tokens::red()
                                } else {
                                    Tokens::accent_ink()
                                })
                                .child(format!("{} {}", t.name, t.args)),
                        )
                        .child(
                            div()
                                .text_color(Tokens::ink_2())
                                .child(format!("{preview}{ellipsis}")),
                        ),
                );
            }
            wrapper = wrapper.child(body);
        }
        wrapper
    }

    /// composer：居中定宽，和消息栏同一条中轴线。
    ///
    /// 三处对标 waku 改掉的：
    ///   • 宽度跟内容栏一致（720），不再横贯整个窗口 —— 输入框比正文宽
    ///     会让视线在两个宽度之间来回跳
    ///   • 圆角 14px（原来 10）。waku 的 composer 是 12，输入区更大一点更稳
    ///   • 去掉顶部那条通栏分隔线。卡片自己有 hairline + 投影，
    ///     再加一条横线是双重边界
    fn render_composer(&self, chat: &SessionChat, cx: &Context<Self>) -> impl IntoElement {
        let running = chat.running;
        // 三态：正在跑（可点，是停止）/ 输入为空（灰，不可点）/ 可发送（亮）。
        //
        // running 时按钮必须是**可点的实心**：它此刻是停止键。
        // 原来这里把 running 归到「灰色不可点」里，结果停止按钮看着像禁用的。
        let has_text = !self.input.read(cx).value().trim().is_empty();
        let active = running || has_text;
        div()
            .flex_none()
            .w_full()
            .flex()
            .justify_center()
            .px_5()
            .pb(px(18.))
            .pt(px(6.))
            .child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .rounded(px(14.))
                    .bg(Tokens::surface())
                    .shadow(shadow_card())
                    .px(px(12.))
                    .py(px(10.))
                    .child(Textarea::new(&self.input))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            // 左侧：工具状态。放在这里而不是顶部状态栏 ——
                            // 用户关心工具的时刻就是准备提问的时刻，
                            // 信息该出现在他视线所在的地方。
                            .child(self.render_tools_hint())
                            .child(
                                div()
                                    .id("send")
                                    .flex()
                                    .size(px(26.))
                                    .flex_none()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .cursor_pointer()
                                    // 可发送时实心亮底（主操作）；空输入或正在跑时降成灰。
                                    .when(active, |d| {
                                        d.bg(Tokens::ink())
                                            .text_color(Tokens::page())
                                            .hover(|s| s.opacity(0.85))
                                    })
                                    .when(!active, |d| {
                                        d.bg(Tokens::line_strong())
                                            .text_color(Tokens::ink_3())
                                            // 不可点时不该有 pointer 光标
                                            .cursor_default()
                                    })
                                    // 跑起来时这个按钮变成「停止」——
                                    // 不另加一个按钮：同一个位置、同一个手势，
                                    // 「发出去」和「收回来」是一件事的两个方向。
                                    // 另开一个按钮会让空间里多一个平时禁用的控件。
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(|this, _, window, cx| {
                                            if this.current().running {
                                                this.stop(cx);
                                            } else {
                                                this.send(window, cx);
                                            }
                                        }),
                                    )
                                    .child(
                                        Icon::new(if running {
                                            IconName::Pause
                                        } else {
                                            IconName::ArrowUp
                                        })
                                        .size(px(14.)),
                                    ),
                            ),
                    ),
            )
    }

    /// 审批卡片。
    ///
    /// 用 orange 而不是 red：这不是错误，是一个需要决定的问题。
    /// red 会让人以为出了故障。
    fn render_approval(&self, req: &ApprovalRequest, cx: &Context<Self>) -> impl IntoElement {
        let mut buttons = div().flex().items_center().gap_2().pt(px(4.));
        for opt in &req.options {
            let id = opt.id.clone();
            let is_approve = opt.is_approve;
            buttons = buttons.child(
                div()
                    .id(SharedString::from(format!("ap-{}-{}", req.id, opt.id)))
                    .flex()
                    .h(px(28.))
                    .items_center()
                    .px_3()
                    .rounded(Radius::control())
                    .cursor_pointer()
                    .text_size(FontSize::sm())
                    // 同意用实心、拒绝用描边。靠 is_approve 而不是猜 label 的
                    // 字面 —— 各家 CLI 的选项文案不一样，猜必然出错。
                    .when(is_approve, |d| {
                        d.bg(Tokens::ink())
                            .text_color(Tokens::page())
                            .hover(|s| s.opacity(0.85))
                    })
                    .when(!is_approve, |d| {
                        d.text_color(Tokens::ink_2())
                            .shadow(shadow_hairline())
                            .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _window, cx| {
                            this.answer_approval(id.clone(), cx);
                        }),
                    )
                    .child(opt.label.clone()),
            );
        }

        div()
            .w_full()
            .flex()
            .justify_center()
            .px_5()
            .py(px(6.))
            .child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .flex()
                    .flex_col()
                    .gap_2()
                    .rounded(Radius::card())
                    .bg(Tokens::orange_tint())
                    .shadow(shadow_hairline())
                    .p_3()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(FontSize::base())
                            .text_color(Tokens::orange())
                            .child(Icon::new(IconName::TriangleAlert).size(px(13.)))
                            .child(req.title.clone()),
                    )
                    .when(!req.detail.is_empty(), |d| {
                        d.child(
                            div()
                                .rounded(Radius::chip())
                                .bg(Tokens::inset())
                                .p_2()
                                .font_family(FONT_MONO)
                                .text_size(FontSize::tiny())
                                .text_color(Tokens::ink_2())
                                // 参数可能很长（写文件的内容），截断
                                .child(req.detail.chars().take(600).collect::<String>()),
                        )
                    })
                    .child(buttons),
            )
    }

    /// composer 左下角那行工具状态。
    fn render_tools_hint(&self) -> impl IntoElement {
        let (icon, text, color) = match &self.tools_status {
            ToolsStatus::Loading => (
                IconName::Loader,
                "正在连接工具…".to_string(),
                Tokens::ink_3(),
            ),
            // 没配工具是正常状态，不该显示成缺了什么 —— 什么都不说最好
            ToolsStatus::Ready { tool_names } if tool_names.is_empty() => {
                return div().into_any_element();
            }
            ToolsStatus::Ready { tool_names } => (
                IconName::SquareTerminal,
                format!("{} 个工具可用", tool_names.len()),
                Tokens::ink_3(),
            ),
            ToolsStatus::Failed(err) => (
                IconName::TriangleAlert,
                // 截断：错误可能很长（含子进程的 stderr），composer 一行放不下。
                // 完整信息在设置的工具页。
                format!("工具连接失败：{}", err.chars().take(60).collect::<String>()),
                Tokens::orange(),
            ),
        };
        div()
            .flex()
            .items_center()
            .gap(px(5.))
            .min_w_0()
            .text_size(FontSize::xxs())
            .font_weight(FontWeight::NORMAL)
            .text_color(color)
            .child(Icon::new(icon).size(px(11.)))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(text),
            )
            .into_any_element()
    }
}

/// 按 turn 分组，保留组间的首次出现顺序。
///
/// tools 是按调用顺序 push 进去的，所以「首次出现顺序」就是轮次顺序。
/// 对应 Electron 版 MessageBubble 的 groupByTurn。
fn group_by_turn(tools: &[ToolTrace]) -> Vec<Vec<&ToolTrace>> {
    let mut order: Vec<u32> = Vec::new();
    for t in tools {
        if !order.contains(&t.turn) {
            order.push(t.turn);
        }
    }
    order
        .into_iter()
        .map(|turn| tools.iter().filter(|t| t.turn == turn).collect())
        .collect()
}
