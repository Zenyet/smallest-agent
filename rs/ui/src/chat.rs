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
use smallest_agent_core::types::{Config, Message, ToolRegistry};
use smallest_agent_core::vendors;

use crate::assets::{FONT_MONO, FONT_SANS};
use crate::bridge::{self, AgentEvent, EventRx};
use crate::pages::{self, PagesState};
use crate::pane::Pane;
use crate::picker;
use crate::projects::{self, ProjectsState};
use crate::providers::{self, BUILTIN_ID, ProvidersState, Registry};
use crate::session_titles::{self, Titles};
use crate::settings::{SettingsForm, render_settings};
use crate::sidebar::{SidebarCallbacks, SidebarProps, render_sidebar};
use crate::theme::{FontSize, Radius, Tokens, markdown_style};
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

/// 对话区的内容栏最大宽度。
///
/// 气泡在这条栏里左右对齐 —— 不设上限的话宽窗口下气泡会拉到一米宽，
/// 「靠右」和「靠左」的对比也就没了意义（两边都贴着窗口边）。
const CONTENT_MAX_WIDTH: f32 = 860.;

/// 用户气泡的最大宽度（占内容栏的比例）。
///
/// 用户消息通常是短问句，76% 够用，留出的左侧空白让「这是我说的」一目了然。
const USER_BUBBLE_MAX: f32 = 0.76;

/// 助手气泡的最大宽度。
///
/// **比用户气泡宽**，这个不对称是有意的：助手输出常含代码块、表格、列表，
/// 它们在 76% 宽里会被挤压（横向滚动条、表格折行）。88% 让它们能舒展，
/// 同时右侧仍留一道空白维持「靠左」的视觉。
///
/// 这是「气泡布局」和「代码可读性」之间的折中 —— 纯居中定宽栏对长文更好，
/// 但气泡的角色区分更直观，多数人更习惯。
const ASSISTANT_BUBBLE_MAX: f32 = 0.88;

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

/// 切换当前会话的模型（只对外部 CLI 有意义）。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct SetModel {
    pub model_id: String,
}

/// 放弃重命名。绑在 Esc 上。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct CancelRename;

/// 开始重命名一个会话。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct RenameSession {
    pub session_id: String,
}

/// 切换当前会话的 provider。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct SetProvider {
    pub provider_id: String,
}

/// 换当前会话的权限模式。composer 上那个选择器派发它。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct SetPermission {
    pub mode_id: String,
}

/// 启用/停用一个技能。
///
/// 走 action 而不是回调：设置页是泛型的（`render_settings<T>`），
/// 拿不到 `&mut ChatView`，而技能开关要改 SettingsForm 的状态。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct ToggleSkill {
    pub name: String,
}

