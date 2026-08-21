// ============================================================================
// sidebar.rs —— 侧边栏（对应 electron/renderer/src/components/SessionList.tsx）
// ----------------------------------------------------------------------------
// 结构照搬 Electron 版：顶部动作行（新对话）→「项目」区标签 + 添加入口
// → 项目行（可折叠）→ 其下缩进嵌套的会话行。
//
// 视觉规则（跟那边一致，别破）：
//   • 字号 12.5px 及以下，行高统一 28px（CSS 的 h-7）
//   • 边界用 hairline，圆角走 Radius::control / chip
//   • **没有点击微交互**（active:scale 之类）—— SessionList.tsx 的注释解释了
//     原因：按一下整行缩一下在一个每天点几十次的列表里是噪音不是反馈，
//     选中态本身（背景 + 文字提亮）已经把结果说清楚了。
// ============================================================================

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::menu::{ContextMenuExt as _, PopupMenu};
use gpui_component::{Icon, IconName};

use crate::chat::{DeleteSession, RemoveProject, RenameSession};
use crate::projects::{SessionGroup, UNGROUPED_ID};
use crate::theme::{FontSize, Radius, Tokens};

/// 侧边栏宽度。CSS 是 w-56 = 224px。
pub const SIDEBAR_WIDTH: f32 = 224.;

/// 顶部给红绿灯留的垂直空间。
///
/// 标题栏设了 appears_transparent，红绿灯是绝对定位覆盖在窗口左上角的
/// （main.rs 里 traffic_light_position 是 (16, 17)），直径约 12px，
/// 所以占到 y≈29。留 32px 保证第一行内容不被压住。
///
/// 横向不需要留白：这一行现在是纯占位，没有内容会跟红绿灯抢位置
/// —— 设置入口已经移到侧边栏底部了。
const TRAFFIC_LIGHT_CLEARANCE: f32 = 32.;

/// 列表行统一高度，CSS 的 h-7。
const ROW_HEIGHT: f32 = 28.;

pub struct SidebarProps<'a> {
    pub groups: &'a [SessionGroup],
    pub current_id: &'a str,
    /// 设置页打开时侧边栏换成分区导航（waku 的做法）。
    /// None = 显示会话列表。
    pub settings_section: Option<crate::settings::SettingsSection>,
    /// 用户改过的标题。没有记录的会话用 SessionMeta 里那个自动推导的。
    pub titles: &'a crate::session_titles::Titles,
    /// 正在重命名哪个会话（id + 那一行临时变成的输入框）。
    pub renaming: Option<(
        &'a str,
        &'a gpui::Entity<gpui_component::input::TextareaState>,
    )>,
    /// 当前选中的项目：决定新会话落在哪儿。
    /// 跟 current_id 是两件事 —— 用户可以选中一个项目却不打开它下面任何会话。
    pub current_project_id: Option<&'a str>,
    /// 内容区当前显示哪个页面。用来高亮下面那四行。
    pub pane: crate::pane::Pane,
}

/// 无参回调（新对话、添加项目）。
pub type Action<T> = Box<dyn Fn(&mut T, &mut Window, &mut Context<T>)>;
/// 带 id 的回调（选会话、选项目、折叠）。
pub type IdAction<T> = Box<dyn Fn(&mut T, String, &mut Window, &mut Context<T>)>;
/// 切设置分区的回调。
pub type SectionAction<T> =
    Box<dyn Fn(&mut T, crate::settings::SettingsSection, &mut Window, &mut Context<T>)>;

/// 回调集合。
///
/// 打包成结构体而不是一串位置参数：五个签名相近的闭包排在一起，
/// 顺序写错编译器拦不住（三个都是 IdAction）。
pub struct SidebarCallbacks<T> {
    pub on_select: IdAction<T>,
    pub on_create: Action<T>,
    pub on_add_project: Action<T>,
    pub on_toggle_collapsed: IdAction<T>,
    pub on_select_project: IdAction<T>,
    /// 打开设置页面（不是开窗口）
    pub on_open_settings: Action<T>,
    /// 切设置分区
    pub on_select_settings_section: SectionAction<T>,
    /// 从设置返回对话
    pub on_close_settings: Action<T>,
    /// 切到某个独立页面（「工具」「技能」「Agent」「自动化」四行用）。
    ///
    /// 这四行以前是「打开设置并跳到某一页」，现在是**独立页面** ——
    /// 见 pane.rs 的文件头。区别在于它们不会换掉侧边栏。
    pub on_open_page: PaneAction<T>,
}

