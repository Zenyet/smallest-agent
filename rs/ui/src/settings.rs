// ============================================================================
// settings.rs —— 设置：独立窗口 + 落盘
//                对应 electron/renderer/src/{SettingsWindow,components/SettingsPanel}.tsx
//                和 electron/main/{settings-store,config-env}.ts
// ----------------------------------------------------------------------------
// 分区、字段、说明文案全部照搬 Electron 版（HINTS 那张表逐条抄过来）。
//
// ## 落盘位置与 .env 的关系
//
// Electron 用 electron-store 写 userData 目录。这边写
// ~/Library/Application Support/smallest-agent/settings.json（macOS），
// 因为不想为一个 KV 文件引依赖。
//
// 优先级：环境变量 > settings.json > 内置默认值。
// 这样 `DEEPSEEK_MODEL=xxx cargo run` 这类临时覆盖仍然有效，
// 而设置窗口改的是持久层。main.rs 的 load_dotenv 也遵守同样规则
// （已存在的环境变量不覆盖），三者一致。
//
// ## 明文存储
//
// API key 明文存在这个文件里，不加密 —— 和 Electron 版一样的取舍
// （那边的注释写了：不引 keytar 是为了少一层跨平台打包复杂度）。
// 这条披露挂在用户实际填 key 的那一栏下面，见 HINTS。
// ============================================================================

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context as _, Result};
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::input::{Input, InputState};

use smallest_agent_core::vendors;

use crate::theme::{FontSize, Tokens};

/// 不属于任何厂商的字段。
///
/// 厂商相关的键（每家的 API Key、自定义端点那三个）不在这里 —— 它们从
/// `vendors` 那边推出来，见 `setting_keys()`。写死一份会和那张表脱节。
const COMMON_KEYS: &[&str] = &[
    // 搜索后端的 key。
    //
    // 这里**没有**工作目录 —— 它不是全局设置，而是会话所属项目的目录
    // （新建对话时就选了）。见 providers.rs 的 fs_shell_tools。
    smallest_agent_core::tools::web::BRAVE_KEY,
    smallest_agent_core::tools::web::TAVILY_KEY,
    "STREAM",
    "LLM_CACHE",
    "NOTES_DIR",
    "EMBEDDING_MODEL",
    "HF_ENDPOINT",
    "MAX_RETRIES",
    "MAX_TURNS",
    "MAX_CONTEXT_TOKENS",
    "KEEP_RECENT",
];

/// 全部可配置的字段 = 通用字段 + 每家厂商的 key + 自定义端点那三个。
///
/// 原来这是个写死的 `SETTING_KEYS` 常量，里面只有 DeepSeek 那几个。
/// 加了多厂商之后它必须是动态的 —— 手写会和 vendors.rs 那张表脱节
/// （加一家忘了加这里，设置页上就没有它的输入框）。
///
/// 内置厂商**只有一个键**（key）。原来每家还有一个 `*_BASE_URL`，
/// 删掉了 —— 那些地址是固定的，见 vendors.rs 文件头。要指别的地址
/// 用自定义端点，它的三个键在最后。
pub fn setting_keys() -> Vec<String> {
    let mut keys: Vec<String> = COMMON_KEYS.iter().map(|k| k.to_string()).collect();
    for v in vendors::ALL {
        keys.push(v.key_env.to_string());
    }
    keys.extend(vendors::CUSTOM_KEYS.iter().map(|k| k.to_string()));
    keys
}

/// 字段的人话标题。
///
/// ## 为什么不直接显示 key
///
/// 原来标题就是 `DEEPSEEK_API_KEY` 这种。它准确 —— 那**就是**要写进
/// settings.json 的键名 —— 但一整页大写下划线读起来像在看配置文件，
/// 而设置页的作用正是让人不必看配置文件。
///
/// 所以标题给人话，key 本身降级成标题下面那行小字（等宽、灰色）。
/// 两者都留着：想手改文件的人仍然知道键名叫什么。
fn label(key: &str) -> String {
    // 厂商的 key。卡片头已经写了是哪家（「Anthropic 凭据」），
    // 所以这里说的是**哪个字段**，不再重复厂商名 ——
    // 一张卡里两行都叫「Anthropic」的话，反而看不出上下有什么区别。
    if vendors::ALL.iter().any(|v| v.key_env == key) {
        return "API Key".to_string();
    }
    match key {
        // 自定义端点那三个。用 guard 而不是字面量：键名是 vendors.rs 里的
        // 常量，抄一份到这儿就会有两个真相
        k if k == vendors::CUSTOM_BASE_URL => "API 端点",
        k if k == smallest_agent_core::tools::web::BRAVE_KEY => "Brave Search Key",
        k if k == smallest_agent_core::tools::web::TAVILY_KEY => "Tavily Key",
        k if k == vendors::CUSTOM_API_KEY => "API Key",
        k if k == vendors::CUSTOM_MODELS => "模型清单",
        k if k == vendors::CUSTOM_SEARCH_TOOL => "联网搜索工具",
        "NOTES_DIR" => "笔记目录",
        "EMBEDDING_MODEL" => "嵌入模型",
        "HF_ENDPOINT" => "HuggingFace 镜像",
        "STREAM" => "流式输出",
        "LLM_CACHE" => "磁盘缓存",
        "MAX_RETRIES" => "重试次数",
        "MAX_TURNS" => "最大轮数",
        "MAX_CONTEXT_TOKENS" => "上下文上限",
        "KEEP_RECENT" => "保留最近条数",
        // 兜底成空串，调用方会退回显示键名本身 —— 加了新字段忘了填这张表时
        // 界面上是键名（丑但可用），而不是一行空白
        _ => "",
    }
    .to_string()
}

