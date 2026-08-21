// ============================================================================
// pages.rs —— 内容区里的独立页面（工具 / 技能 / Agent / 自动化）
// ----------------------------------------------------------------------------
// 这四个页面和对话并列，不是设置的子页 —— 理由见 pane.rs 的文件头。
//
// ## 共用一个外壳
//
// 四个页面的骨架完全一样：顶部留红绿灯位 → 标题 + 右上角动作 → 居中定宽的
// 内容列。抽成 `shell()` 而不是各写一遍，因为「标题多大、内容多宽、顶部留
// 多少」这类值改一次要改四处，漏一处就视觉不齐。
//
// ## 编辑器为什么是「选中一项、下面展开」而不是弹窗
//
// 弹窗要处理焦点、Esc、点外面关不关、以及「没存就关了怎么办」。而这两个页面
// 的编辑是实时保存的（和设置页一样），所以「关闭」这个动作本身不存在 ——
// 没有要丢弃的草稿。那弹窗就只剩下坏处。
// ============================================================================

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::input::{Input, InputState, Textarea, TextareaState};
use gpui_component::{Sizable as _, button::*};
use smallest_agent_core::agents::{AgentDef, AgentsState};
use smallest_agent_core::automations::{Automation, AutomationsState};
use smallest_agent_core::{agents, automations, vendors};

use crate::picker;
use crate::theme::{FontSize, Tokens};

/// 内容栏宽度。和设置页一致（760）—— 两者都是「表单 + 列表」，
/// 宽度不同会让在两者间切换时版面跳一下。
const MAX_WIDTH: f32 = 760.;

// ============================================================================
// 编辑器状态
// ============================================================================

/// 正在编辑的 agent。
///
/// 每个字段一个输入框实体。id 记着改的是谁 —— 不能靠「列表里第几个」，
/// 因为删除会让下标错位。
pub struct AgentEditor {
    pub id: String,
    pub name: Entity<InputState>,
    pub description: Entity<InputState>,
    pub prompt: Entity<TextareaState>,
    /// 工具白名单，逗号分隔。
    ///
    /// 用一个文本框而不是九十个复选框：工具清单是动态的（MCP 连上才知道
    /// 有哪些），而且多数 agent 不限制工具。留空 = 全部可用。
    pub tools: Entity<InputState>,
}

impl AgentEditor {
    pub fn new(def: &AgentDef, window: &mut Window, cx: &mut App) -> Self {
        let name = def.name.clone();
        let description = def.description.clone();
        let prompt = def.system_prompt.clone();
        let tools = def.tools.join(", ");
        Self {
            id: def.id.clone(),
            name: cx.new(|cx| InputState::new(window, cx).default_value(name)),
            description: cx.new(|cx| {
                InputState::new(window, cx)
                    .default_value(description)
                    .placeholder("一句话说明它是干什么的")
            }),
            prompt: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .default_value(prompt)
                    .placeholder("系统提示。留空则用全局的那个。")
                    // 系统提示是这个页面的主要内容，给它更大的空间
                    .auto_grow(6, 20)
            }),
            tools: cx.new(|cx| {
                InputState::new(window, cx)
                    .default_value(tools)
                    .placeholder("留空 = 全部工具可用")
            }),
        }
    }

    /// 把输入框里的值写回定义。
    pub fn collect_into(&self, def: &mut AgentDef, cx: &App) {
        def.name = self.name.read(cx).value().to_string();
        def.description = self.description.read(cx).value().to_string();
        def.system_prompt = self.prompt.read(cx).value().to_string();
        def.tools = self
            .tools
            .read(cx)
            .value()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
}

/// 正在编辑的自动化。
pub struct AutomationEditor {
    pub id: String,
    pub name: Entity<InputState>,
    pub prompt: Entity<TextareaState>,
    pub interval: Entity<InputState>,
}

impl AutomationEditor {
    pub fn new(item: &Automation, window: &mut Window, cx: &mut App) -> Self {
        let name = item.name.clone();
        let prompt = item.prompt.clone();
        let interval = item.interval_minutes.to_string();
        Self {
            id: item.id.clone(),
            name: cx.new(|cx| InputState::new(window, cx).default_value(name)),
            prompt: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .default_value(prompt)
                    .placeholder("到点了要问的话")
                    .auto_grow(4, 14)
            }),
            interval: cx.new(|cx| InputState::new(window, cx).default_value(interval)),
        }
    }

    pub fn collect_into(&self, item: &mut Automation, cx: &App) {
        item.name = self.name.read(cx).value().to_string();
        item.prompt = self.prompt.read(cx).value().to_string();
        // 解析失败就保留原值 —— 用户正在打字时会短暂出现空串或 "1x"，
        // 那时候把间隔清成 0 会让 is_due 的下限保护成为常态
        if let Ok(n) = self.interval.read(cx).value().trim().parse::<u32>() {
            item.interval_minutes = n;
        }
    }
}

