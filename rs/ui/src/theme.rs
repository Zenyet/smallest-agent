// ============================================================================
// theme.rs —— 设计 token，从 Electron 版 styles.css 逐值移植
// ----------------------------------------------------------------------------
// 那套 token 是从 beautifului.dev 生产环境 CSS 提取的真实值（取 .dark 那一套），
// 不是随手调的配色。所以这里逐个抄过来，不重新发明。
//
// styles.css 顶部记的两个要点，在 gpui 里同样适用：
//
//   1. 颜色按语义命名（page / canvas / surface / inset / field），不是层级编号。
//      page 是窗口底色，canvas 是侧边栏，surface 是抬起的卡片，
//      inset 是凹陷区（代码块），field 是输入控件。别拿 surface 当边框用。
//
//   2. 边界一律用 `border_1() + border_color(...)`，**不要**用 box-shadow
//      去模拟 CSS 的 ring（`0 0 0 1px`）。原来那套 hairline 试过，
//      在滚动容器里会被裁掉左右两边 —— 详见下面「关于卡片边界」那段。
//
// 还有一条比配色更决定观感的：**13px 基准 + medium 字重 + 紧凑间距**。
// styles.css 的注释专门强调了这点（「之前只换了颜色没换尺度，所以看着还是糙」），
// 字号层级全在 13px 及以下：13 / 12.5 / 12 / 11.5 / 11。
// ============================================================================

use gpui::{Hsla, Rgba, px, rgb, rgba};

use crate::assets::{FONT_MONO, FONT_SANS};

/// 一套完整的颜色 token。
///
/// 只做深色 —— 和 Electron 版 v1 的取舍一致（styles.css 注释里写了）。
/// 不跟随系统明暗：这套 token 没有对应的浅色值，凑一套出来会破坏它的调性。
pub struct Tokens;

#[allow(dead_code)] // 有几个 token 目前还没用到，但保留完整一套便于后续对齐
impl Tokens {
    // --- 表面：按用途，从窗口底色到输入控件 ---
    //
    // page 和 canvas 带 alpha，配 WindowBackgroundAppearance::Blurred 用 ——
    // 毛玻璃要能透出后面的东西才有质感，纯不透明色开了 Blurred 也看不出区别。
    // 往上的层（surface / inset / field）保持不透明：它们是叠在 page 上的卡片，
    // 再半透明就会互相透叠，层次反而糊掉。
    //
    // alpha 取 0xf2（95%）而不是更低：这套配色本身很暗，透太多会被桌面壁纸
    // 拉亮，token 之间那几个色阶的差别就没了。
    /// 窗口底色
    pub fn page() -> Hsla {
        rgba(0x17181af2).into()
    }
    /// 侧边栏。比 page 再透一点，边缘的毛玻璃更明显
    pub fn canvas() -> Hsla {
        rgba(0x1c1d1fe8).into()
    }
    /// 抬起的卡片（助手气泡、composer）
    pub fn surface() -> Hsla {
        rgb(0x232427).into()
    }
    /// 凹陷区（代码块、工具输出）
    pub fn inset() -> Hsla {
        rgb(0x1f2022).into()
    }
    /// 输入控件、用户气泡
    pub fn field() -> Hsla {
        rgb(0x2b2c2f).into()
    }

    // --- 浮层 ---
    //
    // ## 为什么浮层不能用 surface
    //
    // 原来 popover / 下拉 / 右键菜单都用 surface（0x232427）。它只比 page
    // （0x17181a）亮一点点，而**浮层是这套色阶里离观察者最近的一层** ——
    // 它悬在所有内容之上，色阶上必须明显更亮，否则看着像沉进背景里
    // 而不是浮在上面。表现出来就是「弹出来那块太黑了」。
    //
    // 抬到 0x2f3034：比 surface 亮一档、比 field（0x2b2c2f）也亮，
    // 因为浮层里可能**装着**输入控件，装它的容器不该比里面的东西暗。
    /// 浮层容器（popover、下拉菜单、右键菜单）
    pub fn overlay() -> Hsla {
        rgb(0x2f3034).into()
    }
    /// 浮层里的 hover。比 overlay 再亮一档 ——
    /// 页面上那个 hover（0x2a2b2e）在浮层里比底色还暗，会反过来看着像凹陷
    pub fn overlay_hover() -> Hsla {
        rgb(0x3b3c41).into()
    }

