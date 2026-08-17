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
use gpui::*;
use gpui_component::input::{Input, InputState};
use gpui_component::{Sizable as _, button::*};

use crate::theme::{FontSize, Tokens, shadow_card};

/// 可配置的字段。顺序即分区内的显示顺序。
pub const SETTING_KEYS: &[&str] = &[
    "STREAM",
    "LLM_CACHE",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "FALLBACK_MODEL",
    "NOTES_DIR",
    "EMBEDDING_MODEL",
    "HF_ENDPOINT",
    "MAX_RETRIES",
    "MAX_TURNS",
    "MAX_CONTEXT_TOKENS",
    "KEEP_RECENT",
];

/// 每个字段的说明，逐条抄自 Electron 版的 HINTS。
fn hint(key: &str) -> Option<&'static str> {
    Some(match key {
        // 明文存储是一条真实的安全披露，挂在用户实际填 key 的这栏下面
        "DEEPSEEK_API_KEY" => "以明文存在本地配置文件，不加密",
        "DEEPSEEK_BASE_URL" => "默认 https://api.deepseek.com/v1",
        "DEEPSEEK_MODEL" => "默认 deepseek-chat",
        "FALLBACK_MODEL" => "主模型连续失败时切换的备用模型",
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
    })
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
}

impl SettingsForm {
    pub fn new(window: &mut Window, cx: &mut App) -> Self {
        let stored = load_settings();
        let mut inputs = BTreeMap::new();
        for key in SETTING_KEYS {
            let value = stored.get(*key).cloned().unwrap_or_default();
            let is_secret = *key == "DEEPSEEK_API_KEY";
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
        }
    }

    /// 收集当前值，空字段不写进文件（让它回落到默认值）。
    fn collect(&self, cx: &App) -> BTreeMap<String, String> {
        self.inputs
            .iter()
            .map(|(k, input)| (k.clone(), input.read(cx).value().to_string()))
            .filter(|(_, v)| !v.trim().is_empty())
            .collect()
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
                // 基线不推到当前值：提示要留着，语义从「你改了」变成「重启才生效」
                self.note = Some(if self.needs_restart(cx) {
                    "已保存。笔记目录 / 嵌入模型的改动要重启应用才生效。".into()
                } else {
                    "已保存。下一轮对话生效。".into()
                });
            }
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
    Provider,
    /// 工具（MCP server）。不是表单 —— 它编辑的是一个 JSON 文件，
    /// 字段结构由每个 server 自己决定，穷举不出表单来。
    Tools,
    Retrieval,
    Advanced,
}

impl SettingsSection {
    pub const ALL: [SettingsSection; 5] = [
        SettingsSection::General,
        SettingsSection::Provider,
        SettingsSection::Tools,
        SettingsSection::Retrieval,
        SettingsSection::Advanced,
    ];

    pub fn label(&self) -> &'static str {
        match self {
            SettingsSection::General => "通用",
            SettingsSection::Provider => "Provider",
            SettingsSection::Tools => "工具",
            SettingsSection::Retrieval => "检索",
            SettingsSection::Advanced => "高级",
        }
    }

    pub fn keys(&self) -> &'static [&'static str] {
        match self {
            SettingsSection::General => &["STREAM", "LLM_CACHE"],
            SettingsSection::Provider => &[
                "DEEPSEEK_API_KEY",
                "DEEPSEEK_BASE_URL",
                "DEEPSEEK_MODEL",
                "FALLBACK_MODEL",
            ],
            // 工具页不是表单，没有 env 字段
            SettingsSection::Tools => &[],
            SettingsSection::Retrieval => &["NOTES_DIR", "EMBEDDING_MODEL", "HF_ENDPOINT"],
            SettingsSection::Advanced => &[
                "MAX_RETRIES",
                "MAX_TURNS",
                "MAX_CONTEXT_TOKENS",
                "KEEP_RECENT",
            ],
        }
    }

    pub fn icon(&self) -> gpui_component::IconName {
        use gpui_component::IconName;
        match self {
            SettingsSection::General => IconName::Settings,
            SettingsSection::Provider => IconName::Bot,
            SettingsSection::Tools => IconName::SquareTerminal,
            SettingsSection::Retrieval => IconName::Search,
            SettingsSection::Advanced => IconName::Settings2,
        }
    }
}

/// 内容栏最大宽度。比对话区的 720 宽一点 —— 表单是两列（标签 + 输入框），
/// 挤在 720 里输入框会太窄。760 是 waku 的 SETTINGS_CONTENT_MAX_WIDTH。
const SETTINGS_MAX_WIDTH: f32 = 760.;

