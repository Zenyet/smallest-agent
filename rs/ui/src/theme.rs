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
//   2. 边界用 hairline 而不是 border。CSS 那边是 box-shadow 的第一层
//      `0 0 0 1px var(--line)`；gpui 没有 ring，所以用 border_1 + border_color
//      近似 —— 视觉上差别在于 border 占布局空间，需要时用负 margin 补。
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

/// 卡片阴影：hairline ring + 两层柔和投影。
///
/// 这是那套设计的视觉签名 —— styles.css 里写了「边界用 hairline ring 而不是
/// border，shadow-card 的第一层是 0 0 0 1px var(--line)，叠上柔和投影」。
///
/// gpui 没有 CSS 的 ring，所以第一层用一个 spread 为 1px、blur 为 0 的阴影模拟，
/// 效果和 `box-shadow: 0 0 0 1px` 一致，而且不像 border 那样占布局空间
/// （border 会让内容区少 2px，一堆嵌套卡片叠起来偏移就看得出来）。
pub fn shadow_card() -> Vec<gpui::BoxShadow> {
    vec![
        gpui::BoxShadow {
            color: Tokens::line(),
            offset: gpui::point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(1.),
            inset: false,
        },
        gpui::BoxShadow {
            color: rgba(0x00000033).into(),
            offset: gpui::point(px(0.), px(1.)),
            blur_radius: px(2.),
            spread_radius: px(0.),
            inset: false,
        },
        gpui::BoxShadow {
            color: rgba(0x00000033).into(),
            offset: gpui::point(px(0.), px(2.)),
            blur_radius: px(6.),
            spread_radius: px(0.),
            inset: false,
        },
    ]
}

/// 只有 hairline，没有投影。用在不需要「抬起」感的地方（用户气泡、badge）。
pub fn shadow_hairline() -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow {
        color: Tokens::line(),
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(1.),
        inset: false,
    }]
}

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
// 把 gpui-component 的 Theme 对齐到我们的 token
// ----------------------------------------------------------------------------
// 这一步不做的后果是个真 bug：`gpui_component::init()` 里写死了
// `Theme::change(ThemeMode::Light)`，所以组件库里所有东西（Input、Button、
// PopupMenu、TextView 的表格边框…）都按**浅色**渲染。
//
// 表现出来就是输入框白底白字看不见 —— 我自己画的 div 用的是 Tokens，
// 组件用的是它自己那套 Theme，两套颜色各走各的。
//
// 所以凡是用了 gpui-component 组件的项目，都必须显式对齐这两套，
// 只设自己的 token 是不够的。
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

    // 圆角：组件默认的比我们这套小
    theme.radius = Radius::control();
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

    // 次要表面：菜单、popover、卡片
    c.popover = Tokens::surface();
    c.popover_foreground = Tokens::ink();
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
}