/// 这两个页面的全部状态。
///
/// 放在一个结构体里而不是散在 ChatView 上：它们一起加载、一起落盘，
/// 而 ChatView 已经有十几个字段了。
pub struct PagesState {
    pub agents: AgentsState,
    pub automations: AutomationsState,
    pub agent_editor: Option<AgentEditor>,
    pub automation_editor: Option<AutomationEditor>,
    /// 发现到的技能。
    ///
    /// 启动时扫一次（不是每帧扫）—— discover 要读几个目录、每个技能读一个
    /// 文件，放在 render 里会让滚动掉帧。
    ///
    /// ## 为什么在这里，而不在 SettingsForm 上（原来在那儿）
    ///
    /// 那是个实测出来的 bug：技能页现在是**侧边栏直达**的独立页面，
    /// 而 `settings` 是 `Option` —— 没打开过设置时它是 None。
    /// 状态挂在它上面的话，「停用 / 启用」那个按钮的 handler 里
    /// `if let Some(form) = &mut this.settings` 直接落空，**点了没反应**。
    ///
    /// PagesState 是无条件加载的，所以挪到这儿之后那条通路不再依赖
    /// 「用户有没有先去过设置」。
    pub skills: Vec<smallest_agent_core::skills::Skill>,
    /// 被停用的技能名。改了立即落盘 —— 这些页面都没有保存按钮。
    pub disabled_skills: smallest_agent_core::skills::DisabledSkills,
}

impl PagesState {
    pub fn load() -> Self {
        Self {
            agents: agents::load(),
            automations: automations::load(),
            agent_editor: None,
            automation_editor: None,
            // cwd 决定能不能发现项目级技能（.claude/skills）—— 双击启动时
            // cwd 是 /，那时候只有用户级的，这是对的：那种启动方式下
            // 「当前项目」这个概念本来就不存在。
            skills: smallest_agent_core::skills::discover(
                &std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")),
            ),
            disabled_skills: smallest_agent_core::skills::load_disabled(),
        }
    }

    /// 开关一个技能，立即落盘。
    ///
    /// 存的是「停用哪些」而不是「启用哪些」，见 skills_body 的注释。
    ///
    /// 落盘失败只记一行（同 save_agents）。代价说清楚：那种情况下开关在
    /// 界面上生效了、但重启会回到原样。这里没有 note 那样的反馈位，
    /// 而为一个几百字节的写失败加一条通路不值得 —— 真正会失败的原因
    /// （配置目录不可写）会让别的设置也一起坏，用户会先从那儿发现。
    pub fn toggle_skill(&mut self, name: &str) {
        if self.disabled_skills.contains(name) {
            self.disabled_skills.remove(name);
        } else {
            self.disabled_skills.insert(name.to_string());
        }
        if let Err(err) = smallest_agent_core::skills::save_disabled(&self.disabled_skills) {
            eprintln!("[skills] 保存停用列表失败：{err:#}");
        }
    }

    /// 落盘。失败只记一行 —— 和 projects / providers 一致，
    /// 这些是便利功能，写不进去不该打断对话。
    pub fn save_agents(&self) {
        if let Err(err) = agents::save(&self.agents) {
            eprintln!("[agents] 保存失败：{err:#}");
        }
    }

    pub fn save_automations(&self) {
        if let Err(err) = automations::save(&self.automations) {
            eprintln!("[automations] 保存失败：{err:#}");
        }
    }
}

// ============================================================================
// 动作
// ============================================================================

/// 新建一个 agent。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct NewAgent;

/// 选中一个 agent 开始编辑。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct EditAgent {
    pub id: String,
}

#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct DeleteAgent {
    pub id: String,
}

#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct ToggleAgent {
    pub id: String,
}

/// 改 agent 用的模型。值的形状是 `厂商id/模型id`，空串表示「跟着会话」。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct SetAgentModel {
    pub id: String,
    pub model: String,
}

#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct NewAutomation;

#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct EditAutomation {
    pub id: String,
}

#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct DeleteAutomation {
    pub id: String,
}

#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct ToggleAutomation {
    pub id: String,
}