/// 切页面的回调。
pub type PaneAction<T> = Box<dyn Fn(&mut T, crate::pane::Pane, &mut Window, &mut Context<T>)>;

pub fn render_sidebar<T: 'static>(
    props: SidebarProps<'_>,
    cb: SidebarCallbacks<T>,
    cx: &mut Context<T>,
) -> AnyElement {
    let SidebarCallbacks {
        on_select,
        on_create,
        on_add_project,
        on_toggle_collapsed,
        on_select_project,
        on_open_settings,
        on_select_settings_section,
        on_close_settings,
        on_open_page,
    } = cb;
    // Rc 是因为这些闭包要分发进多个行的 listener 里
    let on_select = std::rc::Rc::new(on_select);
    let on_toggle = std::rc::Rc::new(on_toggle_collapsed);
    let on_select_project = std::rc::Rc::new(on_select_project);
    // 那四行共用它
    let on_open_page = std::rc::Rc::new(on_open_page);

    // 设置页打开时侧边栏换成分区导航。
    //
    // 为什么不并列显示（会话列表 + 设置分区都在）：侧边栏只有 224px，
    // 两组导航挤在一起谁都点不准，而且用户在设置里的时候不需要切会话。
    // waku 也是整个换掉。
    if let Some(current) = props.settings_section {
        return render_settings_nav(current, on_select_settings_section, on_close_settings, cx)
            .into_any_element();
    }

    let mut list = div()
        .id("group-list")
        .flex()
        .flex_col()
        .gap_1()
        .flex_1()
        .overflow_y_scroll();

    if props.groups.is_empty() {
        list = list.child(
            div()
                .w_full()
                .px_2()
                .py_1()
                .text_size(FontSize::xxs())
                .font_weight(FontWeight::NORMAL)
                .text_color(Tokens::ink_3())
                .child("还没有对话。点上面的「新对话」开始，或用 + 添加一个项目目录。"),
        );
    }

    for group in props.groups {
        // 「未分组」是兜底分类而不是用户建的东西：不能删、也不显示目录路径
        let is_project = group.dir.is_some();
        let is_current_project = is_project && Some(group.id.as_str()) == props.current_project_id;
        let gid = group.id.clone();
        let gid_toggle = group.id.clone();
        let gid_remove = group.id.clone();
        let on_toggle = on_toggle.clone();
        let on_select_project = on_select_project.clone();

        // w_full 是必须的，不能靠 flex 的默认 stretch。
        //
        // 父容器（list）是 overflow_y_scroll —— 滚动容器的子元素在内容
        // 超出时不再 stretch 到容器宽度，而是收缩成内容宽度。表现出来就是
        // 会话列表长了之后每一行的背景块宽度跟着标题长短变，看着乱。
        let mut block = div().w_full().flex().flex_col().gap(px(1.));

        // 项目行：整行一次点击同时做两件事 —— 选中这个项目 + 折叠/展开。
        //
        // Electron 版的注释解释了为什么不拆成两个点击目标：「选中」只有一个
        // 消费者（决定新会话落在哪个项目），除了行上的选中态之外不改变任何东西；
        // 「折叠」才是用户频繁要做的动作。以前折叠只认那个 11px 的角标，
        // 点击面积太小还得瞄准。别改回两个目标 —— 角标现在纯粹是状态指示。
        let mut row = div()
            .id(SharedString::from(format!("group-{}", group.id)))
            .w_full()
            .flex()
            .h(px(ROW_HEIGHT))
            .items_center()
            .gap(px(6.))
            .px(px(6.))
            .rounded(Radius::control())
            .cursor_pointer()
            .text_size(FontSize::sm())
            .when(is_current_project, |d| {
                d.bg(Tokens::surface()).text_color(Tokens::ink())
            })
            .when(!is_current_project, |d| {
                d.text_color(Tokens::ink_2())
                    .hover(|s| s.bg(Tokens::hover()))
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _, window, cx| {
                    on_select_project(this, gid.clone(), window, cx);
                    on_toggle(this, gid_toggle.clone(), window, cx);
                }),
            )
            // 折叠角标：真 SVG 而不是「›」这类字符 —— 字符的基线和字宽跟着
            // 文字走，在一行 28px 的列表里对不齐，而且颜色只能跟文字同色。
            .child(
                // 12px：28px 行高里 16px（size_4）偏大，角标又是纯状态指示，
                // 不该跟文字抢重量。Electron 版这里是 11px。
                Icon::new(if group.collapsed {
                    IconName::ChevronRight
                } else {
                    IconName::ChevronDown
                })
                .size(px(12.))
                .text_color(Tokens::ink_3()),
            )
            .child(
                Icon::new(if group.collapsed {
                    IconName::FolderClosed
                } else {
                    IconName::FolderOpen
                })
                .size(px(13.))
                .text_color(Tokens::ink_3()),
            )
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(group.name.clone()),
            );

        // 折叠时把会话数摆出来：折起来之后看不见里面有几条，
        // 这个数字让用户不必展开就知道值不值得展开。
        if group.collapsed && !group.sessions.is_empty() {
            row = row.child(
                div()
                    .flex_none()
                    .text_size(FontSize::tiny())
                    .text_color(Tokens::ink_3())
                    .child(group.sessions.len().to_string()),
            );
        }

        // 「移除项目」在右键菜单里。未分组那组不是用户建的，没有「移除」可做。
        //
        // context_menu() 返回的是 ContextMenu<Div> 而不是 Div，所以不能赋回
        // 同一个变量 —— 在这里收口成 AnyElement，两个分支类型才统一。
        let row: AnyElement = if is_project {
            row.context_menu(move |menu: PopupMenu, _window, _cx| {
                menu.menu(
                    "移除项目",
                    Box::new(RemoveProject {
                        project_id: gid_remove.clone(),
                    }),
                )
            })
            .into_any_element()
        } else {
            row.into_any_element()
        };
        block = block.child(row);

        if !group.collapsed {
            if group.sessions.is_empty() {
                // 空项目：刚添加完目录、还没在里面开对话时，不给一行提示的话
                // 那次「添加项目」看起来就像什么都没发生。
                block = block.child(
                    div()
                        .w_full()
                        .py_1()
                        // 和会话行同样的缩进，保持左边缘对齐
                        .pl(px(20.))
                        .text_size(FontSize::xxs())
                        .font_weight(FontWeight::NORMAL)
                        .text_color(Tokens::ink_3())
                        .child("还没有对话"),
                );
            } else {
                // 缩进 + 左侧引导线表达层级（不用色块，那会丢层级感）。
                // 折叠时整个块不渲染而不是 display:none —— 长列表下省掉
                // 几百个不可见节点的渲染开销。
                // 只用缩进表达层级，不画左引导线。
                //
                // Electron 版有那条线，但在 gpui 里它落在整数像素上、又紧贴
                // 圆角的行背景，折叠展开时会看到线头突出来。缩进 + 选中态的
                // 背景块已经把层级说清楚了，线是多余的噪音。
                // **容器不缩进** —— 缩进做在行内容上（下面那个 pl）。
                //
                // 这样子项的背景块和项目行一样宽，hover / 选中态的色块左右
                // 都齐平；层级靠内容的缩进表达。VS Code 的文件树就是这么做的。
                //
                // 反过来（容器 ml + 行撑满容器）会让子项的背景块窄一圈，
                // 两行的色块对不齐，看着像没对准。
                let mut ul = div().w_full().flex().flex_col().gap(px(1.));

                for s in &group.sessions {
                    let is_active = s.id == props.current_id;
                    // 用户改过就用他的标题
                    let display_title = props
                        .titles
                        .get(&s.id)
                        .cloned()
                        .unwrap_or_else(|| s.title.clone());

                    // 这一行正在被重命名：换成输入框而不是文字。
                    //
                    // 就地编辑而不是弹对话框 —— 重命名是个轻动作，
                    // 弹窗要用户先看清标题再点确定，反而多两步。
                    if let Some((rid, input)) = props.renaming
                        && rid == s.id
                    {
                        ul = ul.child(
                            div()
                                .w_full()
                                .flex()
                                .h(px(ROW_HEIGHT))
                                .items_center()
                                .pl(px(20.))
                                .pr(px(6.))
                                .child(gpui_component::input::Textarea::new(input)),
                        );
                        continue;
                    }
                    let sid = s.id.clone();
                    let sid_del = s.id.clone();
                    let sid_ren = s.id.clone();
                    let on_select = on_select.clone();
                    ul = ul.child(
                        div()
                            .id(SharedString::from(format!("session-{}", s.id)))
                            .w_full()
                            .flex()
                            .h(px(ROW_HEIGHT))
                            .items_center()
                            .gap(px(6.))
                            // 右 padding 和项目行一致；左边额外加缩进表达层级。
                            // 6 + 14 = 20，正好让标题从项目名的「文件夹图标」
                            // 之后开始，视觉上挂在它下面。
                            .pl(px(20.))
                            .pr(px(6.))
                            .rounded(Radius::control())
                            .cursor_pointer()
                            .text_size(FontSize::sm())
                            // 选中态只靠**文字提亮**，不给背景色。
                            //
                            // 项目行才用背景块 —— 侧边栏里同时出现两种背景块
                            // （选中的项目 + 选中的会话）会让人不确定哪个是
                            // 「当前在看的」。会话是叶子节点，提亮就够。
                            //
                            // hover 仍然给背景：那是「指针在这」的即时反馈，
                            // 和「这是当前选中的」是两件事，不冲突。
                            .text_color(if is_active {
                                Tokens::ink()
                            } else {
                                Tokens::ink_2()
                            })
                            .when(is_active, |d| d.font_weight(FontWeight::MEDIUM))
                            .hover(|s| s.bg(Tokens::hover()))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, window, cx| {
                                    on_select(this, sid.clone(), window, cx);
                                }),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .child(display_title),
                            )
                            // 删除走原生右键菜单，不是行尾那个 hover 才出现的 ✕。
                            //
                            // Electron 版换成右键菜单时记了理由：那个 ✕ 占着每行
                            // 右端（哪怕透明也占位），而且悬停才出现意味着用户得
                            // 先发现它存在。右键菜单是桌面应用里「对这一项做点什么」
                            // 的既定手势，不用教。
                            .context_menu(move |menu: PopupMenu, _window, _cx| {
                                // 重命名排在删除前面：它是更常用的动作，
                                // 而且删除放在最后能减少误点（菜单弹出时
                                // 指针在顶部）
                                menu.menu(
                                    "重命名",
                                    Box::new(RenameSession {
                                        session_id: sid_ren.clone(),
                                    }),
                                )
                                .separator()
                                .menu(
                                    "删除会话",
                                    Box::new(DeleteSession {
                                        session_id: sid_del.clone(),
                                    }),
                                )
                            }),
                    );
                }
                block = block.child(ul);
            }
        }
        list = list.child(block);
    }

    div()
        .flex()
        .flex_col()
        .w(px(SIDEBAR_WIDTH))
        .flex_none()
        .gap(px(6.))
        .h_full()
        .bg(Tokens::canvas())
        .border_r_1()
        .border_color(Tokens::line())
        .p_2()
        // 顶部只给红绿灯让位。设置移到底部了 —— 它是低频入口，
        // 放在顶部会和「新对话」（高频）挤在同一视觉区。
        .child(div().h(px(TRAFFIC_LIGHT_CLEARANCE)).flex_none())
        // 新对话：跟下面的项目行/会话行同一套外观 —— 无默认背景、文字左对齐、
        // 只有 hover 才出背景。
        //
        // Electron 版记了一次修改：它以前是 bg-ink 的实心按钮，「在一个全是
        // hover 态的列表顶上显得过重，像整页的主操作；实际它只是一条动作行」。
        // 保持现在这样，别改回实心。
        .child(
            div()
                .id("new-chat")
                .w_full()
                .flex()
                .h(px(ROW_HEIGHT))
                .items_center()
                .gap(px(6.))
                .px_2()
                .rounded(Radius::control())
                .cursor_pointer()
                .text_size(FontSize::sm())
                .text_color(Tokens::ink_2())
                .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, window, cx| on_create(this, window, cx)),
                )
                .child(Icon::new(IconName::Plus).size(px(13.)))
                .child(div().flex_1().child("新对话")),
        )
        // 「工具」「技能」两行：能力管理的直达入口。
        //
        // 为什么放在这儿而不是只留在设置里：这两样决定 agent **能做什么**，
        // 属于用户在干活过程中会想调的东西（「这个技能怎么没生效」），
        // 而设置里那一堆是配一次就不动的（API key、模型、上下文长度）。
        // 频次不同就不该在同一个入口后面。
        //
        // 跟「新对话」同一套外观（无底、hover 出背景），但字色降一级 ——
        // 新对话是这一栏的主操作，这两行是次要的。
        .child(render_manage_row(
            "open-agents",
            IconName::Bot,
            "Agent",
            crate::pane::Pane::Agents,
            props.pane,
            on_open_page.clone(),
            cx,
        ))
        .child(render_manage_row(
            "open-automations",
            IconName::Calendar,
            "自动化",
            crate::pane::Pane::Automations,
            props.pane,
            on_open_page.clone(),
            cx,
        ))
        .child(render_manage_row(
            "open-tools",
            IconName::SquareTerminal,
            "工具",
            crate::pane::Pane::Tools,
            props.pane,
            on_open_page.clone(),
            cx,
        ))
        .child(render_manage_row(
            "open-skills",
            IconName::BookOpen,
            "技能",
            crate::pane::Pane::Skills,
            props.pane,
            on_open_page.clone(),
            cx,
        ))
        // 「项目」区标签 + 添加入口。标签是分区名而不是可点的项，所以不做 hover 态。
        .child(
            div()
                .flex()
                .h(px(24.))
                .flex_none()
                .items_center()
                .justify_between()
                .px_2()
                .child(
                    div()
                        .text_size(FontSize::tiny())
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(Tokens::ink_3())
                        .child("项目"),
                )
                .child(
                    div()
                        .id("add-project")
                        .flex()
                        .size(px(20.))
                        .items_center()
                        .justify_center()
                        .rounded(Radius::chip())
                        .cursor_pointer()
                        .text_color(Tokens::ink_3())
                        .hover(|s| s.text_color(Tokens::ink()))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, window, cx| {
                                on_add_project(this, window, cx)
                            }),
                        )
                        .child(Icon::new(IconName::Plus).size(px(12.))),
                ),
        )
        .child(list)
        // 底部设置行：低频入口沉到底，和列表用一条分隔线隔开。
        // 这是桌面应用侧边栏的常规位置（Finder、VS Code、waku 都这样）。
        .child(
            div()
                .w_full()
                .flex()
                .h(px(ROW_HEIGHT))
                .flex_none()
                .items_center()
                .gap(px(6.))
                .mt(px(2.))
                .px_2()
                .rounded(Radius::control())
                .cursor_pointer()
                .text_size(FontSize::sm())
                .text_color(Tokens::ink_3())
                .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                .id("open-settings")
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, window, cx| on_open_settings(this, window, cx)),
                )
                .child(Icon::new(IconName::Settings).size(px(13.)))
                .child(div().flex_1().child("设置")),
        )
        .into_any_element()
}

