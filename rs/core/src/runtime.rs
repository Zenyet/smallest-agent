// ============================================================================
// runtime.rs —— 唯一的运行时接缝
// ----------------------------------------------------------------------------
// TS 版没有对应文件：Node 只有一个事件循环，不存在这个问题。
// Rust 这边有：gpui 用自己的执行器（smol 系），而 reqwest 和 tokio::time
// 都要 tokio 的 reactor / timer 才能跑，直接在 gpui 的执行器上 await 会 panic。
//
// 解法是进程级维护一个专用 tokio 运行时，需要它的活 spawn 进去，
// 外面 await 返回的 JoinHandle —— JoinHandle 底层是 oneshot，任何执行器上
// 都能 await。跨运行时的边界因此全部收敛到这个文件里，
// 上层（agent 循环、UI）完全不用知道 tokio 的存在。
//
// 为什么持有 Handle 而不是 Runtime：**在 async 上下文里 drop Runtime 会 panic**
// （"Cannot drop a runtime in a context where blocking is not allowed"）。
// gpui 里对象存在 view 状态上，view 在某个 async 闭包里被 drop 就会炸。
// Handle 是廉价句柄，哪都能 drop。代价是运行时活到进程结束不回收 ——
// 对桌面应用里唯一的 HTTP 后端来说是常规取舍。
// ============================================================================

use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context as _, Result};

/// 专用运行时的句柄。第一次调用时起线程建运行时，之后复用。
pub fn handle() -> &'static tokio::runtime::Handle {
    static HANDLE: OnceLock<tokio::runtime::Handle> = OnceLock::new();
    HANDLE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("smallest-agent-rt".into())
            .spawn(move || {
                // 单工作线程就够：同一时刻只有一个模型请求在飞。
                // enable_all 打开 io + time driver，reqwest 和 sleep 分别要这两个。
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .thread_name("smallest-agent-rt-worker")
                    .build()
                    .expect("建 tokio 运行时失败");
                tx.send(rt.handle().clone()).expect("传运行时句柄失败");
                // 永不返回，运行时因此一直活着驱动 spawn 进来的任务
                rt.block_on(std::future::pending::<()>());
            })
            .expect("起运行时线程失败");
        rx.recv().expect("等运行时句柄失败")
    })
}

/// 把一个需要 tokio 的 future 送进专用运行时跑，在**任何**执行器上 await 结果。
///
/// future 必须是 'static + Send（spawn 的要求），所以调用方得先把借用的东西
/// clone 成 owned 再搬进来。
pub async fn spawn<F, T>(fut: F) -> Result<T>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    handle()
        .spawn(fut)
        .await
        // JoinError 只在任务 panic 或被取消时出现，属于 bug 而非可重试错误
        .context("后台任务异常终止")
}

/// 把活送进专用运行时，同时盯着取消令牌 —— 谁先到算谁。
///
/// 取消时 abort 那个任务。abort 对 reqwest 来说意味着连接被丢弃、
/// 请求真的停下，而不是「结果算了但还在后台跑完」。这是「点停止立刻停」
/// 和「点停止还要等模型吐完」的区别。
///
/// 返回 Err(Cancelled) 而不是 Ok(None)：调用方多数情况要把它当错误往上抛，
/// Option 会让每一层都写一遍 match。
pub async fn spawn_cancellable<F, T>(fut: F, token: &crate::cancel::CancelToken) -> Result<T>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    use futures_util::FutureExt as _;

    let handle = handle().spawn(fut);
    // abort_handle 要在 select 之前取：handle 会被 select 消费掉
    let aborter = handle.abort_handle();
    futures_util::select! {
        joined = handle.fuse() => joined.context("后台任务异常终止"),
        () = Box::pin(token.cancelled()).fuse() => {
            aborter.abort();
            Err(anyhow::Error::new(crate::cancel::Cancelled))
        }
    }
}

/// 跨执行器可用的 sleep。
///
/// 直接 await tokio::time::sleep 需要当前线程处于 tokio 上下文；
/// 这里绕一层 spawn，于是在 gpui 的执行器上也能用。
pub async fn sleep(d: Duration) {
    // sleep 任务不会 panic，出错只可能是运行时被关掉（进程退出中），忽略即可
    let _ = spawn(async move { tokio::time::sleep(d).await }).await;
}

// ============================================================================
// 文件 IO
// ----------------------------------------------------------------------------
// 为什么这几个薄包装值得存在：tokio::fs 和 reqwest 一样要 reactor，
// 在 gpui 的执行器上直接调会 panic
// （"there is no reactor running, must be called from the context of a Tokio
// 1.x runtime"）。
//
// 这个坑是接 gpui 时才炸出来的：core 的单测跑在 #[tokio::test] 里，
// CLI 的 main 也是 #[tokio::main]，两边都自带 reactor，所以 90 个测试全绿、
// 命令行跑得好好的，一接上 gpui 就 abort。
//
// 教训是接缝必须无例外：只要一个地方绕过 runtime:: 直接用 tokio，
// 就会在最晚的时候（换执行器时）暴露。所以 memory.rs 和 cache.rs 的文件操作
// 全部改走这里，不再直接碰 tokio::fs。
// ============================================================================

/// 读文件。文件不存在时返回 Err，调用方自行判断 ErrorKind。
pub async fn read_file(path: impl Into<std::path::PathBuf>) -> std::io::Result<Vec<u8>> {
    let path = path.into();
    match spawn(async move { tokio::fs::read(path).await }).await {
        Ok(r) => r,
        // JoinError：任务 panic 了，属于 bug。转成 io::Error 让调用方的错误链不断。
        Err(e) => Err(std::io::Error::other(format!("{e:#}"))),
    }
}

/// 写文件。
pub async fn write_file(
    path: impl Into<std::path::PathBuf>,
    contents: Vec<u8>,
) -> std::io::Result<()> {
    let path = path.into();
    match spawn(async move { tokio::fs::write(path, contents).await }).await {
        Ok(r) => r,
        Err(e) => Err(std::io::Error::other(format!("{e:#}"))),
    }
}

/// 递归建目录。
pub async fn create_dir_all(path: impl Into<std::path::PathBuf>) -> std::io::Result<()> {
    let path = path.into();
    match spawn(async move { tokio::fs::create_dir_all(path).await }).await {
        Ok(r) => r,
        Err(e) => Err(std::io::Error::other(format!("{e:#}"))),
    }
}