/// 必填的字段。
///
/// 空的：加了多厂商之后**没有单个字段是必填的** —— load_config 要的是
/// 「至少配一家」，而那不是任何一栏自己的属性。在九家里每家都标红星
/// 会变成噪音，而且是错的（填了一家就够）。
///
/// 「一家都没配」这件事由厂商那张卡的卡片头说明（见 render_settings），
/// 那是唯一能表达「至少一个」的地方。
const REQUIRED: &[&str] = &[];

/// 每个字段的说明，逐条抄自 Electron 版的 HINTS。
fn hint(key: &str) -> Option<String> {
    // 厂商的 key 栏：显示去哪儿领。省得用户自己搜控制台在哪。
    for v in vendors::ALL {
        if key == v.key_env {
            return Some(format!("在 {} 领取", v.console));
        }
    }
    Some(
        match key {
        k if k == smallest_agent_core::tools::web::BRAVE_KEY => {
            "配了才能搜全网。留空的话 web_search 只能搜维基百科。\
             在 https://brave.com/search/api 领取"
        }
        k if k == smallest_agent_core::tools::web::TAVILY_KEY => {
            "同上，二选一即可。在 https://tavily.com 领取"
        }
        // 自定义端点。这三条说明比别处长，因为这一栏没有默认值可猜 ——
        // 「OpenAI 兼容端点」这个概念本身就得解释，例子比定义有用。
        k if k == vendors::CUSTOM_BASE_URL => {
            "OpenAI 兼容端点，不含 /chat/completions。\
             例：http://localhost:11434/v1（Ollama）、https://openrouter.ai/api/v1"
        }
        k if k == vendors::CUSTOM_API_KEY => {
            "本地服务（Ollama / LM Studio / vLLM）通常不校验，可以留空"
        }
        k if k == vendors::CUSTOM_MODELS => {
            "模型 id，逗号或换行分隔。例：llama3.1, qwen2.5:14b。\
             填了才会出现在对话框的模型选择器里"
        }
        k if k == vendors::CUSTOM_SEARCH_TOOL => {
            "这个端点如果自带服务端搜索，填它的 tool type，用同一把 key 就能联网。\
             OpenRouter 填 openrouter:web_search。留空表示没有"
        }
        "NOTES_DIR" => "RAG 检索的笔记目录，默认 ./notes",
        "EMBEDDING_MODEL" => "嵌入模型，默认 Xenova/multilingual-e5-small",
        "HF_ENDPOINT" => "国内连不上 HuggingFace 时填 https://hf-mirror.com",
        "STREAM" => "填 0 关闭流式输出，填 1 开启",
        "LLM_CACHE" => "填 0 关闭磁盘缓存，填 1 开启",
        "MAX_RETRIES" => "单个模型调用失败时的重试次数，默认 2",
        "MAX_TURNS" => "agent 循环最多转几圈，默认 10",
        "MAX_CONTEXT_TOKENS" => "历史超过这个估算值就压缩，默认 2000",
        "KEEP_RECENT" => "压缩时保留最近几条，默认 6",
        _ => return None,
        }
        .to_string(),
    )
}

/// 改了要重启才生效的字段。
///
/// 这两个影响的是启动阶段建的东西（embedding 模型、笔记索引），
/// 改了之后当前进程里的那份不会重建。其余字段每轮重新读配置，下一轮就生效。
const RESTART_REQUIRED: &[&str] = &["NOTES_DIR", "EMBEDDING_MODEL"];