    // --- 文字：三级，别再加第四级 ---
    pub fn ink() -> Hsla {
        rgb(0xf2f3f4).into()
    }
    pub fn ink_2() -> Hsla {
        rgb(0xa5a8ad).into()
    }
    pub fn ink_3() -> Hsla {
        rgb(0x9a9da3).into()
    }

    // --- 描边与悬停 ---
    pub fn line() -> Hsla {
        rgb(0x2e3033).into()
    }
    pub fn line_strong() -> Hsla {
        rgb(0x3a3c40).into()
    }
    pub fn hover() -> Hsla {
        rgb(0x2a2b2e).into()
    }
    pub fn hover_2() -> Hsla {
        rgb(0x313236).into()
    }

    // --- 强调色与状态色，每个配一个 tint 做低饱和底 ---
    pub fn accent() -> Hsla {
        rgb(0x3d9aff).into()
    }
    pub fn accent_ink() -> Hsla {
        rgb(0x7ec0ff).into()
    }
    pub fn accent_tint() -> Hsla {
        // CSS 里是 #3d9aff29，末两位是 alpha（0x29 ≈ 0.16）
        rgba(0x3d9aff29).into()
    }
    pub fn green() -> Hsla {
        rgb(0x3dbb72).into()
    }
    pub fn green_tint() -> Hsla {
        rgba(0x3dbb7224).into()
    }
    pub fn orange() -> Hsla {
        rgb(0xf68f3c).into()
    }
    pub fn orange_tint() -> Hsla {
        rgba(0xf68f3c24).into()
    }
    pub fn red() -> Hsla {
        rgb(0xee5c61).into()
    }
    pub fn red_tint() -> Hsla {
        rgba(0xee5c6124).into()
    }
}

/// 圆角：按控件类型，不按尺寸。
#[allow(dead_code)]
pub struct Radius;

#[allow(dead_code)]
impl Radius {
    pub fn window() -> gpui::Pixels {
        px(14.)
    }
    /// 卡片：气泡、composer、审批卡
    pub fn card() -> gpui::Pixels {
        px(10.)
    }
    /// 控件：列表行、按钮
    pub fn control() -> gpui::Pixels {
        px(8.)
    }
    /// 小件：badge、图标按钮
    pub fn chip() -> gpui::Pixels {
        px(6.)
    }
}

/// 字号层级。全在 13px 及以下，见文件头。
#[allow(dead_code)]
pub struct FontSize;

#[allow(dead_code)]
impl FontSize {
    /// 正文
    pub fn base() -> gpui::Pixels {
        px(13.)
    }
    /// 列表行、次要按钮
    pub fn sm() -> gpui::Pixels {
        px(12.5)
    }
    /// 工具调用摘要
    pub fn xs() -> gpui::Pixels {
        px(12.)
    }
    /// badge、提示文字
    pub fn xxs() -> gpui::Pixels {
        px(11.5)
    }
    /// 分区标签、计数
    pub fn tiny() -> gpui::Pixels {
        px(11.)
    }
}

// ============================================================================
// 关于卡片边界：为什么这里没有 shadow_card / shadow_hairline 了
// ----------------------------------------------------------------------------
// 原来有两个辅助函数，用 box-shadow 画卡片的边界 —— 第一层是
// `spread_radius: 1px, blur: 0` 的阴影，模拟 CSS 的 `0 0 0 1px`（ring），
// 后面叠两层柔和投影。理由写得很充分：ring 不占布局空间，而 border 会让
// 内容区少 2px，嵌套卡片叠起来偏移就看得出来。
//
// 两个实测问题把它否掉了：
//
//   1. **被裁掉**。gpui 给 `overflow_*_scroll` 的容器加了 ContentMask，
//      裁剪范围**就是容器自己的 bounds**（见 gpui 的 Style::overflow_mask）。
//      而 spread 出去的那 1px 在子元素 bounds **之外** —— 子元素撑满宽度时
//      （`w_full` 或 flex 拉伸），左右两边的 ring 正好落在裁剪线外面，
//      于是卡片看起来「左右边被裁了」，上下反而还在。
//      这四个独立页面和设置页的内容区全是滚动容器，所以每张卡都中招。
//
//   2. **慢**。三层阴影（两层带 blur）每帧对每张卡重画一遍。
//      Electron 版那边气泡就是纯色 + 1px 边框。
//
// 现在统一用 `border_1() + border_color(...)`：占布局空间，但在裁剪范围内，
// 而且便宜。配色规则是底色深浅决定的 ——
//   • `surface()`（抬起的卡片）配 `line_strong()`
//   • `inset()`（凹陷块）配 `line()`
// 和 chat.rs 里消息气泡用的是同一套。
//
// 「border 占 2px 导致嵌套偏移」那个顾虑没有落地成实际问题：卡片是
// flex 布局撑开的，2px 由容器吸收，不会层层累加。
// ============================================================================