/// 给当前会话绑一个自定义 agent。空串 = 不用。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct SetSessionAgent {
    pub agent_id: String,
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
    /// 发出 / 收到的时间（unix 毫秒）。0 = 不知道。
    ///
    /// 0 是历史消息的正常值：时间戳存在旁挂文件里（见 msg_times.rs），
    /// 而这个功能之前存的会话没有那份记录。显示时会退化成不显示时间，
    /// 不是错误。
    pub at: u64,
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
    pub(crate) fn failed(&self) -> bool {
        self.output.trim_start().starts_with("{\"error\"")
    }

    /// 这次调用是被**用户拒绝**的，不是工具自己挂了。
    ///
    /// 两者在 output 里都是 `{"error":...}`，但语义完全不同：
    /// 一个是「我不让它做」，一个是「它做了但失败了」。回看历史时
    /// 分不清这两个，就说不出当时到底发生了什么。
    /// core 在拒绝时额外加了 `"denied": true`，见 agent.rs 那段注释。
    pub(crate) fn denied(&self) -> bool {
        // 用子串而不是解析 JSON：这个函数在 render 里每帧对每条工具调用
        // 都会跑，解析一遍 JSON 太贵。这个键是我们自己写进去的，
        // 形状固定（serde_json 对 bool 不会加空格），所以子串是可靠的
        self.output.contains("\"denied\":true")
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
    /// 正在内联编辑哪一条消息，以及它的输入框。
    ///
    /// 内联而不是把内容塞回底部 composer：后者是我第一版的做法，
    /// 而所有主流客户端（ChatGPT、Claude）都是**气泡原地变成输入框**，
    /// 下面配「取消 / 发送」两个按钮。塞回 composer 的问题是用户会
    /// 失去「我在改哪一条」的位置感 —— 尤其历史很长、那条已经滚出视口时。
    pub editing: Option<(usize, Entity<TextareaState>)>,
    /// 刚复制过哪一条（下标）+ 复制的时刻。
    ///
    /// 用来把复制图标临时换成对勾。存时刻而不是布尔：不然那个勾会
    /// 一直挂着，用户看不出第二次点有没有生效。
    pub copied: Option<(usize, std::time::Instant)>,
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
    /// 设置页打开时对每个输入框的订阅。
    ///
    /// 必须存着 —— Subscription 是 RAII 的，drop 了订阅就断，
    /// 那样改设置不会触发保存。关设置时连同表单一起清掉。
    settings_subs: Vec<Subscription>,
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

    /// provider 注册表。按 id 建实例并缓存，见 providers.rs。
    ///
    /// 注：config / compact / approver 都在它里面了 —— ChatView 不再单独存，
    /// 存两份的话「改了配置该更新谁」会变成一个要记住的规则。
    registry: Registry,
    /// 哪个会话用哪个 provider。真相在磁盘上的 providers.json。
    providers_state: ProvidersState,
    /// 内容区显示哪个页面。见 pane.rs。
    ///
    /// 和 settings 那个 Option 并存而不是取代它：Pane 说「显示哪个」，
    /// settings 存的是设置页的表单状态。合成一个的话切走再切回来
    /// 输入框内容就丢了。
    pane: Pane,
    /// Agent 和自动化两个页面的状态（含正在编辑的那一项）。
    pages: PagesState,
    /// 模型选择器要显示的东西：内置九家 + 配好的自定义端点。
    ///
    /// ## 为什么要缓存
    ///
    /// 自定义端点的地址和模型清单存在 settings.json 里，所以「有哪些模型
    /// 可选」这个问题的答案要读盘才知道。而问这个问题的地方是
    /// **每帧都在渲染的** composer 选择器 —— 在 render 里读盘等于 60 次
    /// 文件读 + JSON 解析每秒，正是上一轮在查的那类掉帧。
    ///
    /// 代价是要自己让它失效：设置里改了 CUSTOM_* 之后必须重建，否则用户
    /// 填了模型却在选择器里看不到。失效点只有一个 —— 设置输入框的 Change
    /// 订阅（见 open_settings_at）。
    model_catalog: Vec<vendors::VendorEntry>,
    /// 用户改过的会话标题。没有记录的会话用自动推导的标题。
    titles: Titles,
    /// 每条消息的时间戳，按会话。见 msg_times.rs 为什么不存在会话文件里。
    msg_times: crate::msg_times::MsgTimes,
    /// 正在重命名哪个会话。None = 没在重命名。
    ///
    /// 存 (session_id, 输入框) 两半：id 用来知道改的是谁，
    /// 输入框是那一行临时变成的编辑态。
    renaming: Option<(String, Entity<TextareaState>)>,
    /// 重命名输入框的订阅。必须存着 —— Subscription 是 RAII 的。
    rename_sub: Option<Subscription>,
    /// 内联编辑框的订阅（回车发送）。同上，必须存着。
    edit_sub: Option<Subscription>,
    tools: ToolRegistry,
    store: Arc<dyn SessionStore>,
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
        // 技能工具（list_skills / read_skill）从一开始就装上 ——
        // 它们不依赖任何连接，而 MCP 工具是后台异步连的。
        // 不这样做的话开局那几秒模型看不到技能。
        let tools = base_tools();
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

        let providers_state = providers::load_state();
        let registry = Registry::new(
            config.clone(),
            tools.clone(),
            compact.clone(),
            approver.clone(),
        );

        let mut this = Self {
            input,
            chats: HashMap::new(),
            sessions: Vec::new(),
            projects: projects::load_projects(),
            tools_status: ToolsStatus::Loading,
            settings: None,
            settings_subs: Vec::new(),
            current_project_id: None,
            scroll: ScrollHandle::new(),
            last_len: 0,
            // 开局先用配置里的 session_id，load_sessions 拿到列表后会切到最近那个
            current_id: config.session_id.clone(),
            registry,
            providers_state,
            pane: Pane::default(),
            pages: PagesState::load(),
            model_catalog: Self::load_model_catalog(),
            titles: session_titles::load(),
            msg_times: crate::msg_times::load(),
            renaming: None,
            rename_sub: None,
            edit_sub: None,
            tools,
            store,
            tx,
            rx,
            _subscriptions: subscriptions,
        };
        this.start_event_loop(cx);
        this.start_automation_tick(cx);
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
                    // 没配 MCP 也不是「没有工具」—— 技能那两个一直都在
                    let mut names: Vec<String> = this.tools.keys().cloned().collect();
                    names.sort();
                    this.tools_status = ToolsStatus::Ready { tool_names: names };
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
                        // 合并而不是覆盖：整体赋值会把开局装的技能工具冲掉
                        let mut tools = base_tools();
                        tools.extend(mcp.tools.clone());
                        let mut names: Vec<String> = tools.keys().cloned().collect();
                        names.sort();
                        this.tools = tools;
                        this.tools_status = ToolsStatus::Ready { tool_names: names };
                        // 让连接活到进程结束，见函数注释
                        Box::leak(Box::new(mcp));
                        // 工具变了要让注册表重建内置实例：内置 provider 把
                        // 注册表烤进了 HTTP 请求体构造里，不重建模型看不到新工具。
                        //
                        // 外部 CLI 不受影响（它们自己管工具），所以注册表只丢
                        // 内置那个缓存。
                        this.registry.set_tools(this.tools.clone());
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

    /// 定时检查有没有到点的自动化。
    ///
    /// ## 为什么是轮询而不是给每条自动化排一个定时器
    ///
    /// 每条一个定时器要在「改间隔」「启用/停用」「删除」时各自取消重排，
    /// 而漏掉任何一处就会留下一个幽灵定时器（指向已删的自动化）。
    /// 一个统一的 tick 只有一份状态，条件全在 is_due 里。
    ///
    /// 代价是触发时间最多晚 TICK 那么久 —— 对「每小时看一眼」这类用途无所谓，
    /// 而这正是自动化的实际用途（见 automations.rs 关于间隔而非 cron 的说明）。
    ///
    /// **app 关着的时候不会触发**，这是设计的一部分而不是缺陷：
    /// 桌面应用不是常驻服务，补跑语义（catch-up）会让「每分钟一次」在
    /// 关了一天之后一次性炸出一千轮。间隔语义天然没有这个问题。
    fn start_automation_tick(&mut self, cx: &mut Context<Self>) {
        /// 检查周期。
        ///
        /// 30 秒而不是每分钟：最短间隔是 1 分钟（MIN_INTERVAL_MINUTES），
        /// 按采样定理要比它密才不会漏掉一整个周期。
        /// 检查本身极便宜（比几个整数），30 秒一次的开销测不出来。
        const TICK: std::time::Duration = std::time::Duration::from_secs(30);

        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                // update_in 而不是 update：run_automation 要设输入框的值，
                // 那需要一个 &mut Window。用 update 拿不到，只能绕 defer，
                // 而 defer 又要一个已有的 window 引用 —— 循环依赖。
                let alive = this
                    .update_in(cx, |this, window, cx| {
                        this.fire_due_automations(window, cx);
                    })
                    .is_ok();
                if !alive {
                    // 实体已销毁（窗口关了）
                    break;
                }
            }
        })
        .detach();
    }

    /// 跑所有到点的自动化。
    ///
    /// **一次只跑一条**：run_automation 会切当前会话并占用输入框，
    /// 连着跑第二条会把第一条刚填进去的提示词冲掉。剩下的那些下个 tick 再来 ——
    /// 它们的 is_due 仍然为真，不会丢。
    fn fire_due_automations(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = smallest_agent_core::automations::now_millis();
        let Some(id) = self
            .pages
            .automations
            .due(now)
            .first()
            .map(|a| a.id.clone())
        else {
            return;
        };
        // 有会话正在跑就等下一轮 —— 抢输入框会打断用户正在打的字
        if self.chats.values().any(|c| c.running) {
            return;
        }
        // 用户正在打字也不抢。自动化晚半分钟无所谓，
        // 而把人家写了一半的问题冲掉是不可接受的。
        if !self.input.read(cx).value().trim().is_empty() {
            return;
        }
        self.run_automation(&id, window, cx);
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
                this.adopt_unbound_sessions(&list);
                this.sessions = list;
                if let Some(id) = first {
                    // 打开的会话属于哪个项目，就把那个项目也标成选中的 ——
                    // 否则用户接着点「新对话」会莫名落到「未分组」，
                    // 而他眼里明明正在某个项目里干活。
                    this.current_project_id = this.projects.session_project.get(&id).cloned();
                    this.current_id = id.clone();
                    let times = this.msg_times.get(&id).cloned().unwrap_or_default();
                    this.chats.insert(id, Self::hydrate(&history, &times));
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// 收养磁盘上还没绑引擎的会话，一律归给内置 agent。
    ///
    /// 这是一次性的迁移路径。「每个会话绑死一个引擎」之前，走内置 agent 的
    /// 会话是**不存绑定记录**的（内置被当成默认值省掉了），所以老会话在
    /// providers.json 里全都没有条目。
    ///
    /// 不收养的话它们仍然落在 default_provider 上 —— 用户切一次外部 CLI，
    /// 全部老会话会静默跟着换引擎。归给内置是安全的判断：磁盘上有历史说明
    /// 它被存过盘，而那时候只有内置 provider 会存盘。
    fn adopt_unbound_sessions(&mut self, list: &[SessionMeta]) {
        let mut changed = false;
        for s in list {
            changed |= self.providers_state.bind_if_unbound(&s.id, BUILTIN_ID);
        }
        if changed
            && let Err(err) = providers::save_state(&self.providers_state)
        {
            eprintln!("[providers] 保存失败：{err:#}");
        }
    }

    /// 把磁盘上的历史消息铺成界面消息。实现在 history.rs（那边有测试）。
    fn hydrate(history: &[Message], times: &[u64]) -> SessionChat {
        crate::history::hydrate(history, times)
    }

    /// 把当前会话的时间戳补齐到界面消息数，缺的填现在。
    ///
    /// 见调用点的注释：这是个近似 —— 同一轮的消息共享一个时间戳。
    fn record_times_for_current(&mut self) {
        let id = self.current_id.clone();
        let n = self.chats.get(&id).map(|c| c.messages.len()).unwrap_or(0);
        let now = crate::msg_times::now_ms();
        let v = self.msg_times.entry(id).or_default();
        // 只往后补，不改已有的 —— 已经记下的时间不该因为又答了一轮而变
        while v.len() < n {
            v.push(now);
        }
        if let Err(err) = crate::msg_times::save(&self.msg_times) {
            eprintln!("[msg_times] 保存失败：{err:#}");
        }
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
                        at: crate::msg_times::now_ms(),
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
                        at: crate::msg_times::now_ms(),
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
                        at: crate::msg_times::now_ms(),
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
                        at: crate::msg_times::now_ms(),
                    }),
                    _ => {}
                }
                // 记这一轮的时间戳。
                //
                // ## 为什么在这里、按磁盘消息数对齐
                //
                // 时间戳数组的下标要对应**磁盘上**的消息下标（hydrate 那边
                // 就是这么读的），而界面的 DisplayMessage 数组和磁盘不是
                // 一一对应 —— 磁盘上工具调用是独立消息，界面上它们被合并
                // 进了气泡。所以不能拿界面的下标去存。
                //
                // 这一轮刚答完，磁盘上的消息数 = 上一次的数量 + 这一轮新增。
                // 我们不知道新增了几条（那在 core 那侧），所以策略是：
                // **补齐到当前长度，缺的填这一刻的时间**。
                // 结果是同一轮里的几条消息共享一个时间戳 —— 对「显示发送/
                // 回复时间」这个用途足够（一轮通常几秒内完成），
                // 而要精确到每条就得改 core 的 OnComplete 签名。
                self.record_times_for_current();
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
                let times = this.msg_times.get(&id).cloned().unwrap_or_default();
                    this.chats.insert(id, Self::hydrate(&history, &times));
                cx.notify();
            });
        })
        .detach();
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let provider_id = self.providers_state.provider_for("").to_string();
        self.create_with_provider(&provider_id, cx);
    }

    /// 新建一个会话并把它钉在某个引擎上。
    ///
    /// 引擎在**创建时**就定下来，而不是等第一次发送。理由是选择器要显示
    /// 「这个会话会用谁」，而不显示一个可能被别处改掉的默认值。
    fn create_with_provider(&mut self, provider_id: &str, cx: &mut Context<Self>) {
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
        self.providers_state.assign(&id, provider_id);
        if let Err(err) = providers::save_state(&self.providers_state) {
            eprintln!("[providers] 保存失败：{err:#}");
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
        // provider 绑定同理 —— 会话没了绑定就是垃圾数据
        self.providers_state.forget(&id);
        let _ = providers::save_state(&self.providers_state);
        session_titles::forget(&mut self.titles, &id);
        let _ = session_titles::save(&self.titles);
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
                at: crate::msg_times::now_ms(),
                cache_hit: false,
            });
            chat.running = true;
        }
        // 发出去就记时间，不等这一轮答完 —— 中途关掉 app 的话，
        // 至少这条提问的时间是在的
        self.record_times_for_current();
        cx.notify();

        let store = self.store.clone();
        let tx = self.tx.clone();
        // 按当前会话取 provider。
        //
        // on_complete 要带会话 id，所以内置 provider 每轮重建一次
        // （注册表内部处理，见 providers.rs 的 get）。
        let provider_id = self.providers_state.provider_for(&session_id).to_string();
        let cwd = self.project_dir_for(&session_id);
        // 存盘钩子每轮建一个（它绑着会话 id），随请求一起下去 ——
        // 不能挂在 provider 实例上，那个实例是跨会话共用的。
        let on_complete: Arc<dyn OnComplete> =
            Arc::new(SaveSessionHook::new(store.clone(), session_id.clone()));

        // 第一次为这个会话说话就把引擎钉死。
        //
        // 不钉的后果：这个会话没有绑定，于是每轮都落到 default_provider 上，
        // 而用户在别的会话里切一次引擎就会改掉那个默认值 —— 这个会话会在
        // 用户没碰它的情况下换引擎。见 ProvidersState::assign 的注释。
        if self
            .providers_state
            .bind_if_unbound(&session_id, &provider_id)
        {
            let _ = providers::save_state(&self.providers_state);
        }

        let builtin_sel = self.providers_state.builtin_selection(&session_id);
        // 这个会话绑的自定义 agent（如果有）。它决定系统提示、可用工具，
        // 也可能覆盖模型。
        let agent = self.pages.agents.for_session(&session_id).cloned();
        let provider = match self.registry.get(
            &provider_id,
            &self.providers_state,
            providers::SessionContext {
                cwd,
                model_id: self.providers_state.model_for(&session_id),
                builtin: &builtin_sel,
                agent: agent.as_ref(),
                permission: self.providers_state.permission_for(&session_id),
            },
        ) {
            Ok(p) => p,
            Err(err) => {
                let chat = self.current();
                chat.running = false;
                chat.cancel = None;
                // 内置 agent 最常见的失败是「这家厂商还没填 key」，而那条
                // 错误自己已经说清楚了（哪家 + 去哪领）。再套一层
                // 「provider builtin 建不起来」只会把它推到一行之外。
                chat.error = Some(if provider_id == BUILTIN_ID {
                    format!("{err:#}")
                } else {
                    format!("provider「{provider_id}」建不起来：{err:#}")
                });
                cx.notify();
                return;
            }
        };

        cx.spawn(async move |_this, _cx| {
            let history = store.load(&session_id).await.unwrap_or_default();
            bridge::spawn_agent_turn(
                provider,
                session_id,
                question,
                history,
                on_complete,
                cancel,
                tx,
            );
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
        self.open_settings_at(None, window, cx);
    }

    /// 打开设置，可以直接落在某一页。
    ///
    /// 侧边栏的「工具」「技能」两行用它 —— 那两行是**直达入口**：
    /// 让用户点「技能」之后还要在设置里再找一次那一页，等于这个入口没起作用。
    ///
    /// 已经开着设置时只切页，不重建表单：重建会丢掉输入框里没写完的东西
    /// （虽然是实时保存的，但光标位置和滚动位置也会丢）。
    fn open_settings_at(
        &mut self,
        section: Option<crate::settings::SettingsSection>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pane = Pane::Settings;
        if let Some(form) = &mut self.settings {
            if let Some(s) = section {
                form.section = s;
            }
            cx.notify();
            return;
        }

        {
            let mut form = SettingsForm::new(window, cx);
            if let Some(s) = section {
                form.section = s;
            }

            // 订阅每个输入框：改一个字就写盘。
            //
            // 没做 debounce：写的是个几百字节的 JSON，一次 write 在
            // SSD 上是微秒级。加 debounce 要引一个定时器 + 一份待写状态，
            // 复杂度换来的收益在这个体量下测不出来。
            //
            // 代价是逐字符写盘 —— 用户打一个 20 字的 API key 会写 20 次。
            // 如果以后配置涨到几十 KB 再改成 debounce。
            self.settings_subs = form
                .inputs
                .values()
                .map(|input| {
                    cx.subscribe_in(input, window, |this, _, ev: &InputEvent, _window, cx| {
                        if matches!(ev, InputEvent::Change)
                            && let Some(f) = this.settings.as_mut()
                        {
                            f.save(cx);
                            // 改的可能是自定义端点的模型清单 —— 那会改变
                            // 「有哪些模型可选」，而那份答案是缓存的。
                            // 不重建的话用户填完模型在选择器里看不到它。
                            this.model_catalog = Self::load_model_catalog();
                            cx.notify();
                        }
                    })
                })
                .collect();
            // 工具状态的真相在 self.tools_status 上，这里灌一份快照给表单显示。
            // 不让表单自己去读配置：那样会显示「配置里写了什么」而不是
            // 「实际连上了什么」，两者在 server 启动失败时不一致 ——
            // 而那正是用户来这一页要查的情况。
            let (line, names) = self.tools_summary();
            form.tools_status_line = line;
            form.tool_names = names;
            form.provider_options = self.providers_state.options();
            form.active_provider = self
                .providers_state
                .provider_for(&self.current_id)
                .to_string();
            self.settings = Some(form);
        }
        cx.notify();
    }

    fn close_settings(&mut self, cx: &mut Context<Self>) {
        // 丢掉表单状态而不是留着：下次打开该重新读磁盘上的值，
        // 否则用户改了没保存、关掉再打开还能看到脏数据，
        // 会以为已经保存了。
        self.settings = None;
        // 订阅跟着清掉 —— 留着会指向已经没人看的表单
        self.settings_subs.clear();
        self.pane = Pane::Chat;
        cx.notify();
    }

    /// 切到某个独立页面（工具 / 技能 / Agent / 自动化）。
    ///
    /// 再点一次同一个回到对话 —— 这四行是**切换**而不是单向跳转，
    /// 否则用户点开「技能」之后没有明显的出口（那四个页面里没有返回按钮，
    /// 因为侧边栏还在，会话列表就是出口）。
    fn open_page(&mut self, pane: Pane, cx: &mut Context<Self>) {
        // 从设置切过来要把表单收掉，理由同 close_settings
        if self.pane == Pane::Settings {
            self.settings = None;
            self.settings_subs.clear();
        }
        self.pane = if self.pane == pane { Pane::Chat } else { pane };
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

    /// 开始重命名。
    fn start_rename(&mut self, session_id: String, window: &mut Window, cx: &mut Context<Self>) {
        // 预填当前标题，用户通常是微调而不是重打
        let current = self.title_for(&session_id);
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .default_value(current)
                .submit_on_enter(true)
        });
        // 立刻聚焦，用户不用再点一次输入框。
        //
        // 没做全选（TextareaState 上没有 select_all）—— 光标会落在末尾，
        // 用户想覆盖旧名字得自己 ⌘A。这是个小遗憾，但比让他先点一下输入框好。
        input.update(cx, |st, cx| st.focus(window, cx));

        // 回车提交、失焦提交、Esc 取消。
        //
        // 失焦也提交（而不是取消）是因为「点到别处」通常意味着「我改完了」，
        // 而不是「我不改了」—— 后者用 Esc。Finder 重命名文件也是这个行为。
        self.rename_sub = Some(cx.subscribe_in(
            &input,
            window,
            |this, _, ev: &InputEvent, _window, cx| match ev {
                InputEvent::PressEnter { .. } | InputEvent::Blur => this.commit_rename(cx),
                _ => {}
            },
        ));
        self.renaming = Some((session_id, input));
        cx.notify();
    }

    /// 提交重命名。
    fn commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some((session_id, input)) = self.renaming.take() else {
            return;
        };
        // 订阅跟着清 —— 留着它会在下一次 blur 时再触发一次 commit
        self.rename_sub = None;
        let raw = input.read(cx).value().to_string();
        // 空输入 = 恢复自动推导的标题，不是存一个空名字
        session_titles::set(
            &mut self.titles,
            &session_id,
            session_titles::normalize(&raw),
        );
        if let Err(err) = session_titles::save(&self.titles) {
            eprintln!("[titles] 保存失败：{err:#}");
        }
        cx.notify();
    }

    /// 放弃重命名。
    fn cancel_rename(&mut self, cx: &mut Context<Self>) {
        self.renaming = None;
        self.rename_sub = None;
        cx.notify();
    }

    /// 一个会话该显示什么标题。
    ///
    /// 用户设过就用他的，否则用列表里那个自动推导的。
    fn title_for(&self, session_id: &str) -> String {
        if let Some(t) = self.titles.get(session_id) {
            return t.clone();
        }
        self.sessions
            .iter()
            .find(|s| s.id == session_id)
            .map(|s| s.title.clone())
            .unwrap_or_else(|| "新会话".to_string())
    }

    /// 某个会话所属项目的目录，给外部 CLI 当 cwd。
    ///
    /// 这是「项目」这个概念在两种 provider 之间的接缝：内置 agent 的项目
    /// 只是会话分组（目录只用来显示名字），而外部 CLI 的 cwd 决定它能
    /// 看到哪些文件。让它们对齐 —— 用户在项目 X 下开的会话，CLI 就在 X 里干活。
    ///
    /// 会话不属于任何项目时返回 None，注册表会退回启动目录。
    fn project_dir_for(&self, session_id: &str) -> Option<std::path::PathBuf> {
        let pid = self.providers_state.session_provider.get(session_id);
        let _ = pid;
        self.projects
            .session_project
            .get(session_id)
            .and_then(|pid| self.projects.projects.iter().find(|p| &p.id == pid))
            .map(|p| std::path::PathBuf::from(&p.dir))
    }

    /// 给当前会话换模型。
    fn set_model(&mut self, model_id: String, cx: &mut Context<Self>) {
        let session_id = self.current_id.clone();
        self.providers_state
            .assign_model(&session_id, Some(&model_id));
        if let Err(err) = providers::save_state(&self.providers_state) {
            eprintln!("[providers] 保存失败：{err:#}");
        }
        cx.notify();
    }

    /// 读一次设置，算出模型选择器该显示什么。
    ///
    /// 见 `model_catalog` 字段的注释：这是个**快照**。放在这儿而不是
    /// vendors 里，是因为「从哪儿读设置」是 UI 这一侧的知识
    /// （core 那边不知道 settings.json 在哪）。
    fn load_model_catalog() -> Vec<vendors::VendorEntry> {
        let settings = crate::settings::load_settings();
        vendors::catalog(&|k| settings.get(k).cloned())
    }

    /// 给当前会话换内置 agent 的厂商 + 模型。
    ///
    /// `value` 的形状是 `厂商id/模型id`，由选择器的选项 id 给出。
    ///
    /// **不像换 provider 那样开新会话**：换厂商换的是「谁来生成下一条回复」，
    /// 而历史仍然是我们自己存的那一份，完整、格式统一，换个模型接着聊是
    /// 成立的（模型看到的是同一段对话）。换 provider 不成立是因为那会跨过
    /// 「谁维护上下文」这条线，见 set_provider 的注释。
    fn set_builtin_model(&mut self, value: &str, cx: &mut Context<Self>) {
        let Some((vendor_id, model)) = value.split_once('/') else {
            // 选项 id 是我们自己拼的，切不开说明有 bug —— 记一行别静默
            eprintln!("[providers] 模型选项格式不对：{value}");
            return;
        };
        let sel = vendors::Selection {
            vendor_id: vendor_id.to_string(),
            model: model.to_string(),
        };
        let session_id = self.current_id.clone();
        self.providers_state.assign_builtin_model(&session_id, &sel);
        if let Err(err) = providers::save_state(&self.providers_state) {
            eprintln!("[providers] 保存失败：{err:#}");
        }
        // 换厂商就得换 key 和 base_url。那些在每轮建内置实例时才读，
        // 所以这里不用手动让什么失效 —— 见 Registry::get。
        cx.notify();
    }

    /// 复制一条消息的正文。
    fn copy_message(&mut self, idx: usize, cx: &mut Context<Self>) {
        let Some(m) = self.current().messages.get(idx) else {
            return;
        };
        // 复制的是**正文**，不含工具轨迹 —— 用户点复制想要的是那段回答，
        // 而不是一堆 JSON。要看工具细节可以展开那个面板。
        let text = m.text.clone();
        if text.is_empty() {
            return;
        }
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        self.current().copied = Some((idx, std::time::Instant::now()));

        // 2 秒后重绘一次，让对勾变回复制图标。
        //
        // 必须显式安排这一次重绘：判断「是不是刚复制过」用的是
        // `elapsed() < 2s`，而 gpui 只在有事件时重绘 —— 光靠时间流逝
        // 不会触发。不加这个的话，那个勾会一直挂着直到用户碰别的东西。
        cx.spawn(async move |this, cx| {
            smallest_agent_core::runtime::sleep(std::time::Duration::from_millis(2100)).await;
            let _ = this.update(cx, |_this, cx| cx.notify());
        })
        .detach();
        cx.notify();
    }

    /// 开始内联编辑一条用户消息：气泡原地变成输入框。
    ///
    /// ## 为什么不塞回底部的 composer（第一版就是那样，是错的）
    ///
    /// 所有主流客户端（ChatGPT、Claude）都是气泡**原地**变输入框，
    /// 下面配「取消 / 发送」。塞回 composer 的问题是用户失去「我在改哪一条」
    /// 的位置感 —— 尤其历史很长、那条已经滚出视口的时候，
    /// 内容突然出现在底部输入框里，看着像凭空多了一段草稿。
    fn begin_edit(&mut self, idx: usize, window: &mut Window, cx: &mut Context<Self>) {
        // 正在跑的时候不许编辑：那一轮还在往 messages 里写，
        // 之后的截断会和它打架
        if self.current().running {
            return;
        }
        let Some(m) = self.current().messages.get(idx) else {
            return;
        };
        if m.role != Role::User {
            return;
        }
        let text = m.text.clone();
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .default_value(&text)
                .submit_on_enter(true)
                // min 2 行保持和短消息气泡大小差不多；上限 6 行
                // 不用 COMPOSER_MAX_ROWS(10)，那会让长消息编辑框顶得很高
                .auto_grow(2, 6)
        });
        // 回车发送。Subscription 是 RAII 的，必须存着 ——
        // 不存的话它立刻 drop，回车就没反应了（rename 那边同样的坑）
        self.edit_sub = Some(cx.subscribe_in(
            &input,
            window,
            |this, _, ev: &InputEvent, window, cx| {
                if matches!(ev, InputEvent::PressEnter { .. }) {
                    this.submit_edit(window, cx);
                }
            },
        ));
        self.current().editing = Some((idx, input));
        cx.notify();
    }

    /// 放弃编辑，气泡变回原样。
    fn cancel_edit(&mut self, cx: &mut Context<Self>) {
        self.current().editing = None;
        self.edit_sub = None;
        cx.notify();
    }

    /// 提交编辑：砍掉这条及之后的历史，用新内容重新提问。
    ///
    /// ## 为什么要砍历史
    ///
    /// 编辑重发的语义是「从这里重新开始」。不砍的话，模型下一轮会看到
    /// 「旧问题 + 旧答案 + 新问题」，而旧答案回答的是一个已经被改掉的问题。
    ///
    /// ## 磁盘上的历史也要砍
    ///
    /// 只改界面不改磁盘的话，重开 app 之后被砍掉的那几条会**回来** ——
    /// 而且下一轮对话仍然会带着它们（core 从磁盘读历史）。
    fn submit_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((idx, input)) = self.current().editing.take() else {
            return;
        };
        self.edit_sub = None;
        let text = input.read(cx).value().trim().to_string();
        if text.is_empty() {
            // 清空了就当取消 —— 发一条空消息没有意义
            cx.notify();
            return;
        }

        // 界面：砍到这一条之前（这一条本身也砍掉，下面 send 会重新加）
        self.current().messages.truncate(idx);
        // 时间戳数组跟着砍 —— 不砍的话下标会错位，后面新消息拿到的是
        // 被删消息的时间（见 msg_times.rs 那段「下标对应会不会错位」）
        let id = self.current_id.clone();
        if let Some(v) = self.msg_times.get_mut(&id) {
            v.truncate(idx);
        }
        let _ = crate::msg_times::save(&self.msg_times);

        // 磁盘：把截断后的历史写回去。
        //
        // 这里有个形状不匹配要处理：界面的下标和磁盘的下标不是一一对应
        // （磁盘上工具调用是独立消息）。所以不能直接 truncate 磁盘数组，
        // 得按「第几条 user 消息」重新定位。
        let store = self.store.clone();
        let sid = id.clone();
        let nth_user = self
            .current()
            .messages
            .iter()
            .filter(|m| m.role == Role::User)
            .count();
        cx.spawn(async move |_this, _cx| {
            let Ok(history) = store.load(&sid).await else {
                return;
            };
            let mut seen = 0usize;
            let mut cut = history.len();
            for (i, m) in history.iter().enumerate() {
                if matches!(m, Message::User { .. }) {
                    if seen == nth_user {
                        cut = i;
                        break;
                    }
                    seen += 1;
                }
            }
            let truncated: Vec<Message> = history.into_iter().take(cut).collect();
            let _ = store.save(&sid, &truncated).await;
        })
        .detach();

        // 把新内容放进 composer 再走正常的发送路径。
        //
        // 复用 send() 而不是自己拼一遍：那条路上有一堆必须做的事
        // （绑定 provider、建取消令牌、记时间戳、启动 agent），
        // 抄一份必然漏掉其中一两件。
        self.input.update(cx, |st, cx| st.set_value(&text, window, cx));
        self.send(window, cx);
    }

    /// 换当前会话的权限模式。    /// 换当前会话的权限模式。
    fn set_permission(&mut self, mode_id: &str, cx: &mut Context<Self>) {
        let mode = crate::providers::PermissionMode::from_id(mode_id);
        let session_id = self.current_id.clone();
        self.providers_state.assign_permission(&session_id, mode);
        if let Err(err) = providers::save_state(&self.providers_state) {
            eprintln!("[providers] 保存失败：{err:#}");
        }
        // 不用手动让什么失效：provider 每轮重建，那时才读这个模式。
        // 见 Registry::get。
        cx.notify();
    }

    // ========================================================================
    // Agent 页
    // ========================================================================

    /// 新建一个 agent 并立刻进入编辑。
    ///
    /// 建好就打开编辑器，而不是让用户在列表里再点一次「编辑」——
    /// 新建一个空白项唯一的下一步就是填它。
    fn new_agent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let def = smallest_agent_core::agents::AgentDef::new("新 Agent");
        let id = def.id.clone();
        self.pages.agents.upsert(def.clone());
        self.pages.save_agents();
        self.open_agent_editor(&def, window, cx);
        let _ = id;
        cx.notify();
    }

    /// 点「编辑」：没开就开，开着同一个就收起。
    fn edit_agent(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .pages
            .agent_editor
            .as_ref()
            .is_some_and(|e| e.id == id)
        {
            self.pages.agent_editor = None;
            self.settings_subs.clear();
            cx.notify();
            return;
        }
        let Some(def) = self.pages.agents.find(id).cloned() else {
            return;
        };
        self.open_agent_editor(&def, window, cx);
        cx.notify();
    }

    /// 建编辑器 + 订阅输入框，改一个字就落盘。
    ///
    /// 和设置页一个模式（没有保存按钮）。订阅存在 settings_subs 里 ——
    /// 那个字段名现在不太准了，但它就是「当前页面上那些输入框的订阅」，
    /// 生命周期规则一样（RAII，清掉就断，所以必须存着）。
    fn open_agent_editor(
        &mut self,
        def: &smallest_agent_core::agents::AgentDef,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let editor = pages::AgentEditor::new(def, window, cx);
        // 换页面就把上一页的订阅断掉，否则它们会指向已经没人看的输入框
        self.settings_subs.clear();
        for entity in [
            &editor.name,
            &editor.description,
            &editor.tools,
        ] {
            self.settings_subs.push(cx.subscribe(
                entity,
                |this, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.save_agent_from_editor(cx);
                    }
                },
            ));
        }
        // 系统提示是 Textarea，事件类型同上但实体类型不同，所以单独订阅
        self.settings_subs.push(cx.subscribe(
            &editor.prompt,
            |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.save_agent_from_editor(cx);
                }
            },
        ));
        self.pages.agent_editor = Some(editor);
    }

    fn save_agent_from_editor(&mut self, cx: &mut Context<Self>) {
        let Some(ed) = &self.pages.agent_editor else {
            return;
        };
        let id = ed.id.clone();
        let Some(mut def) = self.pages.agents.find(&id).cloned() else {
            return;
        };
        ed.collect_into(&mut def, cx);
        self.pages.agents.upsert(def);
        self.pages.save_agents();
        cx.notify();
    }

    // ========================================================================
    // 自动化页
    // ========================================================================

    fn new_automation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let item = smallest_agent_core::automations::Automation::new("新自动化");
        self.pages.automations.upsert(item.clone());
        self.pages.save_automations();
        self.open_automation_editor(&item, window, cx);
        cx.notify();
    }

    fn edit_automation(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .pages
            .automation_editor
            .as_ref()
            .is_some_and(|e| e.id == id)
        {
            self.pages.automation_editor = None;
            self.settings_subs.clear();
            cx.notify();
            return;
        }
        let Some(item) = self.pages.automations.find(id).cloned() else {
            return;
        };
        self.open_automation_editor(&item, window, cx);
        cx.notify();
    }

    fn open_automation_editor(
        &mut self,
        item: &smallest_agent_core::automations::Automation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let editor = pages::AutomationEditor::new(item, window, cx);
        self.settings_subs.clear();
        for entity in [&editor.name, &editor.interval] {
            self.settings_subs.push(cx.subscribe(
                entity,
                |this, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.save_automation_from_editor(cx);
                    }
                },
            ));
        }
        self.settings_subs.push(cx.subscribe(
            &editor.prompt,
            |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.save_automation_from_editor(cx);
                }
            },
        ));
        self.pages.automation_editor = Some(editor);
    }

    /// 跑一条自动化：切到它的会话，把提示词发出去。
    ///
    /// ## 为什么走 send() 而不是直接调 provider
    ///
    /// 走同一条路意味着自动化触发的那一轮和用户手敲的完全一样 ——
    /// 流式渲染、工具调用、审批卡片、存盘、错误显示全都自动有了。
    /// 绕过 send() 直接调 provider 就要把这些各自再接一遍，而漏掉任何一样
    /// （比如审批）都会让自动化在需要确认时静默卡死。
    ///
    /// 代价是它会**抢占输入框**：正在打字的内容会被覆盖。所以正在跑的时候
    /// 不触发（下面那个 running 检查），而手动「立刻跑」是用户主动点的，
    /// 他知道会发生什么。
    fn run_automation(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.pages.automations.find(id).cloned() else {
            return;
        };
        if item.prompt.trim().is_empty() {
            return;
        }

        // 会话固定一条，第一次跑的时候建。见 automations.rs 文件头。
        let session_id = if item.session_id.trim().is_empty() {
            let sid = new_session_id();
            if let Some(slot) = self.pages.automations.find_mut(id) {
                slot.session_id = sid.clone();
            }
            // 用标题标出来它是自动化的会话 —— 侧边栏里混在手动会话中间
            // 而分不出来的话，用户会奇怪「这条对话哪来的」
            let title = if item.name.trim().is_empty() {
                "自动化".to_string()
            } else {
                format!("⏱ {}", item.name)
            };
            if let Some(t) = session_titles::normalize(&title) {
                session_titles::set(&mut self.titles, &sid, Some(t));
                let _ = session_titles::save(&self.titles);
            }
            self.sessions.insert(
                0,
                SessionMeta {
                    id: sid.clone(),
                    title: "自动化".into(),
                    updated_at: u128::MAX,
                },
            );
            self.chats.insert(sid.clone(), SessionChat::default());
            sid
        } else {
            let sid = item.session_id.clone();
            // 会话桶可能不存在（重启之后还没打开过它）
            self.chats.entry(sid.clone()).or_default();
            sid
        };

        // 那个会话正在跑就跳过这次 —— 排队会让「每分钟一次」在模型慢的时候
        // 堆出一串请求，而它们都问同样的话
        if self.chats.get(&session_id).is_some_and(|c| c.running) {
            return;
        }

        // 绑上它指定的 agent（空 = 解绑），这样这一轮用的是它的系统提示
        self.pages.agents.assign(
            &session_id,
            Some(item.agent_id.as_str()).filter(|a| !a.is_empty()),
        );

        // 记时间戳并落盘。**发之前**记：发送失败也算跑过了，
        // 否则一条持续失败的自动化会每次检查都重试，把错误刷满
        if let Some(slot) = self.pages.automations.find_mut(id) {
            slot.last_run = smallest_agent_core::automations::now_millis();
        }
        self.pages.save_automations();

        // 切过去让用户看得见。不切的话「立刻跑」点下去界面毫无反应，
        // 看着像按钮坏了。
        self.pane = Pane::Chat;
        self.current_id = session_id;
        let prompt = item.prompt.clone();
        self.input
            .update(cx, |st, cx| st.set_value(prompt, window, cx));
        self.send(window, cx);
    }

    fn save_automation_from_editor(&mut self, cx: &mut Context<Self>) {
        let Some(ed) = &self.pages.automation_editor else {
            return;
        };
        let id = ed.id.clone();
        let Some(mut item) = self.pages.automations.find(&id).cloned() else {
            return;
        };
        ed.collect_into(&mut item, cx);
        self.pages.automations.upsert(item);
        self.pages.save_automations();
        cx.notify();
    }

    /// 换引擎。
    ///
    /// ## 空会话就地换，聊过的会话开新的
    ///
    /// 一段对话属于**一个**引擎，中途换掉是不成立的：
    ///
    ///   • 内置 agent 无状态，每轮把我们存的整段历史重发给模型
    ///   • 外部 CLI 自己维护上下文，我们存的那份它只在开会话时看一眼
    ///
    /// 所以就地换的结果是两边各拿着半段历史往下接 —— 内置 agent 会把
    /// CLI 那几轮当成自己说过的话，而 CLI 那侧压根没有前面内置的部分。
    /// 界面上是一段连续的对话，两个引擎眼里是两段不同的对话。
    ///
    /// 换成开一个新会话：旧的那段留在原处（还能翻、还能接着聊），
    /// 新引擎从干净的上下文开始。空会话没有这个问题，就地换。
    fn set_provider(&mut self, provider_id: String, cx: &mut Context<Self>) {
        let session_id = self.current_id.clone();
        // 顺手记成默认值：用户切了一次之后，新会话大概率也想用这个。
        //
        // 这条以前会连带改掉「没绑定」的老会话用的引擎 —— 现在不会了，
        // 每个会话创建时就绑死（见 ProvidersState::assign 的注释）。
        self.providers_state.default_provider = Some(provider_id.clone());

        let same = self.providers_state.provider_for(&session_id) == provider_id;
        let has_messages = self
            .chats
            .get(&session_id)
            .is_some_and(|c| !c.messages.is_empty());

        if same {
            let _ = providers::save_state(&self.providers_state);
            cx.notify();
            return;
        }

        if has_messages {
            // 聊过了：开一个新会话给新引擎，旧的不动。
            // create_with_provider 里会存盘。
            self.create_with_provider(&provider_id, cx);
            return;
        }

        self.providers_state.assign(&session_id, &provider_id);
        // 换 provider 要清掉模型绑定 —— 模型 id 只在它所属的 provider 里
        // 有意义（claude 的 "opus" 和 codex 的 "opus" 不是一回事）。
        // 不清的话会拿着 A 的模型 id 去 B 里找，找不到就静默用默认模型。
        self.providers_state.assign_model(&session_id, None);
        if let Err(err) = providers::save_state(&self.providers_state) {
            eprintln!("[providers] 保存失败：{err:#}");
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

/// 和**工作目录无关**的工具 —— 技能 + 网络。
///
/// 单独一个函数是因为有两个调用点（开局、MCP 连上之后重建注册表），
/// 两处必须装同一套 —— 漏一处的表现是「连上 MCP 之后工具少了几个」，
/// 而那很难想到是这里。
///
/// ## 这里装的东西决定了内置 agent 是不是一个 agent
///
/// 原来只有技能那两个（list_skills / read_skill），于是内置模式实际上
/// 就是个 chatbot：能聊，但读不了文件、上不了网、执行不了任何东西。
/// 「有 ReAct 循环」和「有能力」是两回事 —— agent.rs 那个循环一直是真的，
/// 只是没有工具可调。
///
/// ## 文件和命令工具**不在这里**
///
/// 它们的沙盒根是「这个会话所属项目的目录」，每个会话不一样，
/// 所以在 Registry::get 里按 cwd 现场装（见 providers.rs 的 fs_shell_tools）。
/// 装在这个全局注册表里的话，沙盒根就只能是一个全局值 —— 那正是上一版
/// 那个多余的 WORKSPACE_DIR 设置。
fn base_tools() -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    smallest_agent_core::skills::register(&mut tools);

    // 搜索的 key 每次重建注册表时读一次。和厂商 key 一样不缓存 ——
    // 用户填完 key 之后下一轮就该生效。
    let settings = crate::settings::load_settings();
    smallest_agent_core::tools::web::register(
        &mut tools,
        smallest_agent_core::tools::web::SearchKeys::from_settings(&|k| settings.get(k).cloned()),
    );
    tools
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
            .on_action(cx.listener(|this, action: &SetProvider, _window, cx| {
                this.set_provider(action.provider_id.clone(), cx);
            }))
            // 技能页的「停用 / 启用」按钮派发这个。
            // 走 action 是因为那个页面是泛型的，拿不到 &mut ChatView。
            //
            // **不要**再把这个包在 `if let Some(form) = &mut this.settings` 里：
            // 技能页是侧边栏直达的，没打开过设置时那个 Option 是 None，
            // 于是点了什么都不发生。见 PagesState::skills 的注释。
            .on_action(cx.listener(|this, action: &ToggleSkill, _window, cx| {
                this.pages.toggle_skill(&action.name);
                cx.notify();
            }))
            .on_action(cx.listener(|this, action: &SetPermission, _window, cx| {
                this.set_permission(&action.mode_id, cx);
            }))
            // 模型页的厂商选择器
            .on_action(cx.listener(|this, a: &crate::settings::SetActiveVendor, _window, cx| {
                if let Some(form) = &mut this.settings {
                    form.active_vendor = a.vendor_id.clone();
                    cx.notify();
                }
            }))
            // --- Agent 页 ---
            .on_action(cx.listener(|this, _: &pages::NewAgent, window, cx| {
                this.new_agent(window, cx);
            }))
            .on_action(cx.listener(|this, a: &pages::EditAgent, window, cx| {
                this.edit_agent(&a.id, window, cx);
            }))
            .on_action(cx.listener(|this, a: &pages::DeleteAgent, _window, cx| {
                this.pages.agents.remove(&a.id);
                this.pages.agent_editor = None;
                this.pages.save_agents();
                cx.notify();
            }))
            .on_action(cx.listener(|this, a: &pages::ToggleAgent, _window, cx| {
                if let Some(def) = this.pages.agents.agents.iter_mut().find(|x| x.id == a.id) {
                    def.disabled = !def.disabled;
                    this.pages.save_agents();
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, a: &pages::SetAgentModel, _window, cx| {
                if let Some(def) = this.pages.agents.agents.iter_mut().find(|x| x.id == a.id) {
                    def.model = a.model.clone();
                    this.pages.save_agents();
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, a: &SetSessionAgent, _window, cx| {
                let session_id = this.current_id.clone();
                let id = a.agent_id.clone();
                this.pages.agents.assign(
                    &session_id,
                    if id.is_empty() { None } else { Some(id.as_str()) },
                );
                this.pages.save_agents();
                cx.notify();
            }))
            // --- 自动化页 ---
            .on_action(cx.listener(|this, _: &pages::NewAutomation, window, cx| {
                this.new_automation(window, cx);
            }))
            .on_action(cx.listener(|this, a: &pages::EditAutomation, window, cx| {
                this.edit_automation(&a.id, window, cx);
            }))
            .on_action(cx.listener(|this, a: &pages::DeleteAutomation, _window, cx| {
                this.pages.automations.remove(&a.id);
                this.pages.automation_editor = None;
                this.pages.save_automations();
                cx.notify();
            }))
            .on_action(cx.listener(|this, a: &pages::ToggleAutomation, _window, cx| {
                if let Some(item) = this.pages.automations.find_mut(&a.id) {
                    item.disabled = !item.disabled;
                    // 启用时把计时器归零到现在，而不是留着上次那个时间戳。
                    //
                    // 不这么做的话：一条停用了三天的自动化重新启用会立刻触发
                    // （now - last_run 早就超过间隔了），而用户只是想「从现在
                    // 开始每小时一次」。
                    if !item.disabled {
                        item.last_run = smallest_agent_core::automations::now_millis();
                    }
                    this.pages.save_automations();
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, a: &pages::RunAutomation, window, cx| {
                this.run_automation(&a.id, window, cx);
            }))
            .on_action(cx.listener(|this, a: &pages::SetAutomationAgent, _window, cx| {
                if let Some(item) = this.pages.automations.find_mut(&a.id) {
                    item.agent_id = a.agent_id.clone();
                    this.pages.save_automations();
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, action: &RenameSession, window, cx| {
                this.start_rename(action.session_id.clone(), window, cx);
            }))
            .on_action(cx.listener(|this, _: &CancelRename, _window, cx| {
                this.cancel_rename(cx);
            }))
            .on_action(cx.listener(|this, action: &SetModel, _window, cx| {
                this.set_model(action.model_id.clone(), cx);
            }))
            // Esc 放弃重命名。
            //
            // 只在重命名时绑 —— 常驻的话会吃掉别处的 Esc
            // （输入框的 clean_on_escape、菜单的关闭）。
            .when(self.renaming.is_some(), |d| {
                d.on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| {
                    if ev.keystroke.key == "escape" {
                        this.cancel_rename(cx);
                    }
                }))
            })
            // Esc 放弃内联编辑。同上，只在编辑时绑
            .when(
                self.chats
                    .get(&self.current_id)
                    .is_some_and(|c| c.editing.is_some()),
                |d| {
                    d.on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| {
                        if ev.keystroke.key == "escape" {
                            this.cancel_edit(cx);
                        }
                    }))
                },
            )
            // Esc 停止正在跑的那一轮。
            //
            // 只在跑的时候绑：常驻会吃掉别处的 Esc。而且这个绑定要在
            // 上面两个之后 —— 编辑态和重命名态优先，那时 Esc 该是「放弃编辑」
            // 而不是「停止 agent」（两件事同时发生的概率不高，但顺序要明确）
            .when(
                self.chats
                    .get(&self.current_id)
                    .is_some_and(|c| c.running && c.editing.is_none())
                    && self.renaming.is_none(),
                |d| {
                    d.on_key_down(cx.listener(|this, ev: &KeyDownEvent, _window, cx| {
                        if ev.keystroke.key == "escape" {
                            this.stop(cx);
                        }
                    }))
                },
            )
            .child(render_sidebar(
                SidebarProps {
                    groups: &groups,
                    current_id: current_id.as_str(),
                    current_project_id: current_project.as_deref(),
                    settings_section: self.settings.as_ref().map(|f| f.section),
                    pane: self.pane,
                    titles: &self.titles,
                    renaming: self
                        .renaming
                        .as_ref()
                        .map(|(id, input)| (id.as_str(), input)),
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
                    on_open_page: Box::new(|this: &mut Self, pane, _window, cx| {
                        this.open_page(pane, cx)
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
            .child(self.render_content(cx))
    }
}

impl ChatView {
    /// 内容区：按当前 pane 分发。
    ///
    /// 设置那一支要查 self.settings 而不是只看 pane —— pane 说「该显示设置」，
    /// 表单状态是另一回事。表单没建起来时退回对话，比渲染一个空设置页诚实。
    fn render_content(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.pane {
            Pane::Settings => match &self.settings {
                Some(form) => render_settings(form, cx).into_any_element(),
                None => self.render_chat(cx).into_any_element(),
            },
            Pane::Tools => {
                let (line, names) = self.tools_summary();
                pages::render_tools_page(line, &names, cx)
            }
            Pane::Skills => {
                // 每次渲染都扫盘会让滚动掉帧，所以用启动时扫的那份快照。
                //
                // 原来这份快照在 SettingsForm 上，于是这里要分「设置建过没」
                // 两支 —— 而那正是「点了停用没反应」那个 bug 的来源
                // （见 PagesState::skills 的注释）。现在只有一个来源。
                pages::render_skills_page(&self.pages.skills, &self.pages.disabled_skills, cx)
            }
            Pane::Agents => pages::render_agents_page(&self.pages, &self.model_catalog, cx),
            Pane::Automations => pages::render_automations_page(&self.pages, cx),
            Pane::Chat => self.render_chat(cx).into_any_element(),
        }
    }

    /// 工具状态的一句话 + 工具名列表。
    ///
    /// 抽出来是因为设置页和独立的工具页都要它，而它读的是 self.tools_status
    /// （真相在那儿，不是配置文件）—— 两处各写一遍迟早不一致。
    fn tools_summary(&self) -> (String, Vec<String>) {
        match &self.tools_status {
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
        }
    }
}

impl ChatView {
    fn render_chat(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let chat = self.chats.get(&self.current_id);
        let empty = SessionChat::default();
        let chat = chat.unwrap_or(&empty);

        // 对话区：flex_1 吃掉剩余宽度，消息列表再 flex_1 吃掉剩余高度。
        let mut scroll = div()
            .id("transcript")
            .flex()
            .flex_col()
            .flex_1()
            // 顶部留白。
            //
            // 标题栏是 appears_transparent 的，窗口没有系统标题栏 ——
            // 不留这一段的话第一条消息会紧贴窗口上沿，而且和红绿灯撞在
            // 同一水平线上。侧边栏那边已经有 TRAFFIC_LIGHT_CLEARANCE，
            // 对话区之前漏了。
            //
            // 比侧边栏的 32 多一点：消息是内容而不是控件，贴太近显得挤。
            .pt(px(40.))
            // 其余间距（消息之间、轮次之间）由每条消息自己负责 ——
            // 它们不均等（用户消息上方要更大），统一 gap 表达不了
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
                    .border_1().border_color(Tokens::line())
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
                            .border_1().border_color(Tokens::line())
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
    /// 渲染一条消息为气泡。
    ///
    /// 用户靠右深色（field），助手靠左浅色（surface）—— 这个明暗关系来自
    /// Electron 版 MessageBubble 的 SIDE 常量，别对调。
    ///
    /// 两边最大宽度不同，见 USER_BUBBLE_MAX / ASSISTANT_BUBBLE_MAX 的注释。
    fn render_message(
        &self,
        idx: usize,
        m: &DisplayMessage,
        chat: &SessionChat,
        cx: &Context<Self>,
    ) -> AnyElement {
        let is_user = m.role == Role::User;

        // 正在编辑这一条：气泡整个换成输入框 + 取消/发送。
        //
        // 提前 return 而不是在气泡里塞一个分支：编辑态和展示态几乎没有
        // 共用的东西（没有工具轨迹、没有状态标记、没有悬浮操作栏），
        // 混在一个函数里会让两边都难读。
        if let Some((editing_idx, input)) = &chat.editing
            && *editing_idx == idx
        {
            return self.render_edit_box(input.clone(), cx).into_any_element();
        }

        let mut bubble = div()
            .flex()
            .flex_col()
            .min_w_0()
            .rounded(Radius::card())
            .px_3()
            .py(px(9.))
            .max_w(relative(if is_user {
                USER_BUBBLE_MAX
            } else {
                ASSISTANT_BUBBLE_MAX
            }))
            // 阴影而不是 border：hairline ring 是这套设计的视觉签名，
            // 而且 border 占布局空间（见 theme.rs 的 shadow_card 注释）
            .when(is_user, |d| d.bg(Tokens::field()).border_1().border_color(Tokens::line_strong()))
            .when(!is_user, |d| d.bg(Tokens::surface()).border_1().border_color(Tokens::line()));

        if is_user {
            // 用户消息不走 markdown：那是他自己打的字，把 `*` 之类当标记
            // 解释掉会改变他看到的内容
            bubble = bubble.child(
                div()
                    .text_size(FontSize::base())
                    .line_height(px(20.))
                    .text_color(Tokens::ink())
                    .child(m.text.clone()),
            );
        } else {
            // 助手消息：工具轨迹在上，正文在下
            for group in group_by_turn(&m.tools) {
                bubble = bubble.child(self.render_tool_group(idx, group, chat, cx));
            }

            if m.streaming {
                // 流式中不走 markdown：半截的 ``` 或表格会让解析器
                // 每个 token 重排一次
                bubble = bubble.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_baseline()
                        .text_size(FontSize::base())
                        .line_height(px(20.))
                        .text_color(Tokens::ink_2())
                        .child(m.text.clone())
                        .child(
                            div()
                                .id(SharedString::from(format!("cursor-{idx}")))
                                .w(px(7.))
                                .h(px(14.))
                                .ml(px(1.))
                                .bg(Tokens::accent())
                                .with_animation(
                                    SharedString::from(format!("blink-{idx}")),
                                    Animation::new(std::time::Duration::from_secs(1)).repeat(),
                                    // steps(2, start)：前半程可见后半程隐藏
                                    |d, delta| d.opacity(if delta < 0.5 { 1.0 } else { 0.0 }),
                                ),
                        ),
                );
            } else if !m.text.is_empty() {
                bubble = bubble.child(
                    div()
                        .text_size(FontSize::base())
                        .line_height(px(20.))
                        .text_color(Tokens::ink_2())
                        .child(
                            TextView::markdown(
                                SharedString::from(format!("md-{idx}")),
                                m.text.clone(),
                            )
                            .style(markdown_style())
                            // 代码块右上角的复制按钮。比整条消息的复制更常用 ——
                            // 模型回答里的代码是要拿去用的，而整条回答通常
                            // 还夹着解释文字。
                            //
                            // 这个回调由库在渲染每个代码块时调用，`code_block.code()`
                            // 给的是那一块的原始文本（不含高亮标记）。
                            .code_block_actions(|code_block, _window, _cx| {
                                let code = code_block.code().to_string();
                                div()
                                    .id("copy-code")
                                    .flex()
                                    .size(px(20.))
                                    .items_center()
                                    .justify_center()
                                    .rounded(Radius::chip())
                                    .cursor_pointer()
                                    .text_color(Tokens::ink_3())
                                    .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                                    .child(Icon::new(IconName::Copy).size(px(11.)))
                                    .on_mouse_down(MouseButton::Left, move |_, _window, cx| {
                                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                            code.clone(),
                                        ));
                                    })
                            })
                            .selectable(true),
                        ),
                );
            }
        }

        // 状态标记（已停止、缓存命中）挂在气泡底部
        if m.interrupted {
            bubble = bubble.child(
                div().mt(px(6.)).flex().child(
                    div()
                        .rounded_full()
                        .bg(Tokens::orange_tint())
                        .border_1().border_color(Tokens::line())
                        .px(px(8.))
                        .py(px(1.))
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::orange())
                        .child("已停止"),
                ),
            );
        }
        if m.cache_hit {
            bubble = bubble.child(
                div().mt(px(6.)).flex().child(
                    div()
                        .rounded_full()
                        .bg(Tokens::green_tint())
                        .border_1().border_color(Tokens::line())
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
            // 轮次分隔：用户消息上方留白大一些，让「新一轮开始了」看得出来
            .pt(if is_user && idx > 0 { px(14.) } else { px(4.) })
            .pb(px(4.))
            .child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .flex()
                    .flex_col()
                    // group 挂在「气泡 + 操作栏」这一层：悬浮气泡的任何位置
                    // 都要让操作栏显形，所以 group 必须包住两者。
                    // 挂在气泡上的话，鼠标移到操作栏时气泡不再 hover，
                    // 操作栏会闪一下就消失 —— 点都点不到
                    .group(SharedString::from(format!("msg-{idx}")))
                    .child(
                        div()
                            .w_full()
                            .flex()
                            // 靠右 / 靠左 —— 气泡布局的核心
                            .when(is_user, |d| d.justify_end())
                            .child(bubble),
                    )
                    .child(self.render_message_actions(idx, m, chat, cx)),
            )
            .into_any_element()
    }

    /// 内联编辑框：输入框 + 取消/发送。
    ///
    /// 宽度和用户气泡一致而不是撑满：改的是一条用户消息，
    /// 保持它原来的体量，视觉上才是「这一条变成了可编辑的」，
    /// 而不是「页面上多了个编辑器」。
    fn render_edit_box(
        &self,
        input: Entity<TextareaState>,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let has_text = !input.read(cx).value().trim().is_empty();

        // 一个小按钮。取消是描边、发送是实心 —— 和审批卡那两个按钮
        // 同一套编码（见 render_approval），因为语义是同一类：
        // 一个放弃、一个确认
        let btn = |id: &'static str, label: &'static str, primary: bool, enabled: bool| {
            div()
                .id(id)
                .flex()
                .h(px(26.))
                .items_center()
                .px_3()
                .rounded(Radius::control())
                .text_size(FontSize::sm())
                .when(enabled, |d| d.cursor_pointer())
                .when(primary && enabled, |d| {
                    d.bg(Tokens::ink())
                        .text_color(Tokens::page())
                        .hover(|s| s.opacity(0.85))
                })
                // 空内容时发送按钮变灰不可点 —— 和 composer 的发送键同一个规则
                .when(primary && !enabled, |d| {
                    d.bg(Tokens::hover_2()).text_color(Tokens::ink_3())
                })
                .when(!primary, |d| {
                    d.text_color(Tokens::ink_2())
                        .border_1()
                        .border_color(Tokens::line())
                        .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                })
                .child(label)
        };

        div()
            .w_full()
            .flex()
            .justify_center()
            .px_5()
            .pt(px(14.))
            .pb(px(4.))
            .child(
                div()
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .flex()
                    .justify_end()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            // 和原始气泡宽度一致：max_w(USER_BUBBLE_MAX)
                            // 高度：auto_grow 2..6 行，超出内部滚动，不顶开布局
                            .max_w(relative(USER_BUBBLE_MAX))
                            .w_full()
                            .rounded(Radius::card())
                            .bg(Tokens::field())
                            .border_1()
                            .border_color(Tokens::accent())
                            .px_3()
                            .py(px(9.))
                            .child(Textarea::new(&input))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_end()
                                    .gap_2()
                                    .child(btn("edit-cancel", "取消", false, true).on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(|this, _, _window, cx| this.cancel_edit(cx)),
                                    ))
                                    .child(btn("edit-send", "发送", true, has_text).on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(|this, _, window, cx| {
                                            this.submit_edit(window, cx)
                                        }),
                                    )),
                            ),
                    ),
            )
    }

    /// 气泡下面那一行悬浮操作：时间 + 复制（+ 用户消息的编辑）。
    ///
    /// ## 为什么用 cx.listener 而不是 dispatch_action
    ///
    /// 第一版用的是 action，**点了没反应** —— gpui 的 action 要沿焦点链
    /// 派发，而这些按钮不在任何 focus handle 的子树里，派发出去没人接。
    /// 工具面板那个展开按钮一直用的是 cx.listener（见 render_tool_group），
    /// 那才是这里该照的样子。
    ///
    /// ## 为什么是常驻元素 + group_hover 控制透明度
    ///
    /// 不用「hover 时才 child 进去」那种写法：那会让气泡在悬浮瞬间**变高**
    /// （多出一行），下面所有消息跟着跳一下。常驻占位 + 改 opacity
    /// 的话布局是稳的，只是平时看不见。
    fn render_message_actions(
        &self,
        idx: usize,
        m: &DisplayMessage,
        chat: &SessionChat,
        cx: &Context<Self>,
    ) -> impl IntoElement {
        let is_user = m.role == Role::User;
        let time = crate::msg_times::format_hm(m.at, crate::msg_times::utc_offset_secs());
        // 刚复制过就把图标换成对勾。2 秒后自然回到复制图标 ——
        // 靠的是「下一帧渲染时时间已经过了」，不需要定时器
        let just_copied = chat
            .copied
            .is_some_and(|(i, t)| i == idx && t.elapsed() < std::time::Duration::from_secs(2));

        div()
            .flex()
            .h(px(18.))
            .items_center()
            .gap(px(2.))
            .mt(px(2.))
            // 平时透明，悬浮气泡时显形。group 名字按下标唯一 ——
            // 用同一个名字的话悬浮任何一条会让所有消息的操作栏一起亮
            .opacity(0.)
            .group_hover(SharedString::from(format!("msg-{idx}")), |s| s.opacity(1.))
            // 用户消息靠右，和气泡本身的对齐方向一致
            .when(is_user, |d| d.justify_end())
            .when(!time.is_empty(), |d| {
                d.child(
                    div()
                        .px(px(4.))
                        .text_size(FontSize::tiny())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(Tokens::ink_3())
                        .child(time.clone()),
                )
            })
            .child(
                div()
                    .id(SharedString::from(format!("copy-{idx}")))
                    .flex()
                    .size(px(20.))
                    .items_center()
                    .justify_center()
                    .rounded(Radius::chip())
                    .cursor_pointer()
                    // 复制成功用绿色对勾 —— 光换图标不换色的话，
                    // 20px 里那点形状差别很容易看漏
                    .text_color(if just_copied {
                        Tokens::green()
                    } else {
                        Tokens::ink_3()
                    })
                    .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                    .child(
                        Icon::new(if just_copied {
                            IconName::Check
                        } else {
                            IconName::Copy
                        })
                        .size(px(12.)),
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _window, cx| this.copy_message(idx, cx)),
                    ),
            )
            // 编辑只给用户消息：改模型说过的话没有意义 ——
            // 它不是「我想说的」，改了也不会让模型重新想
            .when(is_user, |d| {
                d.child(
                    div()
                        .id(SharedString::from(format!("edit-{idx}")))
                        .flex()
                        .size(px(20.))
                        .items_center()
                        .justify_center()
                        .rounded(Radius::chip())
                        .cursor_pointer()
                        .text_color(Tokens::ink_3())
                        .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                        .child(Icon::new(IconName::Replace).size(px(12.)))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, window, cx| {
                                this.begin_edit(idx, window, cx)
                            }),
                        ),
                )
            })
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
        // 拒绝和失败分开统计：一个是「我不让它做」，一个是「它做了但失败了」。
        // 混在一起的话，一次自己按的拒绝会在历史里显示成一个红色故障。
        let denied_count = group.iter().filter(|t| t.denied()).count();
        let failed_count = group.iter().filter(|t| t.failed() && !t.denied()).count();
        let has_failed = failed_count > 0;
        let count = group.len();

        let mut wrapper = div()
            .mb(px(8.))
            // w_full：**展开时宽度不能变**。
            //
            // 原因不是箭头图标（第一反应会往那儿想），是气泡用的
            // `max_w` 而不是固定宽度 —— 宽度由内容撑出来。折叠时这里
            // 只有一行短标题，气泡就窄；展开后工具输出那一大段把它推到
            // max_w 上限，于是「点一下面板变宽了」。
            //
            // 撑满父容器之后，宽度由气泡决定而不是由这个面板的内容决定，
            // 展开折叠就不再影响它。
            //
            // 注意还要配 min_w_0：flex 子项默认 min-width:auto，
            // 里面那些长命令行会顶开容器，w_full 也拦不住。
            .w_full()
            .min_w_0()
            // 注意：这个 overflow_hidden **不裁圆角**，只裁矩形溢出。
            // gpui 的 ContentMask 里只有一个 bounds 矩形，没有圆角信息
            // （window.rs 那个类型的文档就写着 "only rectangular content
            // masks are supported"）。所以它不等于 CSS 的 overflow:hidden ——
            // 子元素的方角底色照样会盖住父元素的圆角。
            // 圆角要由**子元素自己**声明，见下面 header 那两行 when。
            .overflow_hidden()
            .rounded(px(10.))
            .bg(Tokens::inset())
            .border_1().border_color(Tokens::line())
            .child(
                div()
                    .id(SharedString::from(format!("tg-{msg_idx}-{turn}")))
                    .flex()
                    .h(px(28.))
                    .w_full()
                    .items_center()
                    .gap(px(6.))
                    .px_2()
                    // hover 底色自己带圆角，否则 hover 时方角底盖住卡片圆角，
                    // 看起来就是「圆角丢了」。
                    //
                    // 9 而不是 10：这一层在父元素 1px 边框的**内侧**，
                    // 内圆角 = 外圆角 - 边框宽度。用 10 会在四个角上多出一点点，
                    // 正好压在边框的弧线上。
                    //
                    // 折叠时这一行就是整张卡（下面没有 body），所以四角都要圆；
                    // 展开时它只是顶部，圆上面两角，下面留给 body。
                    .when(open, |d| d.rounded_t(px(9.)))
                    .when(!open, |d| d.rounded(px(9.)))
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
                    // 被拒绝的用 orange 而不是 red —— 这不是故障，
                    // 是用户自己做的决定，和审批卡片用同一个色（见 render_approval）
                    .when(denied_count > 0, |d| {
                        d.child(
                            div()
                                .font_family(FONT_MONO)
                                .text_size(FontSize::tiny())
                                .text_color(Tokens::orange())
                                .child(format!("已拒绝 {denied_count}")),
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
            // min_w_0 同 wrapper：不加的话里面那些长 JSON 参数会把
            // 整个面板顶宽，w_full 白设
            let mut body = div().flex().flex_col().min_w_0().gap_1().px_2().pb_2();
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
                        // min_w_0 + w_full：等宽字体的长参数（一整行 JSON、
                        // 一条长命令）默认会撑开父容器。这两个让它在容器内
                        // 换行，宽度就稳定了
                        .min_w_0()
                        .w_full()
                        .gap(px(2.))
                        .rounded(Radius::chip())
                        .bg(Tokens::inset())
                        .p_2()
                        .text_size(FontSize::tiny())
                        .font_family(FONT_MONO)
                        .child(
                            div()
                                .text_color(if t.denied() {
                                    Tokens::orange()
                                } else if t.failed() {
                                    Tokens::red()
                                } else {
                                    Tokens::accent_ink()
                                })
                                .child(if t.denied() {
                                    // 前缀说清是谁拦下来的。只显示 name+args
                                    // 的话，回看时看不出这次为什么没结果
                                    format!("[已拒绝] {} {}", t.name, t.args)
                                } else {
                                    format!("{} {}", t.name, t.args)
                                }),
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
    fn render_composer(&self, chat: &SessionChat, cx: &mut Context<Self>) -> impl IntoElement {
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
                    .border_1().border_color(Tokens::line())
                    .px(px(12.))
                    .py(px(10.))
                    .child(Textarea::new(&self.input))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            // 左侧：provider 选择器 + 工具状态。
                            //
                            // 放在 composer 而不是顶部状态栏 —— 用户关心
                            // 「这条消息谁来答」的时刻就是准备提问的时刻，
                            // 信息该出现在他视线所在的地方（waku 也是这么放的）。
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .min_w_0()
                                    .child(self.render_provider_picker(cx))
                                    .child(self.render_model_picker(cx))
                                    .child(self.render_permission_picker(cx))
                                    .child(self.render_tools_hint()),
                            )
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
                            .border_1().border_color(Tokens::line())
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
                    .border_1().border_color(Tokens::line())
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

    /// provider 选择器。
    ///
    /// 用 PopupMenu 而不是一排按钮：provider 数量不定（用户能配任意多个），
    /// 一排按钮在 composer 那点空间里放不下三个以上。
    fn render_provider_picker(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let current_id = self
            .providers_state
            .provider_for(&self.current_id)
            .to_string();
        let options = self.providers_state.options();
        let current_name = options
            .iter()
            .find(|o| o.id == current_id)
            .map(|o| o.name.clone())
            // 绑定指向一个已经不存在的 provider（配置被手改过）——
            // normalize 会清掉，但内存态里可能还在
            .unwrap_or_else(|| "内置 agent".to_string());
        let is_external = options
            .iter()
            .find(|o| o.id == current_id)
            .map(|o| o.external)
            .unwrap_or(false);

        // 只有一个可选时不做成菜单：点开只有一项的下拉是空动作，
        // 显示成纯文本反而诚实（「现在用的是这个，没别的可选」）
        if options.len() <= 1 {
            return div()
                .flex()
                .items_center()
                .gap(px(4.))
                .text_size(FontSize::xxs())
                .font_weight(FontWeight::NORMAL)
                .text_color(Tokens::ink_3())
                .child(Icon::new(IconName::Bot).size(px(11.)))
                .child(current_name)
                .into_any_element();
        }

        let items = options
            .iter()
            .map(|o| {
                picker::PickerItem::new(o.id.clone(), o.name.clone()).icon(if o.external {
                    IconName::SquareTerminal
                } else {
                    IconName::Bot
                })
            })
            .collect();

        picker::render_picker(
            picker::PickerTrigger {
                id: "provider-picker",
                label: current_name,
                icon: Some(if is_external {
                    IconName::SquareTerminal
                } else {
                    IconName::Bot
                }),
            },
            items,
            current_id,
            |this, id, _window, cx| this.set_provider(id, cx),
            cx,
        )
    }

    /// 模型选择器。
    ///
    /// 两条分支，因为「模型」这个词对两种 provider 指的不是一回事：
    ///
    ///   • 内置 agent：厂商 + 模型（我们自己发 HTTP，要 base_url 和 key）
    ///   • 外部 CLI：那个 CLI 声明的模型 id（通过 env/args 传给子进程）
    ///
    /// 所以列表来源和绑定存储都不同，见 ProvidersState 里那两个字段的注释。
    fn render_model_picker(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let provider_id = self.providers_state.provider_for(&self.current_id);
        if provider_id == BUILTIN_ID {
            return self.render_builtin_model_picker(cx);
        }
        let models = self.providers_state.models_for(provider_id);
        if models.is_empty() {
            return div().into_any_element();
        }

        let current = self.providers_state.model_for(&self.current_id);
        // 没绑定时当成选中第一个 —— 那也是显示出来的那个（下面 current_name
        // 同一个兜底）。让「显示的」和「打勾的」是同一项，否则打开下拉会看到
        // 按钮上写着 A 而列表里勾在别处。
        let current_id = current
            .map(|s| s.to_string())
            .or_else(|| models.first().map(|m| m.id.clone()))
            .unwrap_or_default();
        let current_name = models
            .iter()
            .find(|m| m.id == current_id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| "默认模型".into());

        // 模型行不给图标：一列十几个相同的图标是噪音，
        // 而「哪一项生效」已经由底色 + 勾表达了
        let items = models
            .iter()
            .map(|m| picker::PickerItem::new(m.id.clone(), m.name.clone()))
            .collect();

        picker::render_picker(
            picker::PickerTrigger {
                id: "model-picker",
                label: current_name,
                icon: None,
            },
            items,
            current_id,
            |this, id, _window, cx| this.set_model(id, cx),
            cx,
        )
    }

    /// 内置 agent 的模型选择器：九家厂商的模型 + 自定义端点，按厂商分组。
    ///
    /// 选项 id 是 `厂商id/模型id` —— 一次点击同时决定 base_url 和模型，
    /// 这两件事在内置 agent 里是绑在一起的（换厂商必然换端点）。
    /// 分成两级选择器（先选厂商再选模型）要多一次点击，而十项 × 三四个模型
    /// 一共三十几项，一个带分组头的列表装得下。
    fn render_builtin_model_picker(&self, cx: &mut Context<Self>) -> AnyElement {
        let sel = self.providers_state.builtin_selection(&self.current_id);
        let current_id = format!("{}/{}", sel.vendor_id, sel.model);

        // 标签只显示模型名 —— composer 那行放不下「Anthropic · Claude Opus 5」，
        // 而厂商信息在展开的列表里由分组头给出。
        // 找不到（自定义端点的清单刚被删掉一项）就显示 id 本身。
        let current_name = self
            .model_catalog
            .iter()
            .filter(|e| e.id == sel.vendor_id)
            .flat_map(|e| e.models.iter())
            .find(|m| m.id == sel.model)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| sel.model.clone());

        let mut items = Vec::new();
        for e in &self.model_catalog {
            for m in &e.models {
                items.push(
                    picker::PickerItem::new(format!("{}/{}", e.id, m.id), m.name.clone())
                        .group(e.name.clone()),
                );
            }
        }

        picker::render_picker(
            picker::PickerTrigger {
                id: "builtin-model-picker",
                label: current_name,
                icon: None,
            },
            items,
            current_id,
            |this, id, _window, cx| this.set_builtin_model(&id, cx),
            cx,
        )
    }

    /// 权限选择器：这条会话里 agent 能动多少东西。仿 Codex。
    ///
    /// 只对内置 agent 显示 —— 外部 CLI 自带权限模型（claude code 有它自己的
    /// 「本次允许 / 本会话都允许」），我们在旁边再放一个只会让人以为
    /// 这个能管住它。
    fn render_permission_picker(&self, cx: &mut Context<Self>) -> AnyElement {
        use crate::providers::PermissionMode;
        if self.providers_state.provider_for(&self.current_id) != BUILTIN_ID {
            return div().into_any_element();
        }
        let current = self.providers_state.permission_for(&self.current_id);
        let items = PermissionMode::ALL
            .iter()
            .map(|m| picker::PickerItem::new(m.id(), m.label()).icon(m.icon()))
            .collect();

        picker::render_picker(
            picker::PickerTrigger {
                id: "permission-picker",
                label: current.label().to_string(),
                icon: Some(current.icon()),
            },
            items,
            current.id().to_string(),
            |this, id, _window, cx| this.set_permission(&id, cx),
            cx,
        )
    }

    /// composer 左下角那行工具状态。
    fn render_tools_hint(&self) -> impl IntoElement {
        // 外部 CLI 自己管工具 —— 显示我们的 MCP 状态会让人以为那些工具
        // 对它可用，而实际上它用的是自己那套。
        if self.providers_state.provider_for(&self.current_id) != BUILTIN_ID {
            return div().into_any_element();
        }

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