/// settings.json 的路径。
pub fn settings_path() -> Result<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|h| h.join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|h| h.join(".config"))
            })
    }
    .context("找不到用户配置目录")?;
    Ok(base.join("smallest-agent").join("settings.json"))
}

/// 读设置。文件不存在或坏了都返回空表 —— 缺设置不该让应用起不来。
pub fn load_settings() -> BTreeMap<String, String> {
    let Ok(path) = settings_path() else {
        return BTreeMap::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return BTreeMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// 写设置。
pub fn save_settings(map: &BTreeMap<String, String>) -> Result<()> {
    let path = settings_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("建配置目录失败：{}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(map).context("序列化设置失败")?;
    std::fs::write(&path, json).with_context(|| format!("写设置失败：{}", path.display()))
}

/// 把设置里的值灌进环境变量，供 core 的 load_config 读取。
///
/// **不覆盖已存在的环境变量**：命令行临时指定的应该赢过持久设置。
/// 这条规则和 main.rs 的 load_dotenv 一致。
pub fn apply_to_env(map: &BTreeMap<String, String>) {
    for (k, v) in map {
        if v.trim().is_empty() {
            continue;
        }
        if std::env::var_os(k).is_none() {
            // SAFETY: 启动阶段，还没起后台线程
            unsafe { std::env::set_var(k, v) };
        }
    }
}

/// 设置表单的状态。
///
/// 不是独立的 Render 实体 —— 它挂在 ChatView 上，由 ChatView 决定
/// 渲染对话还是渲染设置。见 SettingsSection 的注释。
pub struct SettingsForm {
    /// 每个字段一个输入框实体
    pub inputs: BTreeMap<String, Entity<InputState>>,
    pub section: SettingsSection,
    /// 打开时的值，用来判断哪些字段被改过（决定要不要显示重启提示）
    baseline: BTreeMap<String, String>,
    /// 保存后的反馈
    pub note: Option<String>,
    /// 工具状态的一句话描述，由 ChatView 在打开设置时灌进来 ——
    /// 真相在 ChatView 的 tools_status 上，这里只是一份用于显示的快照。
    pub tools_status_line: String,
    pub tool_names: Vec<String>,
    /// provider 列表和当前选中，由 ChatView 打开设置时灌进来。
    /// 同 tools_status_line —— 真相在 ChatView 上，这里只是显示用的快照。
    pub provider_options: Vec<crate::providers::ProviderOption>,
    pub active_provider: String,
    /// 「模型」页当前在看哪一项（内置厂商的 id，或者 `CUSTOM_ID`）。
    ///
    /// ## 为什么要有这个状态
    ///
    /// 第一版把九家的 key + 端点（18 个输入框）一次全铺出来。两个问题：
    ///
    ///   1. **卡** —— gpui 不做虚拟化，18 个 Input 每帧全量布局，滚动掉帧
    ///   2. 没有软件这么做。Cherry Studio / ChatBox / LobeChat 都是
    ///      「选一个 provider，只看它的配置」
    ///
    /// 两个问题同一个根因，所以同一个改动解决：一次只渲染一项。
    /// 后来端点那一栏也删了（见 vendors.rs 文件头），所以内置厂商
    /// 同屏只有 1 个输入框，自定义端点 3 个。
    ///
    /// 存 id 而不是索引：厂商清单是常量，但索引会让「加一家」变成
    /// 一个可能错位的改动，而且自定义端点根本不在那个数组里。
    pub active_vendor: String,
}

impl SettingsForm {
    pub fn new(window: &mut Window, cx: &mut App) -> Self {
        let stored = load_settings();
        let mut inputs = BTreeMap::new();
        for key in setting_keys() {
            let key = key.as_str();
            let value = stored.get(key).cloned().unwrap_or_default();
            // 所有厂商的 key 都要掩码，自定义端点那把也算
            let is_secret = key == vendors::CUSTOM_API_KEY
                || key == smallest_agent_core::tools::web::BRAVE_KEY
                || key == smallest_agent_core::tools::web::TAVILY_KEY
                || vendors::ALL.iter().any(|v| v.key_env == key);
            let input = cx.new(|cx| {
                let mut st = InputState::new(window, cx).default_value(value);
                // API key 掩码显示。Electron 版是 type="password"。
                if is_secret {
                    st = st.masked(true);
                }
                st
            });
            inputs.insert(key.to_string(), input);
        }
        Self {
            inputs,
            section: SettingsSection::General,
            baseline: stored,
            note: None,
            tools_status_line: String::new(),
            tool_names: Vec::new(),
            provider_options: Vec::new(),
            active_provider: crate::providers::BUILTIN_ID.to_string(),
            // 默认落在**已经配了 key** 的第一家上，没有就落在目录第一家。
            //
            // 不无脑用第一家：老用户配的是 DeepSeek（它正好排第一，所以看不出
            // 区别），但只配了 Anthropic 的人打开设置会看到一个空的 DeepSeek
            // 表单，像是他的 key 丢了。
            active_vendor: {
                let stored = load_settings();
                vendors::first_configured(&|k| stored.get(k).cloned())
                    .unwrap_or_else(|| vendors::DEFAULT_VENDOR.to_string())
            },
        }
    }

    /// 收集当前值，空字段不写进文件（让它回落到默认值）。
    fn collect(&self, cx: &App) -> BTreeMap<String, String> {
        // 从磁盘上那份开始，而不是从空表。
        //
        // 只收集表单里的字段会**删掉文件里其它的键** —— 比如用户手写的
        // LOCAL_MODEL_PATH、TEMPERATURE，或者老版本留下的 DEEPSEEK_MODEL。
        // 每次改一个字段都整体覆写，那些键就静默消失了。
        let mut out = load_settings();
        for (k, input) in &self.inputs {
            let v = input.read(cx).value().to_string();
            if v.trim().is_empty() {
                // 清空 = 回落到默认值，所以删掉这个键而不是存一个空串
                out.remove(k);
            } else {
                out.insert(k.clone(), v);
            }
        }
        out
    }

    /// 改过的字段里有没有需要重启的。
    fn needs_restart(&self, cx: &App) -> bool {
        RESTART_REQUIRED.iter().any(|key| {
            let now = self
                .inputs
                .get(*key)
                .map(|i| i.read(cx).value().to_string())
                .unwrap_or_default();
            now != self.baseline.get(*key).cloned().unwrap_or_default()
        })
    }

    pub fn save(&mut self, cx: &mut App) {
        let map = self.collect(cx);
        match save_settings(&map) {
            Ok(()) => {
                // 实时保存下**不报「已保存」** —— 每敲一个字都弹一次
                // 「已保存」是噪音，而且它说的是理所当然的事。
                //
                // 只在有实际后果时说话：改了要重启才生效的字段，
                // 用户必须知道「你改了但现在还没生效」。
                self.note = if self.needs_restart(cx) {
                    Some("笔记目录 / 嵌入模型的改动要重启应用才生效".into())
                } else {
                    None
                };
            }
            // 失败必须说 —— 用户以为改了，其实没落盘
            Err(err) => self.note = Some(format!("保存失败：{err:#}")),
        }
    }
}

/// 设置页面的分区。
///
/// 和 waku 一致：设置是**主界面里的一个页面**，不是独立窗口。
/// 打开时内容区整个换成设置，侧边栏换成分区导航。
///
/// 为什么不用独立窗口（我第一版就是那么做的）：
///   • 单例、聚焦、重复打开、关闭时机全要自己管，而这些逻辑没有产品价值
///   • 两个窗口之间要同步状态（改了设置主界面下一轮才生效，
///     但「哪些字段改过」这类 UI 状态没法共享）
///   • macOS 上 ⌘, 打开新窗口会切 Space，用户正在看的对话被挪走
///
/// 内嵌页面这三个问题都不存在：它就是同一棵树上的另一个分支。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsSection {
    General,
    /// agent 的手脚：工作目录 + 搜索后端。
    ///
    /// 和「模型」分开是因为它们答的是不同问题：模型是「谁来想」，
    /// 这一页是「它能动什么」。
    Capabilities,
    /// 模型（内置 agent 用的那个 API）
    Provider,
    /// Agent 模式：内置 agent 还是外部 CLI 套壳。
    ///
    /// 和 Provider 分开是因为它们答的是不同问题：Provider 是「内置 agent
    /// 调哪个模型」，Agents 是「这轮对话由谁来跑」。
    Agents,
    Retrieval,
    Advanced,
}

impl SettingsSection {
    pub const ALL: [SettingsSection; 6] = [
        SettingsSection::General,
        SettingsSection::Capabilities,
        SettingsSection::Provider,
        SettingsSection::Agents,
        SettingsSection::Retrieval,
        SettingsSection::Advanced,
    ];

    pub fn label(&self) -> &'static str {
        match self {
            SettingsSection::General => "通用",
            SettingsSection::Capabilities => "能力",
            SettingsSection::Provider => "模型",
            SettingsSection::Agents => "Agent 模式",
            SettingsSection::Retrieval => "检索",
            SettingsSection::Advanced => "高级",
        }
    }

    /// 分区里的字段，按**组**排列。每组一张卡片，组名是卡片头。
    ///
    /// ## 为什么要分组，而不是一个分区一长条
    ///
    /// 原来每个分区是一列平铺的字段。四个字段还行，但「模型」那页里
    /// `DEEPSEEK_API_KEY` 和 `FALLBACK_MODEL` 挨在一起 —— 一个是凭据、
    /// 一个是降级策略，读的时候要自己在脑子里分堆。
    ///
    /// 分组把这件事交给版面：凭据一张卡、模型一张卡，卡片头一眼扫过去
    /// 就知道下面几行是一类东西。
    pub fn groups(&self) -> &'static [(&'static str, &'static [&'static str])] {
        match self {
            SettingsSection::General => &[("输出行为", &["STREAM", "LLM_CACHE"])],
            SettingsSection::Capabilities => &[(
                "网络搜索",
                &[
                    smallest_agent_core::tools::web::BRAVE_KEY,
                    smallest_agent_core::tools::web::TAVILY_KEY,
                ],
            )],
            // 模型页的字段是**按厂商动态生成**的，不在这张静态表里 ——
            // 见 render_settings 里那个 Provider 分支。
            SettingsSection::Provider => &[],
            // 这一页不是表单 —— 编辑的是 JSON 文件
            SettingsSection::Agents => &[],
            SettingsSection::Retrieval => &[
                ("笔记来源", &["NOTES_DIR"]),
                ("嵌入模型", &["EMBEDDING_MODEL", "HF_ENDPOINT"]),
            ],
            SettingsSection::Advanced => &[
                // 这两个都是「让 agent 试到什么程度」，同一张卡。
                // 拆成两张一字段的卡会让四个字段占三张卡，版面比内容还多
                ("循环与重试", &["MAX_TURNS", "MAX_RETRIES"]),
                ("上下文压缩", &["MAX_CONTEXT_TOKENS", "KEEP_RECENT"]),
            ],
        }
    }


    pub fn icon(&self) -> gpui_component::IconName {
        use gpui_component::IconName;
        match self {
            SettingsSection::General => IconName::Settings,
            SettingsSection::Capabilities => IconName::SquareTerminal,
            SettingsSection::Provider => IconName::Globe,
            SettingsSection::Agents => IconName::Bot,
            SettingsSection::Retrieval => IconName::Search,
            SettingsSection::Advanced => IconName::Settings2,
        }
    }
}