/// 立刻跑一次。
///
/// 有这个按钮是因为自动化的反馈周期可能是一小时 —— 没有它，用户改完提示词
/// 要等到下次触发才知道写得对不对。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct RunAutomation {
    pub id: String,
}

/// 给自动化绑一个 agent。空串 = 不用。
#[derive(Clone, PartialEq, Eq, gpui::Action)]
#[action(namespace = smallest_agent, no_json)]
pub struct SetAutomationAgent {
    pub id: String,
    pub agent_id: String,
}

// ============================================================================
// 外壳
// ============================================================================

/// 页面外壳：顶部留位 → 标题行（可带右上角动作）→ 居中定宽内容。
pub fn shell(
    title: &'static str,
    subtitle: impl Into<String>,
    action: Option<AnyElement>,
    body: AnyElement,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        // 顶部给红绿灯让位，和对话区、设置页对齐
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
                        .max_w(px(MAX_WIDTH))
                        .flex()
                        .flex_col()
                        .min_h_0()
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .items_start()
                                .justify_between()
                                .gap(px(12.))
                                .pb(px(16.))
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.))
                                        .child(
                                            div()
                                                .text_size(px(18.))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child(title),
                                        )
                                        .child(
                                            div()
                                                .text_size(FontSize::xxs())
                                                .font_weight(FontWeight::NORMAL)
                                                .text_color(Tokens::ink_3())
                                                .child(subtitle.into()),
                                        ),
                                )
                                .children(action),
                        )
                        .child(
                            div()
                                .id("page-body")
                                .flex()
                                .flex_col()
                                .flex_1()
                                .gap(px(12.))
                                .overflow_y_scroll()
                                .child(body),
                        ),
                ),
        )
        .into_any_element()
}

/// 一张卡片。四个页面里所有「一块内容」都用它，保证圆角/底色/内边距一致。
fn card() -> Div {
    div()
        .flex()
        .flex_col()
        .w_full()
        .rounded(px(12.))
        .bg(Tokens::surface())
        .border_1()
        .border_color(Tokens::line_strong())
        .px(px(16.))
        .py(px(14.))
}

/// 编辑器里的一行：左边标签 + 说明，右边控件。和设置页同一个形状。
fn field(label: &'static str, hint: &'static str, control: AnyElement) -> Div {
    div()
        .flex()
        .items_start()
        .gap(px(16.))
        .py(px(10.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(3.))
                .child(
                    div()
                        .text_size(FontSize::sm())
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Tokens::ink())
                        .child(label),
                )
                .when(!hint.is_empty(), |d| {
                    d.child(
                        div()
                            .text_size(FontSize::xxs())
                            .font_weight(FontWeight::NORMAL)
                            .text_color(Tokens::ink_3())
                            .child(hint),
                    )
                }),
        )
        .child(div().w(px(300.)).flex_none().child(control))
}

/// 一个开关样式的小徽章（启用 / 停用）。
fn state_badge(on: bool) -> Div {
    div()
        .rounded_full()
        .px(px(8.))
        .py(px(1.))
        .text_size(FontSize::tiny())
        .when(on, |d| {
            d.bg(Tokens::green_tint()).text_color(Tokens::green())
        })
        .when(!on, |d| {
            d.bg(Tokens::hover()).text_color(Tokens::ink_3())
        })
        .child(if on { "启用" } else { "停用" })
}

// ============================================================================
// Agent 页
// ============================================================================

