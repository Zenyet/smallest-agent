// ============================================================================
// picker.rs —— composer 上那两个下拉选择器（引擎、模型）
// ----------------------------------------------------------------------------
// 为什么不用 gpui-component 的 `Button::dropdown_menu`（原来就是那个）：
//
// PopupMenu 只能表达「哪一项被 hover / 键盘选中」（它内部那个 selected_index，
// 私有、只由 hover 和方向键改），表达不了「哪一项是当前生效的值」。
// 库里给这件事留的口子是 `menu_with_check` —— 左边加一个 ✓。
//
// 但一个「当前值」在下拉里只有勾没有底，扫视时找不到：眼睛是先看色块再看
// 图标的。要的是选中项有底色（像侧边栏当前会话那样），而 PopupMenu 的项
// 外观是写死在 MenuItemElement 里的，容器 padding 也吃不掉，
// 从外面加背景只能做出一个缩在行里的小方块。
//
// 所以这里用 Popover + 自己画的行。代价是要自己处理「点了之后关掉浮层」
// （PopupMenu 的 confirm 里自带），换来的是行的外观完全受控 ——
// 高度、圆角、hover 底、选中底跟侧边栏是同一套。
// ============================================================================

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_component::button::ButtonVariants as _;
use gpui_component::popover::Popover;
use gpui_component::{Icon, IconName, Selectable as _, Sizable as _};

use crate::theme::{FontSize, Radius, Tokens};

/// 一个可选项。
pub struct PickerItem {
    pub id: String,
    pub label: String,
    /// 行左边的图标。None 时那一列留空（对齐还在，见 render 里的占位）。
    pub icon: Option<IconName>,
    /// 分组标题。跟上一项不同就在它上面插一条分组头。
    ///
    /// 内置 agent 的模型列表横跨九家厂商、三十多个模型 —— 平铺一列
    /// 谁属于谁就得靠模型名自己猜（`glm-4.6` 是哪家？）。分组头把这件事
    /// 交给版面。None = 不分组（外部 CLI 的模型列表就一家，不需要）。
    pub group: Option<String>,
}

impl PickerItem {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            group: None,
        }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn group(mut self, group: impl Into<String>) -> Self {
        self.group = Some(group.into());
        self
    }
}

/// 触发按钮的外观。
///
/// 单独一个结构体而不是一串参数：调用点有两个（引擎、模型），
/// 参数已经六个了，位置写错编译器拦不住（三个都是 Option<IconName>）。
pub struct PickerTrigger {
    /// 元素 id，两个选择器必须不同（gpui 靠它做状态复用）
    pub id: &'static str,
    pub label: String,
    pub icon: Option<IconName>,
}

/// 行高。比侧边栏的 28 矮一点 —— 下拉里一次要看完整个列表，
/// 而侧边栏的行要能舒服地点。
const ROW_HEIGHT: f32 = 26.;

/// 列表最大高度。模型列表能有十几项（Claude 那份就是），
/// 不封顶的话浮层会顶到窗口外面去。
const MAX_HEIGHT: f32 = 320.;