/// 内容栏最大宽度。比对话区的 720 宽一点 —— 表单是两列（标签 + 输入框），
/// 挤在 720 里输入框会太窄。760 是 waku 的 SETTINGS_CONTENT_MAX_WIDTH。
const SETTINGS_MAX_WIDTH: f32 = 760.;


/// Agent 模式页：列出可用的 provider，说明它们的区别。
///
/// 和工具页一样不做成表单 —— 外部 CLI 的配置（命令、参数、环境变量）
/// 是从各家 README 粘过来的，表单会强迫用户把一行命令拆成几个输入框。
pub fn render_agents_page(
    options: &[crate::providers::ProviderOption],
    active_id: &str,
) -> impl IntoElement {
    let path = crate::providers::state_path_display();

    let mut list = div().flex().flex_col().gap(px(8.));
    for o in options {
        let is_active = o.id == active_id;
        list = list.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(10.))
                .bg(if is_active {
                    Tokens::surface()
                } else {
                    Tokens::inset()
                })
                .border_1()
                .border_color(Tokens::line())
                .p(px(12.))
                .child(
                    gpui_component::Icon::new(if o.external {
                        gpui_component::IconName::SquareTerminal
                    } else {
                        gpui_component::IconName::Bot
                    })
                    .size(px(14.))
                    .text_color(if is_active {
                        Tokens::accent()
                    } else {
                        Tokens::ink_3()
                    }),
                )
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(FontSize::sm())
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Tokens::ink())
                                .child(o.name.clone()),
                        )
                        .child(
                            div()
                                .text_size(FontSize::xxs())
                                .font_weight(FontWeight::NORMAL)
                                .text_color(Tokens::ink_3())
                                .child(if o.external {
                                    "外部 CLI。自带工具和权限模型，会话上下文由它维护。"
                                } else {
                                    "本仓库实现的 ReAct 循环。工具走 MCP，历史存本地。"
                                }),
                        ),
                )
                .when(is_active, |d| {
                    d.child(
                        div()
                            .rounded_full()
                            .bg(Tokens::accent_tint())
                            .px(px(8.))
                            .py(px(1.))
                            .text_size(FontSize::tiny())
                            .text_color(Tokens::accent_ink())
                            .child("当前会话"),
                    )
                }),
        );
    }

    div()
        .flex()
        .flex_col()
        .gap(px(14.))
        .child(
            div()
                .text_size(FontSize::sm())
                .text_color(Tokens::ink_2())
                .child("在对话框左下角切换当前会话用哪个 —— 每个会话可以不一样。"),
        )
        .child(list)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .rounded(px(10.))
                .bg(Tokens::inset())
                .border_1()
                .border_color(Tokens::line())
                .p(px(12.))
                .child(
                    div()
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::ink_3())
                        .child("配置文件"),
                )
                .child(
                    div()
                        .font_family(crate::assets::FONT_MONO)
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::ink_2())
                        .child(path),
                ),
        )
        .child(
            div()
                .text_size(FontSize::xxs())
                .font_weight(FontWeight::NORMAL)
                .text_color(Tokens::ink_3())
                .child(
                    "外部 CLI 首次启动要 npx 拉包（几十秒）且需要它自己的认证。\
                     改完配置重启应用生效。",
                ),
        )
}