pub fn render_agents_page<T: 'static>(
    state: &PagesState,
    catalog: &[vendors::VendorEntry],
    cx: &mut Context<T>,
) -> AnyElement {
    let new_button = Button::new("new-agent")
        .small()
        .label("新建 Agent")
        .on_click(|_, window, cx| window.dispatch_action(Box::new(NewAgent), cx))
        .into_any_element();

    let mut body = div().flex().flex_col().gap(px(12.));

    if state.agents.agents.is_empty() {
        body = body.child(card().child(
            div()
                .text_size(FontSize::sm())
                .text_color(Tokens::ink_2())
                .child(
                    "还没有自定义 Agent。一个 Agent 就是一套预设：\
                     系统提示 + 用哪个模型 + 能用哪些工具。\
                     建好之后在对话框左下角选它。",
                ),
        ));
    }

    for a in &state.agents.agents {
        let editing = state
            .agent_editor
            .as_ref()
            .is_some_and(|e| e.id == a.id);
        let id = a.id.clone();

        let mut c = card().child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .text_size(FontSize::sm())
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(if a.disabled {
                                            Tokens::ink_3()
                                        } else {
                                            Tokens::ink()
                                        })
                                        .child(if a.name.trim().is_empty() {
                                            "(未命名)".to_string()
                                        } else {
                                            a.name.clone()
                                        }),
                                )
                                .child(state_badge(!a.disabled)),
                        )
                        .when(!a.description.trim().is_empty(), |d| {
                            d.child(
                                div()
                                    .text_size(FontSize::xxs())
                                    .font_weight(FontWeight::NORMAL)
                                    .text_color(Tokens::ink_3())
                                    .child(a.description.clone()),
                            )
                        }),
                )
                .child({
                    let id = id.clone();
                    Button::new(SharedString::from(format!("edit-agent-{id}")))
                        .small()
                        .label(if editing { "收起" } else { "编辑" })
                        .on_click(move |_, window, cx| {
                            // 再点一次收起：编辑器是实时保存的，所以「收起」
                            // 不需要确认，也没有草稿要丢
                            window.dispatch_action(Box::new(EditAgent { id: id.clone() }), cx)
                        })
                })
                .child({
                    let id = id.clone();
                    Button::new(SharedString::from(format!("toggle-agent-{id}")))
                        .small()
                        .label(if a.disabled { "启用" } else { "停用" })
                        .on_click(move |_, window, cx| {
                            window.dispatch_action(Box::new(ToggleAgent { id: id.clone() }), cx)
                        })
                }),
        );

        if editing
            && let Some(ed) = &state.agent_editor
        {
            c = c.child(render_agent_editor(a, ed, catalog, cx));
        }

        body = body.child(c);
    }

    body = body.child(
        div()
            .text_size(FontSize::xxs())
            .font_weight(FontWeight::NORMAL)
            .text_color(Tokens::ink_3())
            .child(format!("配置文件：{}", agents::state_path_display())),
    );

    shell(
        "Agent",
        "自定义预设：系统提示、模型、可用工具。改动实时保存。",
        Some(new_button),
        body.into_any_element(),
    )
}

fn render_agent_editor<T: 'static>(
    def: &AgentDef,
    ed: &AgentEditor,
    catalog: &[vendors::VendorEntry],
    cx: &mut Context<T>,
) -> AnyElement {
    let id = def.id.clone();

    // 模型：复用 composer 那个选择器，多一个「跟着会话」的选项。
    //
    // 有那个选项是因为多数 agent 只是换说话方式，钉死模型反而碍事 ——
    // 用户在会话里换了模型，agent 却把它拽回去。
    // 清单来自 catalog 而不是 vendors::ALL —— 自定义端点的模型也要能钉，
    // 不然「本地模型专用 agent」这个组合表达不出来。
    let mut items = vec![picker::PickerItem::new("", "跟着会话选的模型")];
    for e in catalog {
        for m in &e.models {
            items.push(
                picker::PickerItem::new(format!("{}/{}", e.id, m.id), m.name.clone())
                    .group(e.name.clone()),
            );
        }
    }
    let current_label = if def.model.trim().is_empty() {
        "跟着会话选的模型".to_string()
    } else {
        def.model
            .split_once('/')
            .and_then(|(vid, mid)| {
                catalog
                    .iter()
                    .filter(|e| e.id == vid)
                    .flat_map(|e| e.models.iter())
                    .find(|m| m.id == mid)
                    .map(|m| m.name.clone())
            })
            .unwrap_or_else(|| def.model.clone())
    };

    let model_picker = {
        let id = id.clone();
        picker::render_picker(
            picker::PickerTrigger {
                id: "agent-model-picker",
                label: current_label,
                icon: None,
            },
            items,
            def.model.clone(),
            move |this: &mut T, model, window, cx| {
                // 走 action 而不是直接改：这个函数是泛型的，拿不到具体宿主。
                // dispatch 之后由 ChatView 的 on_action 处理。
                let _ = this;
                window.dispatch_action(
                    Box::new(SetAgentModel {
                        id: id.clone(),
                        model,
                    }),
                    cx,
                );
            },
            cx,
        )
    };

    div()
        .flex()
        .flex_col()
        .pt(px(10.))
        .mt(px(10.))
        .border_t_1()
        .border_color(Tokens::line())
        .child(field(
            "名称",
            "",
            Input::new(&ed.name).into_any_element(),
        ))
        .child(
            div()
                .border_t_1()
                .border_color(Tokens::line())
                .child(field(
                    "说明",
                    "只给你自己看，不发给模型",
                    Input::new(&ed.description).into_any_element(),
                )),
        )
        .child(
            div()
                .border_t_1()
                .border_color(Tokens::line())
                .child(field("模型", "", model_picker)),
        )
        .child(
            div()
                .border_t_1()
                .border_color(Tokens::line())
                .child(field(
                    "可用工具",
                    "逗号分隔的工具名。留空 = 全部可用。",
                    Input::new(&ed.tools).into_any_element(),
                )),
        )
        // 系统提示单独一段：它是多行的，塞进两列布局里右边那 300px 太窄
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .pt(px(12.))
                .mt(px(2.))
                .border_t_1()
                .border_color(Tokens::line())
                .child(
                    div()
                        .text_size(FontSize::sm())
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Tokens::ink())
                        .child("系统提示"),
                )
                .child(
                    div()
                        .text_size(FontSize::xxs())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(Tokens::ink_3())
                        .child("留空则用全局那条。这是决定 Agent 行为的主要地方。"),
                )
                .child(Textarea::new(&ed.prompt)),
        )
        .child(
            div().flex().justify_end().pt(px(12.)).child(
                Button::new(SharedString::from(format!("del-agent-{id}")))
                    .small()
                    .danger()
                    .label("删除这个 Agent")
                    .on_click(move |_, window, cx| {
                        window.dispatch_action(Box::new(DeleteAgent { id: id.clone() }), cx)
                    }),
            ),
        )
        .into_any_element()
}