/// 把 Rgba 转 Hsla 的辅助（gpui 的 rgb()/rgba() 返回 Rgba，多数样式方法要 Hsla）。
#[allow(dead_code)]
pub fn hsla(c: Rgba) -> Hsla {
    c.into()
}

/// Markdown 渲染样式。
///
/// 三处必须自己设，默认值在深色底上是错的：
///   • `highlight_theme` 默认是 `default_light()`，代码高亮会用浅色配色
///   • `is_dark` 默认 false，影响组件内部的若干判断
///   • 代码块默认没有底色。Electron 版用的是 **inset（凹陷）而不是 surface（抬起）**
///     —— styles.css 里 `.bubble__text pre` 那条注释专门点了这个区别，
///     代码块是嵌进气泡里的，不该看起来浮在上面。
pub fn markdown_style() -> gpui_component::text::TextViewStyle {
    use gpui::StyleRefinement;
    use gpui_component::highlighter::HighlightTheme;

    // clippy 建议改成结构体字面量，但 StyleRefinement 的这几个字段是
    // Option<Corners<Option<..>>> 这类嵌套形状，写字面量要把每层都拼出来，
    // 比逐个赋值更长也更容易写错。逐个赋值在这里是更清楚的选择。
    #[allow(clippy::field_reassign_with_default)]
    let code_block = {
        let mut c = StyleRefinement::default();
        c.background = Some(Tokens::inset().into());
        c.corner_radii.top_left = Some(Radius::control().into());
        c.corner_radii.top_right = Some(Radius::control().into());
        c.corner_radii.bottom_left = Some(Radius::control().into());
        c.corner_radii.bottom_right = Some(Radius::control().into());
        c.padding.top = Some(px(10.).into());
        c.padding.bottom = Some(px(10.).into());
        c.padding.left = Some(px(12.).into());
        c.padding.right = Some(px(12.).into());
        // 长行横向滚动而不是硬折 —— 代码折行会破坏缩进结构
        c.overflow.x = Some(gpui::Overflow::Scroll);
        // ## 必须跟着 overflow.x 一起设，否则滚动会串轴
        //
        // gpui 默认 `restrict_scroll_to_axis = false`（style.rs:781），这时
        // 滚动增量会**跨轴重映射**：一个只声明了 x 轴滚动的容器，收到纵向
        // 增量时会把 `delta.y` 当成 `delta_x` 用（div.rs:3218 那个分支的条件
        // 就是 `!restrict_scroll_to_axis && overflow.y != Scroll`）。
        //
        // 表现出来就是：鼠标停在代码块上纵向滚，代码块自己横着跑 ——
        // 而外层对话区同时也在纵向滚，两个一起动就是「抖动」。
        //
        // 设成 true 之后走的是另一条路：`ongoing_scroll.filter()`
        // 把手势锁在它一开始的主轴上（触控板的 precise 增量才有这个锁），
        // 并且**关掉跨轴重映射** —— 这正是 Style::restrict_scroll_to_axis
        // 的文档说的「horizontal input will not scroll a container that only
        // has vertical overflow enabled」。
        //
        // 注意这只治一半：横向滚动带出纵向是**外层**纵向容器在把 `delta.x`
        // 当 `delta_y`（div.rs:3226 的对称分支），那边看的是它自己的 flag，
        // 跟这里设什么无关。配套的另一半在 chat.rs 对话区那个滚动容器上。
        c.restrict_scroll_to_axis = Some(true);
        c
    };

    let mut style = gpui_component::text::TextViewStyle::default()
        // 段间距默认 1rem，在气泡里太散。0.5rem 贴合 Electron 版的 leading-relaxed 观感
        .paragraph_gap(gpui::rems(0.5))
        .code_block(code_block);
    style.highlight_theme = HighlightTheme::default_dark().clone();
    style.is_dark = true;
    style
}

