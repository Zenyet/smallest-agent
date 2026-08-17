// ============================================================================
// assets.rs —— 打进二进制的字体
// ----------------------------------------------------------------------------
// ## 为什么这件事比配色更影响观感
//
// Electron 版 styles.css 的第一件事就是 `@import '@fontsource/inter/400.css'`，
// 整套 token 是按 Inter 的字宽和字重调出来的。gpui 不设字体就回落到系统默认
// （macOS 上是 SF Pro），字宽、字距、字重全不一样 —— 配色值搬得再准，
// 界面也会显得「糙」。这是第一版 gpui 界面和 Electron 版差距最大的一处，
// 而它跟布局代码一点关系都没有。
//
// 用可变字体（一个文件含全部字重）而不是每个字重一个静态文件：
// Inter 876KB + JetBrains Mono 187KB 就覆盖了 400/500/600 全部需求，
// 换成静态文件要 6 个文件、体积更大。
//
// 字体跟着二进制走（include_bytes）而不是从系统找：
// 桌面应用要能在没装 Inter 的机器上显示成一样，这和 Electron 版把字体
// 打进 bundle（而不是 CDN 外链）是同一个理由。
// ============================================================================

use std::borrow::Cow;

use anyhow::Result;
use gpui::App;

/// 正文字体族名。gpui 用族名查已注册的字体，字符串要和字体文件里的一致。
pub const FONT_SANS: &str = "Inter";
/// 等宽字体族名，代码块和工具输出用。
pub const FONT_MONO: &str = "JetBrains Mono";

const INTER: &[u8] = include_bytes!("../assets/fonts/Inter-Variable.ttf");
const JETBRAINS_MONO: &[u8] = include_bytes!("../assets/fonts/JetBrainsMono-Variable.ttf");

/// 注册字体。必须在开窗之前调用，否则第一帧会用系统默认字体渲染然后跳变。
pub fn register_fonts(cx: &App) -> Result<()> {
    cx.text_system()
        .add_fonts(vec![Cow::Borrowed(INTER), Cow::Borrowed(JETBRAINS_MONO)])
}