// ============================================================================
// 自动化页
// ============================================================================

pub fn render_automations_page<T: 'static>(
    state: &PagesState,
    cx: &mut Context<T>,
) -> AnyElement {
    let new_button = Button::new("new-automation")
        .small()
        .label("新建自动化")
        .on_click(|_, window, cx| window.dispatch_action(Box::new(NewAutomation), cx))
        .into_any_element();

    let mut body = div().flex().flex_col().gap(px(12.));

    if state.automations.items.is_empty() {
        body = body.child(card().child(
            div()
                .text_size(FontSize::sm())
                .text_color(Tokens::ink_2())
                .child(
                    "还没有自动化。一条自动化就是「每隔多久，自动问一句话」——\
                     比如每天汇总一次进展。它只在应用开着的时候触发。",
                ),
        ));
    }

    let now = automations::now_millis();
    for item in &state.automations.items {
        let editing = state
            .automation_editor
            .as_ref()
            .is_some_and(|e| e.id == item.id);
        let id = item.id.clone();

        // 状态行：说清楚「下次什么时候」。自动化的反馈周期长，
        // 不显示这个的话用户没法判断它到底有没有在工作。
        let status = if item.disabled {
            "已停用".to_string()
        } else if item.last_run == 0 {
            format!("每 {} 分钟；等下一个周期开始", item.interval_minutes)
        } else {
            match item.until_next(now) {
                Some(0) => format!("每 {} 分钟；即将触发", item.interval_minutes),
                Some(ms) => format!(
                    "每 {} 分钟；约 {} 分钟后触发",
                    item.interval_minutes,
                    (ms / 60_000).max(1)
                ),
                None => format!("每 {} 分钟", item.interval_minutes),
            }
        };

        let mut c = card().child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .text_size(FontSize::sm())
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(if item.disabled {
                                            Tokens::ink_3()
                                        } else {
                                            Tokens::ink()
                                        })
                                        .child(if item.name.trim().is_empty() {
                                            "(未命名)".to_string()
                                        } else {
                                            item.name.clone()
                                        }),
                                )
                                .child(state_badge(!item.disabled)),
                        )
                        .child(
                            div()
                                .text_size(FontSize::xxs())
                                .font_weight(FontWeight::NORMAL)
                                .text_color(Tokens::ink_3())
                                .child(status),
                        ),
                )
                .child({
                    let id = id.clone();
                    Button::new(SharedString::from(format!("run-auto-{id}")))
                        .small()
                        .label("立刻跑")
                        .on_click(move |_, window, cx| {
                            window.dispatch_action(Box::new(RunAutomation { id: id.clone() }), cx)
                        })
                })
                .child({
                    let id = id.clone();
                    Button::new(SharedString::from(format!("edit-auto-{id}")))
                        .small()
                        .label(if editing { "收起" } else { "编辑" })
                        .on_click(move |_, window, cx| {
                            window.dispatch_action(Box::new(EditAutomation { id: id.clone() }), cx)
                        })
                })
                .child({
                    let id = id.clone();
                    Button::new(SharedString::from(format!("toggle-auto-{id}")))
                        .small()
                        .label(if item.disabled { "启用" } else { "停用" })
                        .on_click(move |_, window, cx| {
                            window
                                .dispatch_action(Box::new(ToggleAutomation { id: id.clone() }), cx)
                        })
                }),
        );

        if editing
            && let Some(ed) = &state.automation_editor
        {
            c = c.child(render_automation_editor(item, ed, &state.agents, cx));
        }

        body = body.child(c);
    }

    body = body.child(
        div()
            .text_size(FontSize::xxs())
            .font_weight(FontWeight::NORMAL)
            .text_color(Tokens::ink_3())
            .child(format!(
                "配置文件：{}。注意：只在应用开着时触发，关掉期间不会补跑。",
                automations::state_path_display()
            )),
    );

    shell(
        "自动化",
        "定时自动发一轮对话。改动实时保存。",
        Some(new_button),
        body.into_any_element(),
    )
}