/// 工具页的内容。
///
/// 不做成表单：MCP server 的配置字段（args、env）每个 server 都不一样，
/// 而且用户通常是从别处（Claude Desktop 的配置、server 的 README）
/// **粘贴**过来的。表单会强迫他把一段 JSON 拆成一堆输入框再拼回去。
///
/// 所以这里做两件事：显示当前状态 + 一个按钮打开配置文件所在目录。
/// 编辑交给用户自己的编辑器 —— 那儿有 JSON 语法高亮和括号匹配，
/// 我们做不到也不该重做。
pub fn render_tools_page<T: 'static>(
    status_line: String,
    tool_names: &[String],
    cx: &mut Context<T>,
) -> impl IntoElement {
    let path = smallest_agent_core::mcp_config::config_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "(路径不可用)".into());
    let reveal_path = path.clone();

    let mut body = div()
        .flex()
        .flex_col()
        .gap(px(14.))
        .child(
            div()
                .text_size(FontSize::sm())
                .text_color(Tokens::ink_2())
                .child(status_line),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .rounded(px(10.))
                .bg(Tokens::inset())
                .shadow(shadow_card())
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
                )
                .child(
                    div().pt(px(4.)).child(
                        Button::new("reveal-mcp")
                            .small()
                            .label("在 Finder 中显示")
                            .on_click(move |_, _window, cx| {
                                // 没有这个文件时先写一份示例进去，否则「在 Finder
                                // 中显示」会打开一个空目录，用户不知道该建什么名字的文件
                                let p = std::path::PathBuf::from(&reveal_path);
                                if !p.exists() {
                                    let _ = smallest_agent_core::mcp_config::save_config(
                                        &smallest_agent_core::mcp_config::example_config(),
                                    );
                                }
                                cx.reveal_path(&p);
                            }),
                    ),
                ),
        )
        .child(
            div()
                .text_size(FontSize::xxs())
                .font_weight(FontWeight::NORMAL)
                .text_color(Tokens::ink_3())
                .child(
                    "格式和 Claude Desktop / Cursor 一致，配置可以直接粘过来。改完重启应用生效。",
                ),
        );

    if !tool_names.is_empty() {
        let mut list = div().flex().flex_col().gap(px(3.));
        for name in tool_names {
            list = list.child(
                div()
                    .font_family(crate::assets::FONT_MONO)
                    .text_size(FontSize::xxs())
                    .text_color(Tokens::ink_2())
                    .child(name.clone()),
            );
        }
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .pt(px(4.))
                .child(
                    div()
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::ink_3())
                        .child("已发现的工具"),
                )
                .child(list),
        );
    }

    let _ = cx;
    body
}

/// 渲染设置页面的内容区（不含侧边栏，那个由 sidebar.rs 负责）。
///
/// 泛型在 T 上而不是绑死 ChatView：设置页只需要「能读到 SettingsForm、
/// 能派发保存」，不该依赖整个 ChatView。
pub fn render_settings<T: 'static>(
    form: &SettingsForm,
    on_save: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static,
    cx: &mut Context<T>,
) -> impl IntoElement {
    let mut fields = div()
        .id("settings-fields")
        .flex()
        .flex_col()
        .flex_1()
        .gap(px(18.))
        .overflow_y_scroll();

    if form.section == SettingsSection::Tools {
        fields = fields.child(render_tools_page(
            form.tools_status_line.clone(),
            &form.tool_names,
            cx,
        ));
    }

    for key in form.section.keys() {
        let Some(input) = form.inputs.get(*key) else {
            continue;
        };
        let mut field = div().flex().flex_col().gap(px(6.)).child(
            div()
                .text_size(FontSize::sm())
                .font_weight(FontWeight::MEDIUM)
                .text_color(Tokens::ink())
                .child(*key),
        );
        field = field.child(Input::new(input).small());
        if let Some(h) = hint(key) {
            field = field.child(
                div()
                    .text_size(FontSize::xxs())
                    .font_weight(FontWeight::NORMAL)
                    .text_color(Tokens::ink_3())
                    .child(h),
            );
        }
        fields = fields.child(field);
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
        // 底栏：保存 + 反馈
        .child(
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
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap_3()
                        .rounded(px(12.))
                        .bg(Tokens::surface())
                        .shadow(shadow_card())
                        .px(px(14.))
                        .py(px(10.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(FontSize::xxs())
                                .font_weight(FontWeight::NORMAL)
                                .text_color(Tokens::ink_3())
                                .child(form.note.clone().unwrap_or_default()),
                        )
                        .child(
                            Button::new("save-settings")
                                .primary()
                                .small()
                                .label("保存")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    on_save(this, window, cx)
                                })),
                        ),
                ),
        )
}