// ============================================================================
// 把组件库的 Theme 对齐到我们的 token
// ----------------------------------------------------------------------------
// 这一步不做的后果是个真 bug：`gpui_component::init()` 里写死了
// `Theme::change(ThemeMode::Light)`，所以组件库里所有东西（Input、Button、
// PopupMenu、TextView 的表格边框…）都按**浅色**渲染。
//
// 表现出来就是输入框白底白字看不见 —— 我自己画的 div 用的是 Tokens，
// 组件用的是它自己那套 Theme，两套颜色各走各的。
//
// ## 实际是**三套**，不是两套
//
// 后来又踩到一次（右键菜单又黑又方），才发现颜色有三个来源：
//
//   1. 我们的 `Tokens`            —— 我手写的 div 用
//   2. `gpui_component::Theme`    —— 组件用，字段是**实时**的
//   3. `gpui_base::Theme.tokens`  —— 底层 crate 用（画浮层的 popover_style
//                                    就在这儿），是 1→2 之后拍的**快照**
//
// 第 3 层最容易漏：它只在 `Theme::change()` 里算一次，所以「先 change、
// 再改字段」这个顺序下，改完的字段它一个都看不见。对齐必须对到第 3 层，
// 见 apply_theme 末尾。
// ============================================================================

/// 在 gpui_component::init(cx) **之后**调用。
pub fn apply_theme(cx: &mut gpui::App) {
    use gpui_component::{Theme, ThemeMode};

    // 先切到 dark：这一步会把整套 ThemeColor 换成深色基线，
    // 下面的覆盖只是把几个关键色精确对到我们的 token 上。
    // 不切的话得逐个覆盖几十个字段，漏一个就是一处浅色残留。
    Theme::change(ThemeMode::Dark, None, cx);

    let theme = Theme::global_mut(cx);

    // 字体：组件内部渲染文字时用这两个，不设的话组件里是系统字体、
    // 我画的 div 是 Inter，同一行里两种字体并排。
    theme.font_family = FONT_SANS.into();
    theme.mono_font_family = FONT_MONO.into();
    theme.font_size = FontSize::base();

    // ## 圆角：容器 card(10) / 项 control(8)，正好是 token 表里差一档的那对
    //
    // 浮层容器（右键菜单、下拉菜单）的圆角是 `tokens.radius.md`，由
    // `radius_tokens()` 从 `theme.radius` 直接推出来（mod.rs:289 `md: self.radius`）。
    // 菜单**项**的圆角则是 `theme.radius.min(px(8.))`（popup_menu.rs:1424）。
    //
    // 所以 radius 设 8 的话，容器和项都是 8 —— **内外一样大**，
    // 内容顶着容器边缘，看着就是「圆角太小」。
    //
    // 设 card(10)：容器 10、项被那个 min 夹到 8（正好落在 control 上），
    // 差一档，内容嵌在容器里 —— 就是 Radius 里「卡片装控件」的那层关系。
    // 之前这里写的是 px(12.)，12 不在 token 表里；浮层没有理由是唯一的例外，
    // 而且 radius 还管着 Input 的圆角（input.rs:579），一处特例会漏到输入框上。
    theme.radius = Radius::card();
    theme.radius_lg = Radius::card();

    let c = &mut theme.colors;
    // 表面
    c.background = Tokens::page();
    c.foreground = Tokens::ink();
    c.border = Tokens::line();
    // input 是输入框的边框色，输入框底色走 Theme::input_background()，
    // 它是从 background 推的，所以上面设了 background 就够
    c.input = Tokens::line_strong();
    c.ring = Tokens::accent();

    // 次要表面：菜单、popover、卡片。
    //
    // popover 用 overlay 而不是 surface：浮层是离观察者最近的一层，
    // 色阶上必须明显更亮，否则看着像沉进背景。见 Tokens::overlay 的注释。
    // 这一个字段管住组件库里所有浮层（PopupMenu、Popover、下拉），
    // 因为它们的底色都从 `tokens.colors.surface` 取，而那个是从这里推的
    // （mod.rs 的 color_tokens：`surface: self.popover`）。
    //
    // 注意：光设这一行**不够** —— 浮层实际读的是 gpui_base 那份快照，
    // 而快照在这之前就拍好了。函数末尾那段重投是配套的，别只留一半。
    c.popover = Tokens::overlay();
    c.popover_foreground = Tokens::ink();
    // 浮层的描边走的是**全局** border（下面那个 `c.border` = line，0x2e3033），
    // 组件库没有单独的 popover 边框色（popover_style 里就是
    // `border_color(tokens.colors.border)`）—— line 和 overlay（0x2f3034）
    // 几乎同色，等于没有边框。
    //
    // 这条边在函数末尾**单独给了** line_strong：在那份快照里 border 的唯一
    // 读者就是 popover_style，所以能只动浮层、不波及页面上其它描边。
    // （原来这里记的是「刻意不改，提亮 border 会动到所有描边」——
    // 那个顾虑只在 gpui_component 那侧成立，快照这侧没有。）
    c.secondary = Tokens::inset();
    c.secondary_foreground = Tokens::ink_2();
    c.secondary_hover = Tokens::hover();
    c.secondary_active = Tokens::hover_2();
    c.muted = Tokens::inset();
    c.muted_foreground = Tokens::ink_3();

    // 主操作色。注意 primary_foreground 要和 primary 反相 ——
    // 我们的 primary 是亮色（ink），所以前景用 page 而不是 ink
    c.primary = Tokens::ink();
    c.primary_foreground = Tokens::page();
    c.primary_hover = Tokens::ink_2();
    c.primary_active = Tokens::ink_3();

    // 强调与状态色，和我们的 token 一一对上
    c.accent = Tokens::accent_tint();
    c.accent_foreground = Tokens::accent_ink();
    c.danger = Tokens::red();
    c.danger_foreground = Tokens::ink();
    c.success = Tokens::green();
    c.success_foreground = Tokens::page();
    c.warning = Tokens::orange();

    // ## 上面这些改动有一半到不了浮层 —— 必须手动把快照重投一次
    //
    // 踩过的坑，也是「右键菜单又黑又方」的真正原因：
    //
    // 画浮层容器的 `popover_style()` 不在 gpui-component 里，而在它底层的
    // **gpui-base** 里（base/src/styled.rs:169），读的是 `cx.theme().tokens`。
    // 那个 `cx.theme()` 解析到的是 `gpui_base::Theme` —— **另一个全局**，
    // 和我们上面 `Theme::global_mut()` 拿到的 `gpui_component::Theme` 是两回事。
    //
    // 而它里面的 tokens 是**快照**：只在 `Theme::change()` 里算一次
    // （ui/src/theme/mod.rs:196 `tokens: theme.semantic_tokens()`）。
    // 我们的顺序是「先 change(Dark)、再改字段」，所以快照拍的是改之前的
    // 库默认值，后面这几十行它一个都没看见。菜单**项**没这个问题 ——
    // 它读 `cx.theme()` 时解析到 gpui_component 那个 Theme，取的是实时字段。
    //
    // 于是就是之前看到的样子：项按我们的 token 渲染（圆角 8、hover 是 accent_tint），
    // 容器却还是库默认的 popover=neutral-950（近黑）+ radius=6 ——
    // 外面比里面还方，底色也不是我们那套灰。
    //
    // 修法不是调数值，是补一次投影：字段改完之后重算 `semantic_tokens()`
    // 写回 gpui_base 的全局。放在函数最末尾是必须的 —— 它是快照，
    // 之后任何一处 `theme.xxx = ...` 都不会再自动同步过来。
    //
    // 注：`Theme::change()` 之后要是又切主题（跟随系统明暗之类），
    // 快照会被重新拍成库默认值，这段得再跑一遍。目前只有深色一套、
    // 启动时调一次，所以没做成 observer。
    let tokens = theme.semantic_tokens();
    // 结束对 gpui_component::Theme 的可变借用，才能再借 gpui_base 那个全局
    let base = gpui_base::Theme::global_mut(cx);
    base.tokens = tokens;
    // 浮层的边框：这里能给它一条**看得见**的描边，而且不波及别处。
    //
    // 原来记的「不改」理由是「浮层边框走全局 border，提亮它会动到页面上
    // 每一处描边」。那个前提只在 gpui-component 那侧成立 —— 在这个快照里，
    // `colors.border` 的唯一读者就是 popover_style（base 里其余两处读的是
    // ring，滚动条和 resize handle 走各自的字段）。所以单独抬这一个，
    // 影响面正好只有浮层。
    //
    // 值取 line_strong，不是随手挑的：styles.css 里
    // `--shadow-overlay: 0 0 0 1px var(--color-line-strong), ...`
    // 写的就是浮层用 line_strong 那条 1px ring。等于把设计语言里
    // 本来就属于浮层的那个值补回来。
    base.tokens.colors.border = Tokens::line_strong();
}