fn render_automation_editor<T: 'static>(
    item: &Automation,
    ed: &AutomationEditor,
    agents_state: &AgentsState,
    cx: &mut Context<T>,
) -> AnyElement {
    let id = item.id.clone();

    // 用哪个 agent。空选项在最前 —— 「不用」是默认值。
    let mut items = vec![picker::PickerItem::new("", "不用 Agent")];
    for a in &agents_state.agents {
        items.push(picker::PickerItem::new(a.id.clone(), a.name.clone()));
    }
    let current_label = agents_state
        .find(&item.agent_id)
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "不用 Agent".to_string());

    let agent_picker = {
        let id = id.clone();
        picker::render_picker(
            picker::PickerTrigger {
                id: "automation-agent-picker",
                label: current_label,
                icon: None,
            },
            items,
            item.agent_id.clone(),
            move |this: &mut T, agent_id, window, cx| {
                let _ = this;
                window.dispatch_action(
                    Box::new(SetAutomationAgent {
                        id: id.clone(),
                        agent_id,
                    }),
                    cx,
                );
            },
            cx,
        )
    };

    div()
        .flex()
        .flex_col()
        .pt(px(10.))
        .mt(px(10.))
        .border_t_1()
        .border_color(Tokens::line())
        .child(field("名称", "", Input::new(&ed.name).into_any_element()))
        .child(
            div()
                .border_t_1()
                .border_color(Tokens::line())
                .child(field(
                    "间隔（分钟）",
                    "最小 1 分钟。这是会花钱的操作，别设太密。",
                    Input::new(&ed.interval).into_any_element(),
                )),
        )
        .child(
            div()
                .border_t_1()
                .border_color(Tokens::line())
                .child(field("用哪个 Agent", "", agent_picker)),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .pt(px(12.))
                .mt(px(2.))
                .border_t_1()
                .border_color(Tokens::line())
                .child(
                    div()
                        .text_size(FontSize::sm())
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Tokens::ink())
                        .child("提示词"),
                )
                .child(
                    div()
                        .text_size(FontSize::xxs())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(Tokens::ink_3())
                        .child("到点了就把这句话发进它自己的会话里。"),
                )
                .child(Textarea::new(&ed.prompt)),
        )
        .child(
            div().flex().justify_end().pt(px(12.)).child(
                Button::new(SharedString::from(format!("del-auto-{id}")))
                    .small()
                    .danger()
                    .label("删除这条自动化")
                    .on_click(move |_, window, cx| {
                        window.dispatch_action(Box::new(DeleteAutomation { id: id.clone() }), cx)
                    }),
            ),
        )
        .into_any_element()
}

// ============================================================================
// 工具页 / 技能页
// ----------------------------------------------------------------------------
// 内容复用 settings.rs 里那两个渲染函数（它们本来就是为设置页写的，
// 形状正好是「一列卡片」），只是套上这里的外壳。
//
// 这两个函数的**正文原来在 settings.rs**，因为那时候设置里也有「工具」
// 「技能」两个分区。那两个分区已经删掉了（同一份内容两个入口，而设置那个
// 入口更差 —— 进设置会把侧边栏换成设置导航，丢掉会话列表，而这两样恰恰是
// 干活过程中要看的东西）。既然只剩这里一个调用方，正文就搬了过来。
// ============================================================================

pub fn render_tools_page<T: 'static>(
    status_line: String,
    tool_names: &[String],
    cx: &mut Context<T>,
) -> AnyElement {
    let body = tools_body(status_line, tool_names, cx).into_any_element();
    shell(
        "工具",
        "MCP server 提供的工具。配置文件改完重启应用生效。",
        None,
        body,
    )
}

