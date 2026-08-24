// ============================================================================
// context_menu.rs —— 自己画的右键菜单
// ----------------------------------------------------------------------------
// 为什么不用 gpui-component 的 `ContextMenuExt`（原来就是那个）：
//
// 它的 PopupMenu 在 items 容器上写死了 `.gap_y_0p5()`（popup_menu.rs:1447）——
// 项与项之间 2px 缝。那个值不读任何 spacing token，PopupMenu 上也没有
// gap / spacing / dense 之类的 setter（对过 upstream main，同样没有），
// 而我们的调用点只拿到 `PopupMenu`，只能往里加项，容器碰不到。
// gpui 的 flex gap 也不像 CSS 那样能被子元素继承或覆盖。
//
// 同一个原因还带走了行高：26px 来自 `render_item` 里的 `item_height`，
// 由私有字段 `self.size` 决定，而 PopupMenu 没实现 `Sizable`、没有 size setter。
//
// 所以这里照 picker.rs 的先例自己画 —— 那个文件也是因为 PopupMenu 表达不了
// 想要的行外观（选中项要有底色）才自己写的。换来的是间距、行高、圆角、
// hover 底全部受控，跟侧边栏和 picker 是同一套。
//
// 代价（picker.rs 那边不需要，因为 Popover 帮它做了）：光标定位、点击外部
// 关闭、Esc 关闭、焦点归还，都得自己接。下面逐个标了。
//
// **不支持方向键上下选中** —— 库里那个有。取舍：右键菜单是鼠标手势
// （你得先右键才能看到它），而我们两个菜单分别只有 1 项和 2 项，
// 键盘遍历的价值抵不上「为它长期持有一份焦点/选中态」的复杂度。
// Esc 保留了，那个是肌肉记忆。
// ============================================================================

use gpui::*;

use crate::theme::{FontSize, Radius, Tokens};

/// 菜单里的一项。
pub enum MenuItem {
    /// 一个动作。点了之后派发 action，然后关掉菜单。
    ///
    /// 用 `Box<dyn Action>` 而不是闭包：调用点（sidebar）是泛型的
    /// （`render_sidebar<T>`），拿不到 `&mut ChatView`，而这几个动作
    /// 都要改它的状态。action 由 ChatView 的 `on_action` 接。
    Action(String, Box<dyn Action>),
    /// 分隔线。
    Separator,
}

impl MenuItem {
    pub fn action(label: impl Into<String>, action: Box<dyn Action>) -> Self {
        Self::Action(label.into(), action)
    }
}

/// 行高。和 picker.rs 的下拉行一致 —— 两者都是「浮层里的一列可点项」，
/// 没理由不一样。比侧边栏的 28 矮一点，理由见 picker.rs 的 ROW_HEIGHT。
const ROW_HEIGHT: f32 = 26.;

/// 最小宽度。比库里那个 `rems(8.)`（128px）宽一点 ——
/// 「移除项目」四个字加 padding 刚好顶到 128，太挤。
const MIN_WIDTH: f32 = 150.;

/// 菜单的状态。跨帧存活，靠 `window.use_keyed_state` 挂在元素上。
struct MenuState {
    /// None = 没开。Some(p) = 开着，且左上角在窗口坐标 p。
    ///
    /// 位置存在状态里而不是每帧算：菜单要钉在**右键那一下**的位置，
    /// 而不是跟着行走（行会因为列表滚动而移动）。
    open: Option<Point<Pixels>>,
    /// 菜单自己的焦点。只为了收 Esc —— 见文件头。
    focus: FocusHandle,
    /// 打开前焦点在谁身上，关掉时还回去。
    ///
    /// 不还的话焦点留在一个已经消失的元素上，composer 就打不了字了。
    prev_focus: Option<FocusHandle>,
}