/// 切「模型」页在看哪家厂商。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct SetActiveVendor {
    pub vendor_id: String,
}

/// 厂商选择器 + 已配数量 + 当前这家的端点。
///
/// 用 picker.rs 那个下拉而不是一排 tab：十项横排放不进 760 宽的内容栏，
/// 而下拉的选中态（底色 + 勾）已经在别处用着，观感一致。
fn render_vendor_picker<T: 'static>(form: &SettingsForm, cx: &mut Context<T>) -> impl IntoElement {
    // 先把输入框的当前值快照成一张表，再拿它当 vendors 那边的 Lookup。
    //
    // 不能直接传一个「去读输入框」的闭包：读输入框要借 cx，而下面渲染
    // 选择器又要可变借 cx，两次借用打架。快照一份是最省事的解法 ——
    // 这一页的字段就十几个。
    let values: BTreeMap<String, String> = form
        .inputs
        .iter()
        .map(|(k, i)| (k.clone(), i.read(cx).value().to_string()))
        .collect();
    let get = |k: &str| values.get(k).cloned();

    // 可选项 = 内置九家 + 自定义端点。
    //
    // 自定义端点**总是**在列，哪怕一个字都没填 —— 它是唯一能配它的地方，
    // 按「配好了才显示」的规则藏起来的话就永远配不上。
    let ids: Vec<&'static str> = vendors::ALL
        .iter()
        .map(|v| v.id)
        .chain(std::iter::once(vendors::CUSTOM_ID))
        .collect();

    let configured: Vec<&'static str> = ids
        .iter()
        .copied()
        .filter(|id| vendors::is_configured(id, &get))
        .filter_map(vendors::name_of)
        .collect();

    // 认不出当前 id（手改过 settings.json）就退回默认厂商，
    // 而不是显示一个空标签
    let current_id = if vendors::exists(&form.active_vendor) {
        form.active_vendor.clone()
    } else {
        vendors::DEFAULT_VENDOR.to_string()
    };
    let current_name = vendors::name_of(&current_id).unwrap_or_default();

    // 已配的在名字后面加个点，让「哪几家能用」不必逐个点开看
    let items = ids
        .iter()
        .copied()
        .map(|id| {
            let name = vendors::name_of(id).unwrap_or_default();
            let label = if vendors::is_configured(id, &get) {
                format!("{name} ·")
            } else {
                name.to_string()
            };
            crate::picker::PickerItem::new(id, label)
        })
        .collect();

    let summary = if configured.is_empty() {
        "还没配任何模型。填一把 API Key，或者用自定义端点指向本地 / 第三方服务。"
            .to_string()
    } else {
        format!("已配 {} 项：{}", configured.len(), configured.join("、"))
    };

    // 内置厂商的端点：只显示，不给编辑。
    //
    // 这一行替代了原来那个「API 端点」输入框。用户要知道这一家打的是哪个
    // 地址（排查网络问题时第一个要看的东西），但那个值不该是可改的 ——
    // 见 vendors.rs 文件头。自定义端点没有这一行，它的地址就是下面
    // 卡片里那一栏。
    let endpoint = vendors::find(&current_id).map(|v| v.base_url);

    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(FontSize::sm())
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Tokens::ink())
                        // 「提供方」而不是「厂商」：自定义端点不是一家厂商，
                        // 而这一栏现在两种东西都装
                        .child("提供方"),
                )
                .child(crate::picker::render_picker(
                    crate::picker::PickerTrigger {
                        id: "vendor-picker",
                        label: current_name.to_string(),
                        icon: None,
                    },
                    items,
                    current_id.clone(),
                    |_this: &mut T, id, window, cx| {
                        // 走 action 而不是直接改：这个函数是泛型的（T 可以是
                        // 任何宿主），拿不到 &mut ChatView 去改 SettingsForm。
                        window.dispatch_action(Box::new(SetActiveVendor { vendor_id: id }), cx);
                    },
                    cx,
                )),
        )
        .child(
            div()
                .text_size(FontSize::xxs())
                .font_weight(FontWeight::NORMAL)
                .text_color(if configured.is_empty() {
                    Tokens::orange()
                } else {
                    Tokens::ink_3()
                })
                .child(summary),
        )
        .when_some(endpoint, |d, base| {
            d.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(FontSize::xxs())
                    .font_weight(FontWeight::NORMAL)
                    .text_color(Tokens::ink_3())
                    .child("端点")
                    .child(
                        div()
                            .font_family(crate::assets::FONT_MONO)
                            .text_color(Tokens::ink_2())
                            .child(base),
                    )
                    .child("（固定，不可改）"),
            )
        })
}

