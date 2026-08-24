// ============================================================================
// ui/main.rs —— gpui 桌面版入口
// ----------------------------------------------------------------------------
// 只做三件事：读配置、开窗、把 ChatView 挂上去。
// 逻辑全在 core，UI 状态在 chat.rs，跨线程的桥在 bridge.rs。
//
// gpui_component::init(cx) 必须是 app.run 闭包里的第一句，
// 否则主题和其它全局状态没初始化，组件行为会不对。
// ============================================================================

mod assets;
mod bridge;
mod chat;
mod context_menu;
mod history;
mod msg_times;
mod pages;
mod pane;
mod picker;
mod projects;
mod providers;
mod session_titles;
mod settings;
mod sidebar;
mod theme;

use gpui::*;
use gpui_component::Root;
use smallest_agent_core::load_config;

use crate::chat::ChatView;

fn main() {
    // 三层配置来源，优先级从高到低：环境变量 > .env > settings.json。
    // 三者都遵守「不覆盖已存在的环境变量」，所以先读的赢。
    load_dotenv_nearby();
    settings::apply_to_env(&settings::load_settings());

    let config = match load_config() {
        Ok(c) => c,
        Err(err) => {
            // 配置错误在开窗前就得报，否则用户看到一个空窗口不知道为什么
            // 错误自己已经把可用的键名列全了（见 config.rs），
            // 这里不再重复某一家的名字 —— 那会让想用别家的人以为
            // 必须先注册 DeepSeek
            eprintln!("配置有问题：{err:#}");
            std::process::exit(2);
        }
    };

    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(move |cx| {
        // 必须是第一句，见文件头
        gpui_component::init(cx);
        // 字体要在开窗前注册，否则第一帧用系统默认字体渲染然后跳变。
        // 这一步影响观感的程度超过任何单条配色 —— 见 assets.rs 文件头。
        if let Err(err) = assets::register_fonts(cx) {
            eprintln!("[fonts] 注册内置字体失败，将回落到系统字体：{err:#}");
        }
        // 必须在 gpui_component::init 之后：它里面写死了 ThemeMode::Light，
        // 不覆盖的话组件库全是浅色（输入框白底白字）。见 theme.rs。
        theme::apply_theme(cx);

        let window_options = WindowOptions {
            window_bounds: Some(WindowBounds::centered(size(px(980.), px(720.)), cx)),
            titlebar: Some(TitlebarOptions {
                title: Some("smallest-agent".into()),
                // 透明标题栏：去掉那条系统灰条，让侧边栏底色一直铺到窗口顶边。
                // 代价是要自己给红绿灯留位置（侧边栏顶部那 78px 留白就是干这个的）。
                appears_transparent: cfg!(target_os = "macos"),
                // 红绿灯位置。默认值配的是有标题栏的高度，透明标题栏下会偏 ——
                // (16, 17) 对齐 28px 行高的第一行，数值取自 waku。
                traffic_light_position: cfg!(target_os = "macos").then(|| point(px(16.), px(17.))),
            }),
            // macOS 上开毛玻璃。配套要求是 page / canvas 带 alpha ——
            // 纯不透明色开了这个也看不出区别，见 theme.rs 的注释。
            window_background: if cfg!(target_os = "macos") {
                WindowBackgroundAppearance::Blurred
            } else {
                WindowBackgroundAppearance::Opaque
            },
            // 窗口太窄时侧边栏 224px + 对话区会挤成一条，加个下限
            window_min_size: Some(size(px(720.), px(520.))),
            ..Default::default()
        };

        cx.spawn(async move |cx| {
            cx.open_window(window_options, |window, cx| {
                let view = cx.new(|cx| match ChatView::new(config, window, cx) {
                    Ok(v) => v,
                    // 这里失败只可能是建 HTTP client 或会话目录出错，
                    // 已经开窗了没法优雅退出，直接 panic 比静默一个坏界面好
                    Err(err) => panic!("初始化聊天界面失败：{err:#}"),
                });
                // 第一层必须是 Root，组件库的浮层（菜单、tooltip）挂在它上面
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("开窗失败");
        })
        .detach();
    });
}

/// 从可执行文件往上找 .env。
///
/// **不能只看当前工作目录**：双击 .app 启动时 cwd 是 `/`，`cargo run` 时 cwd
/// 取决于在哪个目录敲的命令。两种情况都找不到项目根的 .env，
/// 然后应用弹一句「Missing DEEPSEEK_API_KEY」直接退出 —— 看起来像配置没生效，
/// 实际是根本没读到文件。
///
/// 顺序：先 cwd（开发时最直觉），再从可执行文件所在目录往上逐级找。
/// target/debug/ 往上三级正好是项目根，所以 cargo run 无论从哪起都能命中。
fn load_dotenv_nearby() {
    if std::path::Path::new(".env").exists() {
        load_dotenv(".env");
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    // 最多往上 5 级：够覆盖 target/debug/ 和 .app/Contents/MacOS/ 两种布局
    let mut dir = exe.parent().map(|p| p.to_path_buf());
    for _ in 0..5 {
        let Some(d) = dir else { return };
        let candidate = d.join(".env");
        if candidate.exists() {
            load_dotenv(&candidate.to_string_lossy());
            return;
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
}

/// 极简 .env 读取：KEY=VALUE 一行一个，# 开头是注释。
///
/// 和 cli 那份是同一段代码。没抽到 core 是因为它属于「进程启动」这层关切，
/// core 是库不该碰进程环境；两个 bin 各留一份反而清楚。
fn load_dotenv(path: &str) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'');
        // 已存在的环境变量优先：命令行临时指定的应该赢过文件
        if std::env::var_os(key).is_none() {
            // SAFETY: 启动阶段，gpui 还没起，此时是单线程
            unsafe { std::env::set_var(key, value) };
        }
    }
}