/// 「工具」「技能」这类直达设置某一页的行。
///
/// 单独一个函数是因为这两行只差图标、文字和目标页 —— 内联两遍会有
/// 三十行几乎相同的样式链，其中一条改了另一条忘改就会视觉不一致。
fn render_manage_row<T: 'static>(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    target: crate::pane::Pane,
    current: crate::pane::Pane,
    on_open_page: std::rc::Rc<PaneAction<T>>,
    cx: &mut Context<T>,
) -> impl IntoElement {
    let active = current == target;
    div()
        .id(id)
        .w_full()
        .flex()
        .h(px(ROW_HEIGHT))
        .flex_none()
        .items_center()
        .gap(px(6.))
        .px_2()
        .rounded(Radius::control())
        .cursor_pointer()
        .text_size(FontSize::sm())
        // 当前页给底 + 提亮。这四行是**目的地**，跟设置分区导航同一个道理：
        // 「我在哪一页」只有这里能说（内容区里没有面包屑）。
        .when(active, |d| {
            d.bg(Tokens::hover_2())
                .text_color(Tokens::ink())
                .font_weight(FontWeight::MEDIUM)
        })
        // ink_3 而不是 ink_2：比「新对话」低一级，见调用点的注释
        .when(!active, |d| {
            d.text_color(Tokens::ink_3())
                .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
        })
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _, window, cx| on_open_page(this, target, window, cx)),
        )
        .child(Icon::new(icon).size(px(13.)))
        .child(div().flex_1().child(label))
}