pub fn render_skills_page<T: 'static>(
    skills: &[smallest_agent_core::skills::Skill],
    disabled: &smallest_agent_core::skills::DisabledSkills,
    cx: &mut Context<T>,
) -> AnyElement {
    let body = skills_body(skills, disabled, cx).into_any_element();
    shell(
        "技能",
        "SKILL.md 形式的操作指南。模型按需读取，不占每轮的上下文。",
        None,
        body,
    )
}

/// 工具页的内容。
///
/// 不做成表单：MCP server 的配置字段（args、env）每个 server 都不一样，
/// 而且用户通常是从别处（Claude Desktop 的配置、server 的 README）
/// **粘贴**过来的。表单会强迫他把一段 JSON 拆成一堆输入框再拼回去。
///
/// 所以这里做两件事：显示当前状态 + 一个按钮打开配置文件所在目录。
/// 编辑交给用户自己的编辑器 —— 那儿有 JSON 语法高亮和括号匹配，
/// 我们做不到也不该重做。
fn tools_body<T: 'static>(
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
                )
                .child(
                    // 这个按钮**不加** .small()：那会把高度写死成 24px
                    // （组件里是 h_6()），加 py 也撑不开。默认的 Medium
                    // 是 32px，作为一张卡底部的独立操作更好按。
                    div().pt(px(6.)).child(
                        Button::new("reveal-mcp")
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

    // 从别家导入。
    //
    // 只在真发现了东西时显示这一段 —— 一个「没找到可导入的配置」的空状态
    // 对没装那些工具的用户是纯噪音。
    let discovered = smallest_agent_core::mcp_import::discover();
    if !discovered.is_empty() {
        let mut import_list = div().flex().flex_col().gap(px(6.));
        for d in &discovered {
            let names: Vec<String> = d.servers.keys().cloned().collect();
            import_list = import_list.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(8.))
                    .bg(Tokens::inset())
                    .px(px(10.))
                    .py(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(FontSize::xxs())
                                    .text_color(Tokens::ink())
                                    .child(d.source.name),
                            )
                            .child(
                                div()
                                    .font_family(crate::assets::FONT_MONO)
                                    .text_size(FontSize::tiny())
                                    .text_color(Tokens::ink_3())
                                    .child(names.join(", ")),
                            ),
                    )
                    .child(
                        div()
                            .text_size(FontSize::tiny())
                            .text_color(Tokens::ink_3())
                            .child(format!("{} 个", names.len())),
                    )
                    .child({
                        // 导入这一个来源的全部 server。
                        //
                        // 按来源整体导入而不是逐个勾选：勾选要维护一份选中状态，
                        // 而「我要 Claude Desktop 里那套」是更常见的意图。
                        // 导进来之后用户能在文件里删掉不想要的，或者
                        // 把 disabled 设成 true。
                        let servers = d.servers.clone();
                        let source_name = d.source.name;
                        Button::new(SharedString::from(format!("import-{source_name}")))
                            .small()
                            .label("导入")
                            .on_click(move |_, _window, _cx| {
                                let mut config = smallest_agent_core::mcp_config::load_config()
                                    .unwrap_or_default();
                                let added = smallest_agent_core::mcp_import::merge_into(
                                    &mut config,
                                    servers.clone(),
                                );
                                match smallest_agent_core::mcp_config::save_config(&config) {
                                    Ok(()) => eprintln!(
                                        "[import] 从 {source_name} 导入了 {} 个 server：{}",
                                        added.len(),
                                        added.join(", ")
                                    ),
                                    Err(err) => {
                                        eprintln!("[import] 写配置失败：{err:#}")
                                    }
                                }
                            })
                    }),
            );
        }
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .pt(px(6.))
                .child(
                    div()
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::ink_3())
                        .child("在别处发现的 MCP 配置"),
                )
                .child(import_list)
                .child(
                    div()
                        .text_size(FontSize::tiny())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(Tokens::ink_3())
                        .child(
                            "导入会把那个来源的 server 全部加进来（同名的加后缀，\
                             不覆盖已有的）。不自动导入是因为你在别处配的 server \
                             未必想在这里跑 —— 比如开着你文档目录的那个。\
                             导完重启应用生效。",
                        ),
                ),
        );
    }

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

