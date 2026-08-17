// ============================================================================
// cli/main.rs —— 终端入口（对应 TS 版 cli.ts 的核心部分）
// ----------------------------------------------------------------------------
// 存在的意义是「在接 gpui 之前先证明 core 真的能工作」。所有装饰器在这里
// 装配起来，跑通了说明 UI 层只需要换个渲染方式，不用碰逻辑。
//
// 装配顺序（从内到外）：
//   HttpCallModel                    发请求
//     → WithFallback(主, 备用)        主模型挂了换备用
//       → Retrying                   429 / 5xx / 超时退避重试
//         → Cached                   命中就不联网
//
// 注意重试包在降级**外面**：主模型重试到用尽才降级。
// 反过来包会变成「主模型一失败就降级，降级完的整体再重试」。
// ============================================================================

use std::io::Write as _;
use std::sync::Arc;

use anyhow::Result;
use smallest_agent_core::approval::{ApprovalOutcome, ApprovalRequest, Approver};
use smallest_agent_core::cancel::{CancelToken, is_cancelled};
use smallest_agent_core::llm::HttpCallModel;
use smallest_agent_core::load_config;
use smallest_agent_core::mcp_config;
use smallest_agent_core::memory::{
    CompactHook, JsonSessionStore, ModelSummarizer, SaveSessionHook, SessionStore, estimate_tokens,
};
use smallest_agent_core::provider::{BuiltinProvider, EventSink, Provider, TurnEvent, TurnRequest};
use smallest_agent_core::types::ToolRegistry;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    // 从 .env 读配置。dotenv 的活自己做——只为读一个文件不值得引依赖。
    load_dotenv(".env");
    let config = load_config()?;

    let question = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    if question.trim().is_empty() {
        eprintln!("用法：smallest-agent <你的问题>");
        eprintln!();
        eprintln!("环境变量（.env 里配）：");
        eprintln!("  DEEPSEEK_API_KEY   必填");
        eprintln!("  SESSION_ID         会话标识，默认 default");
        eprintln!("  STREAM=0           关掉流式输出");
        eprintln!("  LLM_CACHE=0        关掉磁盘缓存");
        std::process::exit(2);
    }

    // 连 MCP server 拿工具。配置文件和桌面版共用（~/Library/Application
    // Support/smallest-agent/mcp.json），所以两边看到的工具一致。
    //
    // 连接对象要一直活着 —— drop 了子进程就被杀。绑在一个变量上而不是
    // let _ = ...，后者会立刻 drop。
    let mcp_config = mcp_config::load_config()?;
    let specs = mcp_config.to_specs();
    let mcp = if specs.is_empty() {
        None
    } else {
        eprintln!("\x1b[2m[连接 {} 个 MCP server…]\x1b[0m", specs.len());
        Some(
            smallest_agent_core::mcp::load_mcp_tools_from_servers(
                &specs,
                &smallest_agent_core::mcp::default_connect,
            )
            .await?,
        )
    };
    let tools = match &mcp {
        Some(m) => {
            eprintln!(
                "\x1b[2m[{} 个工具可用：{}]\x1b[0m",
                m.tools.len(),
                m.tools.keys().cloned().collect::<Vec<_>>().join(", ")
            );
            m.tools.clone()
        }
        None => ToolRegistry::new(),
    };

    // Ctrl-C 走取消而不是直接杀进程：杀进程会在写会话文件的中途断掉，
    // 留下半个 JSON（下次加载会当损坏文件跳过，这一轮对话就丢了）。
    // 取消路径会把消息存完再退出。
    let cancel = CancelToken::new();
    {
        let cancel = cancel.clone();
        let _ = ctrlc_handler(move || {
            eprintln!("\n[正在停止…]");
            cancel.cancel();
        });
    }

    let store: Arc<dyn SessionStore> = Arc::new(JsonSessionStore::new(&config.sessions_dir)?);

    // 载入历史，打一行让人看见记忆确实在起作用
    let history = store.load(&config.session_id).await?;
    if !history.is_empty() {
        eprintln!(
            "\x1b[2m[会话 {} · {} 条历史 · 约 {} tokens]\x1b[0m",
            config.session_id,
            history.len(),
            estimate_tokens(&history)
        );
    }

    // 摘要用一条独立的轻链（不带缓存和取消），理由同桌面版
    let summarizer = Arc::new(ModelSummarizer::new(Arc::new(HttpCallModel::new(
        &config,
        ToolRegistry::new(),
    )?)));
    let provider = BuiltinProvider::new(config.clone(), tools)?
        .with_approver(Arc::new(StdinApprover))
        .with_compact(Arc::new(CompactHook::new(
            config.max_context_tokens as usize,
            config.keep_recent,
            summarizer,
        )))
        .with_on_complete(Arc::new(SaveSessionHook::new(
            store,
            config.session_id.clone(),
        )));

    // 事件直接打终端。这是和桌面版唯一的差别 —— 那边发 channel 给主线程。
    let stream = config.stream;
    let events: EventSink = Arc::new(move |ev: TurnEvent| match ev {
        TurnEvent::Delta(d) => {
            if stream {
                print!("{d}");
                let _ = std::io::stdout().flush();
            }
        }
        TurnEvent::ToolCall {
            turn,
            name,
            args,
            output,
        } => {
            let args = serde_json::to_string(&args).unwrap_or_default();
            // 工具输出可能很长，截断显示
            let preview: String = output.chars().take(120).collect();
            let ellipsis = if output.chars().count() > 120 {
                "…"
            } else {
                ""
            };
            eprintln!("\x1b[2m[第 {turn} 轮] {name} {args} → {preview}{ellipsis}\x1b[0m");
        }
        TurnEvent::CacheHit => eprintln!("\x1b[2m[缓存命中]\x1b[0m"),
        TurnEvent::Fallback(err) => eprintln!("\x1b[33m[降级到备用模型：{err}]\x1b[0m"),
        TurnEvent::Notice(msg) => eprintln!("\x1b[2m[{msg}]\x1b[0m"),
    });

    let answer = match provider
        .run_turn(TurnRequest {
            question,
            history,
            events,
            cancel,
        })
        .await
    {
        Ok(text) => text,
        // 取消不是错误：正常退出，让用户看到已经打出来的部分
        Err(err) if is_cancelled(&err) => {
            println!();
            eprintln!("[已停止]");
            return Ok(());
        }
        Err(err) => return Err(err),
    };

    // 流式模式下正文已经边收边打了，这里只补个换行；非流式要完整打出来。
    if config.stream {
        println!();
    } else {
        println!("{answer}");
    }
    // 优雅关掉子进程。不做的话它们被 SIGKILL，某些 server 会留下临时文件。
    if let Some(m) = &mcp {
        let _ = m.close().await;
    }
    Ok(())
}