/// 设置模式下的侧边栏：顶部返回 + 分区列表。
fn render_settings_nav<T: 'static>(
    current: crate::settings::SettingsSection,
    on_select: SectionAction<T>,
    on_close: Action<T>,
    cx: &mut Context<T>,
) -> impl IntoElement {
    use crate::settings::SettingsSection;
    let on_select = std::rc::Rc::new(on_select);

    let mut list = div().w_full().flex().flex_col().gap(px(1.)).flex_1();
    for section in SettingsSection::ALL {
        let active = section == current;
        let on_select = on_select.clone();
        list = list.child(
            div()
                .id(SharedString::from(format!("settings-{}", section.label())))
                .w_full()
                .flex()
                .h(px(ROW_HEIGHT))
                .items_center()
                .gap(px(6.))
                .px_2()
                .rounded(Radius::control())
                .cursor_pointer()
                .text_size(FontSize::sm())
                // 当前分区：明显的底 + 加粗。
                //
                // 原来用 surface（0x232427），压在 canvas（0x1c1d1f）上只差
                // 一点点，扫一眼看不出自己在哪一页。hover_2 差得开。
                //
                // 这里跟会话行的规则不同（那边 active 不给底、只有 hover）——
                // 会话行的选中已经由右侧内容表达了，而分区导航的「我在哪一页」
                // 只有这一个地方能说。
                .when(active, |d| {
                    d.bg(Tokens::hover_2())
                        .text_color(Tokens::ink())
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!active, |d| {
                    d.text_color(Tokens::ink_2())
                        .hover(|s| s.bg(Tokens::hover()))
                })
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, window, cx| on_select(this, section, window, cx)),
                )
                .child(Icon::new(section.icon()).size(px(13.)))
                .child(div().flex_1().child(section.label())),
        );
    }

    div()
        .flex()
        .flex_col()
        .w(px(SIDEBAR_WIDTH))
        .flex_none()
        .gap(px(6.))
        .h_full()
        .bg(Tokens::canvas())
        .border_r_1()
        .border_color(Tokens::line())
        .p_2()
        .child(div().h(px(TRAFFIC_LIGHT_CLEARANCE)).flex_none())
        // 返回：设置是个页面，得有出口。放在顶部而不是底部 ——
        // 「返回」是导航动作，和下面的分区列表是同一层级的东西。
        .child(
            div()
                .id("close-settings")
                .w_full()
                .flex()
                .h(px(ROW_HEIGHT))
                .items_center()
                .gap(px(6.))
                .px_2()
                .rounded(Radius::control())
                .cursor_pointer()
                .text_size(FontSize::sm())
                .text_color(Tokens::ink_2())
                .hover(|s| s.bg(Tokens::hover()).text_color(Tokens::ink()))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, window, cx| on_close(this, window, cx)),
                )
                .child(Icon::new(IconName::ArrowLeft).size(px(13.)))
                .child(div().flex_1().child("返回对话")),
        )
        .child(
            div()
                .flex()
                .h(px(24.))
                .flex_none()
                .items_center()
                .px_2()
                .text_size(FontSize::tiny())
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(Tokens::ink_3())
                .child("设置"),
        )
        .child(list)
}

/// 未分组分组的 id，给 ChatView 判断「选中的是不是真项目」用。
pub const fn ungrouped_id() -> &'static str {
    UNGROUPED_ID
}