/// 渲染一个选择器。
///
/// `current` 是当前生效的 id，`on_pick` 在用户点某一项时调用。
/// 泛型参数 T 是宿主视图（实际上只有 ChatView），这样回调能直接改它的状态，
/// 不用绕 Action 分发 —— 浮层是画在窗口根上的另一棵子树，
/// 从那里 dispatch_action 到不到宿主取决于焦点在哪，不可靠。
pub fn render_picker<T: 'static>(
    trigger: PickerTrigger,
    items: Vec<PickerItem>,
    current: String,
    on_pick: impl Fn(&mut T, String, &mut Window, &mut Context<T>) + 'static,
    cx: &mut Context<T>,
) -> AnyElement {
    // 宿主的弱引用：浮层内容的闭包活得比这次渲染长，不能借 &mut T。
    // 用 Weak 而不是 Entity 是为了不让浮层把宿主吊住 —— 窗口关了之后
    // 那个闭包可能还在某个缓存里。
    let host = cx.entity().downgrade();
    let on_pick = std::rc::Rc::new(on_pick);

    let button = gpui_component::button::Button::new(trigger.id)
        // ghost：composer 那行不该出现第三个有底的控件（已经有发送键了）。
        // 浮层打开时 Popover 会把 trigger 置成 selected，
        // 而 ghost 的 selected 底是 secondary_active —— 正好是「按住了」的观感。
        .ghost()
        // compact + small：composer 那行只有 ~26px 高，默认尺寸会顶开它
        .compact()
        .small()
        .dropdown_caret(true)
        .when_some(trigger.icon, |b, i| b.icon(i))
        .label(trigger.label)
        // 没打开时也不该是「选中」态 —— Popover 只在打开时叠上去
        .selected(false);

    Popover::new(SharedString::from(format!("{}-popover", trigger.id)))
        // 浮层往上开：composer 在窗口底部，往下开会掉到窗口外面
        .anchor(Anchor::BottomLeft)
        .trigger(button)
        .content(move |_state, _window, cx| {
            // 关掉浮层要拿它自己的实体 —— content 每次渲染都会跑，
            // 这里拿到的就是当前那个 PopoverState。
            let popover = cx.entity();
            let mut list = div()
                .id("picker-list")
                .flex()
                .flex_col()
                .gap(px(1.))
                .min_w(px(180.))
                .max_h(px(MAX_HEIGHT))
                .overflow_y_scroll();

            // 上一项的分组，用来判断要不要插分组头
            let mut last_group: Option<&str> = None;

            for item in &items {
                // 分组头。只在组变了的时候插，所以调用方只要把同组的项
                // 排在一起就行，不用自己算边界。
                if let Some(g) = item.group.as_deref()
                    && last_group != Some(g)
                {
                    list = list.child(
                        div()
                            .w_full()
                            .flex()
                            .items_center()
                            .h(px(22.))
                            .flex_none()
                            .px(px(8.))
                            // 第一组之上不留空 —— 那儿已经有浮层自己的 padding
                            .when(last_group.is_some(), |d| d.mt(px(4.)))
                            .text_size(FontSize::tiny())
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(Tokens::ink_3())
                            .child(g.to_string()),
                    );
                }
                last_group = item.group.as_deref();

                let is_current = item.id == current;
                let id = item.id.clone();
                let on_pick = on_pick.clone();
                let host = host.clone();
                let popover = popover.clone();
                list = list.child(
                    div()
                        .id(SharedString::from(format!("picker-row-{}", item.id)))
                        // overflow_y_scroll 的子元素不会自己撑开，要显式 w_full
                        .w_full()
                        .flex()
                        .h(px(ROW_HEIGHT))
                        .flex_none()
                        .items_center()
                        .gap(px(6.))
                        .px(px(8.))
                        .rounded(Radius::chip())
                        .cursor_pointer()
                        .text_size(FontSize::xs())
                        // 当前值：整行铺底 + 文字提亮。
                        // 这是这个文件存在的理由 —— 见文件头。
                        //
                        // 用 accent_tint 而不是一档更亮的灰：选中和 hover 必须
                        // 是**两种**编码，否则鼠标划过时「当前值」会跟着动。
                        // 灰底做 hover、蓝底做选中，两者能同时出现而不打架。
                        .when(is_current, |d| {
                            d.bg(Tokens::accent_tint()).text_color(Tokens::ink())
                        })
                        // hover 用 overlay_hover 而不是页面那个 hover ——
                        // 后者（0x2a2b2e）比浮层底色还暗，划过去会看着像凹进去
                        .when(!is_current, |d| {
                            d.text_color(Tokens::ink_2())
                                .hover(|s| s.bg(Tokens::overlay_hover()).text_color(Tokens::ink()))
                        })
                        // 图标列：有没有图标都占同样宽度，否则有图标的行
                        // 和没图标的行文字对不齐
                        .child(
                            div()
                                .flex()
                                .size(px(13.))
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .when_some(item.icon.as_ref(), |d, i| {
                                    d.child(Icon::new(i.clone()).size(px(12.)))
                                }),
                        )
                        .child(div().flex_1().min_w_0().child(item.label.clone()))
                        // 勾在右边。有底了还给勾，是因为底色在浅色主题下
                        // 对比度不高，而勾是形状 —— 两种编码互相兜底。
                        .child(
                            div()
                                .flex()
                                .size(px(13.))
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .when(is_current, |d| {
                                    d.text_color(Tokens::accent_ink())
                                        .child(Icon::new(IconName::Check).size(px(11.)))
                                }),
                        )
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            // 先关浮层再改状态：反过来的话宿主 notify 触发重绘，
                            // 而浮层还开着，会看到列表用新的选中项重画一帧
                            popover.update(cx, |state, cx| state.dismiss(window, cx));
                            let id = id.clone();
                            let on_pick = on_pick.clone();
                            _ = host.update(cx, |host, cx| on_pick(host, id, window, cx));
                        }),
                );
            }
            list
        })
        .into_any_element()
}