/// 极简 .env 读取：KEY=VALUE 一行一个，# 开头是注释。
///
/// 已存在的环境变量优先，不覆盖 —— 命令行临时指定的应该赢过文件里的。
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
        // 去掉可能的引号
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if std::env::var_os(key).is_none() {
            // SAFETY: 单线程启动阶段，还没起任何后台线程
            unsafe { std::env::set_var(key, value) };
        }
    }
}

/// 装 Ctrl-C 处理器。
///
/// 自己写而不是引 ctrlc crate：只要一个 signal handler，为它加一个依赖不值。
/// 用 libc::signal 而不是 sigaction —— 后者的结构体在各平台上不一样，
/// 而这里只需要「收到就调一次」这个最简语义。
fn ctrlc_handler(f: impl Fn() + Send + Sync + 'static) -> Result<()> {
    use std::sync::OnceLock;
    static HANDLER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    // handler 里不能分配内存也不能加锁（signal-safety），所以只做一件事：
    // 调那个提前存好的闭包。闭包里也只调 CancelToken::cancel —— 它是
    // 一次原子写 + 唤醒 waker，没有分配。
    extern "C" fn on_sigint(_: libc::c_int) {
        if let Some(f) = HANDLER.get() {
            f();
        }
    }

    let boxed: Box<dyn Fn() + Send + Sync> = Box::new(f);
    HANDLER
        .set(boxed)
        .map_err(|_| anyhow::anyhow!("Ctrl-C 处理器已经装过了"))?;
    // SAFETY: on_sigint 只读一个已初始化的 OnceLock 并调用其中的闭包，
    // 不分配、不加锁，满足 signal handler 的约束。
    unsafe {
        libc::signal(libc::SIGINT, on_sigint as *const () as libc::sighandler_t);
    }
    Ok(())
}

/// 从终端读一行来回答审批。
///
/// 桌面版弹卡片，命令行只能问 stdin。用 spawn_blocking 而不是直接读：
/// 读 stdin 会阻塞，而这个调用点在 async 上下文里 —— 直接读会把整个
/// 运行时的那个工作线程卡住（我们只有一个，见 runtime.rs）。
struct StdinApprover;

#[async_trait::async_trait]
impl Approver for StdinApprover {
    async fn request(&self, req: ApprovalRequest) -> ApprovalOutcome {
        // 提示打到 stderr：stdout 是模型答案，混在一起没法管道处理
        eprintln!();
        eprintln!("\x1b[33m┌ {}\x1b[0m", req.title);
        for line in req.detail.lines().take(20) {
            eprintln!("\x1b[2m│ {line}\x1b[0m");
        }
        let labels: Vec<String> = req
            .options
            .iter()
            .enumerate()
            .map(|(i, o)| format!("{}) {}", i + 1, o.label))
            .collect();
        eprint!("\x1b[33m└ {} > \x1b[0m", labels.join("  "));
        let _ = std::io::stderr().flush();

        let answer = tokio::task::spawn_blocking(|| {
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).ok().map(|_| line)
        })
        .await
        .ok()
        .flatten();

        // 读不到（stdin 被关了、管道模式）当拒绝 —— 安全默认值
        let Some(line) = answer else {
            eprintln!("\x1b[2m（读不到输入，按拒绝处理）\x1b[0m");
            return ApprovalOutcome::Cancelled;
        };
        match line.trim().parse::<usize>() {
            Ok(n) if n >= 1 && n <= req.options.len() => {
                ApprovalOutcome::Selected(req.options[n - 1].id.clone())
            }
            // 乱输入也当拒绝，不重问 —— 重问会在管道模式下变成死循环
            _ => {
                eprintln!("\x1b[2m（没选有效选项，按拒绝处理）\x1b[0m");
                ApprovalOutcome::Cancelled
            }
        }
    }
}