/// 渲染设置页面的内容区（不含侧边栏，那个由 sidebar.rs 负责）。
///
/// 泛型在 T 上而不是绑死 ChatView：设置页只需要「能读到 SettingsForm、
/// 能派发保存」，不该依赖整个 ChatView。
///
/// 没有 on_save 回调 —— 设置是实时生效的，保存由 ChatView 订阅输入框的
/// Change 事件触发（见 chat.rs 的 open_settings）。
pub fn render_settings<T: 'static>(form: &SettingsForm, cx: &mut Context<T>) -> impl IntoElement {
    let mut fields = div()
        .id("settings-fields")
        .flex()
        .flex_col()
        .flex_1()
        .gap(px(18.))
        .overflow_y_scroll();

    // Agent 模式页不是表单：它列的是「有哪些引擎可选」，
    // 而那份清单来自 providers.json，穷举不出 env 字段来。
    //
    // 工具和技能以前也在这里，现在是独立页面了（见 pages.rs 文件头）。
    if form.section == SettingsSection::Agents {
        fields = fields.child(render_agents_page(
            &form.provider_options,
            &form.active_provider,
        ));
    }

    // 这一页要渲染哪些组。
    //
    // 多数页是静态的（groups() 那张表），**模型页是动态的** —— 它的字段
    // 由 vendors 那边推出来。写死会和那张表脱节。
    let groups: Vec<(String, Vec<String>)> = if form.section == SettingsSection::Provider {
        // 只渲染当前选中那一项的字段。
        //
        // 见 SettingsForm::active_vendor 的注释：铺开九家是第一版的做法，
        // 又卡又不符合任何同类软件的惯例。厂商选择器由 render_vendor_picker
        // 画在这批卡片上面。
        //
        // 内置厂商现在**只有一栏**（API Key）—— 端点那栏删了，固定值由
        // 选择器下面那行显示。自定义端点相反，三栏都要填。
        if form.active_vendor == vendors::CUSTOM_ID {
            vec![(
                format!("{} 配置", vendors::CUSTOM_NAME),
                vendors::CUSTOM_KEYS.iter().map(|k| k.to_string()).collect(),
            )]
        } else {
            match vendors::find(&form.active_vendor).or(vendors::ALL.first()) {
                Some(v) => vec![(format!("{} 凭据", v.name), vec![v.key_env.to_string()])],
                None => vec![],
            }
        }
    } else {
        form.section
            .groups()
            .iter()
            .map(|(name, keys)| {
                (
                    name.to_string(),
                    keys.iter().map(|k| k.to_string()).collect(),
                )
            })
            .collect()
    };

    // 厂商选择器 + 「已配几家」，放在凭据卡片上面。
    //
    // 「已配几家」是唯一能表达「至少配一家才能对话」这条要求的地方 ——
    // 它不是任何单个字段的属性，所以不能用必填星号表达（那会在九家里
    // 每家都标一个红星，而且是错的，填一家就够）。
    if form.section == SettingsSection::Provider {
        fields = fields.child(render_vendor_picker(form, cx));
    }

    // 表单字段：每组一张卡片。
    for (group_name, keys) in &groups {
        let mut rows = div().flex().flex_col();

        for (i, key) in keys.iter().enumerate() {
            let key = key.as_str();
            let Some(input) = form.inputs.get(key) else {
                continue;
            };

            // 左列：人话标题（+ 必填星号）→ 键名 → 说明。
            //
            // 三层字号递减（sm / tiny / xxs），靠层级而不是靠间距区分 ——
            // 一行标题一行小字是设置面板的通用形状（参考图、系统偏好设置
            // 都是这样），读的时候视线不用左右找对应关系。
            let mut left = div().flex().flex_col().gap(px(3.)).child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(FontSize::sm())
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Tokens::ink())
                            .child(if label(key).is_empty() {
                                key.to_string()
                            } else {
                                label(key)
                            }),
                    )
                    // 必填星号用 red 而不是 orange：它标的是「不填跑不起来」，
                    // 那是错误级别的后果，不是提醒
                    .when(REQUIRED.contains(&key), |d| {
                        d.child(
                            div()
                                .text_size(FontSize::sm())
                                .text_color(Tokens::red())
                                .child("*"),
                        )
                    }),
            );
            // 键名。等宽 + 最小字号 —— 它是给「想手改 settings.json 的人」
            // 看的，不该跟标题抢注意力。
            //
            // label() 兜底成空串时标题已经显示了键名，这里就不重复一遍
            if !label(key).is_empty() {
                left = left.child(
                    div()
                        .font_family(crate::assets::FONT_MONO)
                        .text_size(FontSize::tiny())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(Tokens::ink_3())
                        .child(key.to_string()),
                );
            }
            if let Some(h) = hint(key) {
                left = left.child(
                    div()
                        .text_size(FontSize::xxs())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(Tokens::ink_3())
                        .child(h),
                );
            }

            rows = rows.child(
                div()
                    .flex()
                    // items_start 而不是 center：左列可能有三行（标题 + 键名
                    // + 说明），居中会让输入框飘到中间，跟标题对不上
                    .items_start()
                    .gap(px(16.))
                    .py(px(12.))
                    // 组内分隔线，最后一行不画 —— 卡片自己的边界就是收尾
                    .when(i > 0, |d| d.border_t_1().border_color(Tokens::line()))
                    .child(left.flex_1().min_w_0())
                    // 输入框定宽而不是 flex_1：参考图里所有输入框右边缘
                    // 是对齐的，而 flex_1 会让它随左列文字长短伸缩，
                    // 一列输入框宽度参差不齐。
                    //
                    // 不加 .small()：默认尺寸的输入框高度够，small 在 13px
                    // 字号下只有 ~24px，光标和文字挤在一起看不清
                    .child(div().w(px(300.)).flex_none().child(Input::new(input))),
            );
        }

        fields = fields.child(
            div()
                .flex()
                .flex_col()
                .rounded(px(12.))
                .bg(Tokens::surface())
                .border_1()
                .border_color(Tokens::line_strong())
                .px(px(16.))
                .py(px(4.))
                .child(
                    // 卡片头。参考图那种「小号、灰、加粗」的分组标签 ——
                    // gpui 没有 letter-spacing，所以不做大写字距，
                    // 靠字号和字重区分层级。
                    div()
                        .flex()
                        .items_center()
                        .h(px(34.))
                        .flex_none()
                        .text_size(FontSize::tiny())
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(Tokens::ink_3())
                        .child(group_name.clone()),
                )
                .child(rows),
        );
    }

    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        // 顶部给红绿灯让位，和对话区对齐
        .child(div().h(px(32.)).flex_none())
        .child(
            div()
                .flex()
                .flex_1()
                .min_h_0()
                .justify_center()
                .px_5()
                .child(
                    div()
                        .w_full()
                        .max_w(px(SETTINGS_MAX_WIDTH))
                        .flex()
                        .flex_col()
                        .min_h_0()
                        .child(
                            div()
                                .flex_none()
                                .pb(px(18.))
                                .text_size(px(18.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(form.section.label()),
                        )
                        .child(fields),
                ),
        )
        // 底栏只有状态提示，没有保存按钮 —— 改动是实时存的。
        //
        // 去掉保存按钮的理由：桌面应用的设置面板几乎都是即时生效
        // （系统偏好设置、VS Code、Chrome 都是），有个保存按钮反而让人
        // 不确定「我改了没点保存是不是白改了」。
        //
        // 实现在 ChatView 那侧：订阅每个输入框的 Change 事件，
        // 变了就写盘。见 chat.rs 的 open_settings。
        .when(form.note.is_some(), |d| {
            d.child(
                div()
                    .flex()
                    .flex_none()
                    .justify_center()
                    .px_5()
                    .pb(px(18.))
                    .pt(px(12.))
                    .child(
                        div()
                            .w_full()
                            .max_w(px(SETTINGS_MAX_WIDTH))
                            .rounded(px(12.))
                            .bg(Tokens::surface())
                            .border_1()
                            .border_color(Tokens::line_strong())
                            .px(px(14.))
                            .py(px(10.))
                            .text_size(FontSize::xxs())
                            .font_weight(FontWeight::NORMAL)
                            .text_color(Tokens::ink_3())
                            .child(form.note.clone().unwrap_or_default()),
                    ),
            )
        })
}