/// 给一个元素挂上右键菜单。
///
/// 返回同一个类型（不是 AnyElement），所以调用点该链什么还能接着链。
///
/// `id` 必须在整棵树里唯一且**跨帧稳定** —— gpui 靠它找回上一帧的状态，
/// 用带 index 的 id（比如 `menu-3`）会在列表增删时把状态串到别的行上。
/// 两个调用点用的都是 `session-<id>` / `project-<id>` 这种业务 id。
pub fn attach<E, T>(
    element: E,
    id: impl Into<ElementId>,
    items: Vec<MenuItem>,
    window: &mut Window,
    cx: &mut Context<T>,
) -> E
where
    E: ParentElement + InteractiveElement,
    T: 'static,
{
    let state = window.use_keyed_state(id.into(), cx, |_, cx| MenuState {
        open: None,
        focus: cx.focus_handle(),
        prev_focus: None,
    });

    let open_at = state.read(cx).open;

    // --- 右键：记下位置、抢焦点 ---
    let st = state.clone();
    let element = element.on_mouse_down(MouseButton::Right, move |ev, window, cx| {
        // 必须 stop_propagation：gpui 的鼠标事件是冒泡的，嵌套时最内层先跑。
        // 不拦的话内层把自己的 open 置上之后，外层那个也会置上它自己的 ——
        // 两个菜单同时开着。
        //
        // 目前没有嵌套的场景（项目行和会话行是兄弟不是父子），
        // 但拦掉是对的，将来嵌套了不会变成一个诡异的 bug。
        cx.stop_propagation();
        let prev = window.focused(cx);
        st.update(cx, |s, cx| {
            s.open = Some(ev.position);
            // 只在**第一次**打开时记 —— 菜单开着的时候焦点已经是我们自己了，
            // 再记一次就把「原来在哪」覆盖成菜单自己，关掉后焦点归还给一个
            // 不存在的元素。
            if s.prev_focus.is_none() {
                s.prev_focus = prev;
            }
            s.focus.focus(window, cx);
            cx.notify();
        });
    });

    let Some(pos) = open_at else {
        return element;
    };

    // --- 关掉菜单：一个地方收口 ---
    //
    // 闭包而不是方法，因为下面三处（点项、点外面、Esc）都要用，
    // 而它们各自捕获的东西不同。
    let close = {
        let st = state.clone();
        std::rc::Rc::new(move |window: &mut Window, cx: &mut App| {
            st.update(cx, |s, cx| {
                s.open = None;
                // 焦点归还。take() 是必须的 —— 下次打开要重新记。
                if let Some(prev) = s.prev_focus.take() {
                    prev.focus(window, cx);
                }
                cx.notify();
            });
        })
    };

    let mut panel = div()
        .flex()
        .flex_col()
        // 这就是这个文件存在的理由：**项与项之间没有 gap**。
        // 库里那行 `.gap_y_0p5()` 在这儿的对应位置上，什么都不写。
        .min_w(px(MIN_WIDTH))
        .p(px(4.))
        .rounded(Radius::card())
        .bg(Tokens::overlay())
        .border_1()
        // 浮层用 line_strong 而不是 line：line 和 overlay 几乎同色，等于没有边。
        // 这跟 styles.css 里 `--shadow-overlay` 那条 1px ring 取的是同一个值。
        .border_color(Tokens::line_strong())
        .shadow_lg()
        .text_size(FontSize::xs())
        // 收 Esc 要焦点，见文件头
        .track_focus(&state.read(cx).focus)
        // 点浮层内部的空白不该关掉它，也不该穿透到下面的行上
        .occlude();

    // --- Esc 关闭 ---
    {
        let close = close.clone();
        panel = panel.on_key_down(move |ev: &KeyDownEvent, window, cx| {
            if ev.keystroke.key == "escape" {
                cx.stop_propagation();
                close(window, cx);
            }
        });
    }

    // --- 点外面关闭 ---
    {
        let close = close.clone();
        panel = panel.on_mouse_down_out(move |_, window, cx| close(window, cx));
    }

    for (ix, item) in items.into_iter().enumerate() {
        match item {
            MenuItem::Separator => {
                panel = panel.child(
                    div()
                        // 负 margin 让分隔线铺满整个浮层宽度（顶掉容器那 4px padding）——
                        // 缩在里面的短线看着像个断掉的下划线
                        .mx(px(-4.))
                        // **上下不留 margin**：项与项之间不要缝。
                        // 原来这里是 `.my(px(4.))`，那 4+1+4 就是「item 之间有 gap」
                        // 的来源 —— panel 上本来就没有 gap，缝全在这条线上。
                        .h(px(1.))
                        .flex_none()
                        .bg(Tokens::line()),
                );
            }
            MenuItem::Action(label, action) => {
                let close = close.clone();
                panel = panel.child(
                    div()
                        .id(ElementId::Integer(ix as u64))
                        .w_full()
                        .flex()
                        .h(px(ROW_HEIGHT))
                        .flex_none()
                        .items_center()
                        .px(px(8.))
                        // 容器 card(10) 装 chip(6)，和 picker 的行一致
                        .rounded(Radius::chip())
                        .cursor_pointer()
                        .text_color(Tokens::ink_2())
                        // hover 用 overlay_hover 而不是页面那个 hover ——
                        // 后者比浮层底色还暗，划过去看着像凹进去。
                        // 见 Tokens::overlay_hover 的注释。
                        .hover(|s| s.bg(Tokens::overlay_hover()).text_color(Tokens::ink()))
                        .child(label)
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            cx.stop_propagation();
                            // 先关再派发：反过来的话 action 可能把这一行整个删掉
                            //（「删除会话」就是），然后我们再去 update 一个
                            // 已经不渲染的元素状态 —— 不会崩，但那一帧菜单还留在屏幕上。
                            close(window, cx);
                            window.dispatch_action(action.boxed_clone(), cx);
                        }),
                );
            }
        }
    }

    // deferred + anchored：菜单要画在整棵树**之上**，而它挂在一个
    // `overflow_y_scroll` 的列表里 —— 不 defer 的话会被列表裁掉。
    // priority 跟库里的浮层取同一个值，免得和 Popover 抢层级。
    element.child(
        deferred(
            anchored()
                .position(pos)
                // 贴到窗口边时自己往里收，不然靠底部的行右键出来的菜单
                // 会有一半在窗口外
                .snap_to_window_with_margin(px(8.))
                .child(panel),
        )
        .with_priority(gpui_base::POPUP_PRIORITY),
    )
}