/// 技能页。
///
/// 和工具页同一个形态：**列出发现到的东西 + 一个开关**，不做编辑器。
/// 技能的正文是 Markdown 指令（可能几百行），在一个 224px 侧边栏旁边的
/// 表单里编辑它是自找的 —— 用户的编辑器有语法高亮和预览。
///
/// 开关存的是「停用哪些」而不是「启用哪些」：新装的技能应该默认可用，
/// 存启用列表的话每加一个技能都要用户再点一次才生效。
fn skills_body<T: 'static>(
    skills: &[smallest_agent_core::skills::Skill],
    disabled: &smallest_agent_core::skills::DisabledSkills,
    cx: &mut Context<T>,
) -> impl IntoElement {
    let dir = smallest_agent_core::mcp_config::config_dir()
        .map(|p| p.join("skills").display().to_string())
        .unwrap_or_else(|_| "(路径不可用)".into());
    let reveal_dir = dir.clone();

    let mut body = div().flex().flex_col().gap(px(14.)).child(
        div()
            .text_size(FontSize::sm())
            .text_color(Tokens::ink_2())
            .child(if skills.is_empty() {
                "还没发现技能。技能是一个目录加一个 SKILL.md，放进下面那个目录即可。".to_string()
            } else {
                let on = skills.iter().filter(|s| !disabled.contains(&s.name)).count();
                format!("发现 {} 个技能，{} 个启用中。", skills.len(), on)
            }),
    );

    if !skills.is_empty() {
        let mut list = div().flex().flex_col().gap(px(8.));
        for s in skills {
            let is_on = !disabled.contains(&s.name);
            let name = s.name.clone();
            let path = s.path.clone();
            list = list.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .rounded(px(10.))
                    .bg(Tokens::inset())
                    .border_1()
                    .border_color(Tokens::line())
                    .p(px(12.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .text_size(FontSize::sm())
                                            .font_weight(FontWeight::MEDIUM)
                                            // 停用的技能标题也降级 —— 只靠开关
                                            // 表达状态的话，扫一列时看不出哪些关了
                                            .text_color(if is_on {
                                                Tokens::ink()
                                            } else {
                                                Tokens::ink_3()
                                            })
                                            .child(name.clone()),
                                    )
                                    // 来源徽章：同名技能会被去重，用户需要知道
                                    // 生效的是哪一份
                                    .child(
                                        div()
                                            .rounded_full()
                                            .bg(Tokens::hover())
                                            .px(px(6.))
                                            .py(px(1.))
                                            .text_size(FontSize::tiny())
                                            .text_color(Tokens::ink_3())
                                            .child(s.source),
                                    ),
                            )
                            .when(!s.description.is_empty(), |d| {
                                d.child(
                                    div()
                                        .text_size(FontSize::xxs())
                                        .font_weight(FontWeight::NORMAL)
                                        .text_color(Tokens::ink_3())
                                        .child(s.description.clone()),
                                )
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("reveal-skill-{name}")))
                            .small()
                            .label("打开")
                            .on_click(move |_, _window, cx| cx.reveal_path(&path)),
                    )
                    .child(
                        Button::new(SharedString::from(format!("toggle-skill-{name}")))
                            .small()
                            .label(if is_on { "停用" } else { "启用" })
                            .on_click({
                                let name = name.clone();
                                move |_, window, cx| {
                                    // 走 action 而不是回调：这个函数是泛型的，
                                    // 拿不到 &mut ChatView 去改 SettingsForm
                                    window.dispatch_action(
                                        Box::new(crate::chat::ToggleSkill { name: name.clone() }),
                                        cx,
                                    );
                                }
                            }),
                    ),
            );
        }
        body = body.child(list);
    }

    body = body
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
                        .child("技能目录"),
                )
                .child(
                    div()
                        .font_family(crate::assets::FONT_MONO)
                        .text_size(FontSize::xxs())
                        .text_color(Tokens::ink_2())
                        .child(dir),
                )
                .child(
                    // 同 reveal-mcp：不加 .small()，理由见那边
                    div().pt(px(6.)).child(
                        Button::new("reveal-skills")
                            .label("在 Finder 中显示")
                            .on_click(move |_, _window, cx| {
                                // 目录不存在时先建出来，否则「在 Finder 中显示」
                                // 什么都不会发生，用户以为按钮坏了
                                let p = std::path::PathBuf::from(&reveal_dir);
                                let _ = std::fs::create_dir_all(&p);
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
                    "格式和 Claude Code 的技能一致（SKILL.md 带 name / description），\
                     已有的技能能直接拿来用。项目里的 .claude/skills 会盖住同名的用户级技能。\
                     新增或改名后重开设置页刷新列表。",
                ),
        );

    let _ = cx;
    body
}

