// ============================================================================
// cancel.rs —— 取消令牌
// ----------------------------------------------------------------------------
// TS 版没有对应物：`runAgent` 一旦开跑就没法停，Electron 版因此不敢让用户删
// 正在处理的会话（`DELETE_BLOCKED`），也没有停止按钮 —— 那个限制的根因就在这里。
//
// ## 为什么不是一个 AtomicBool 就够
//
// 光有标志位只能在「两次 await 之间」检查，而 agent 大部分时间卡在一次
// HTTP 请求里（几秒到几十秒）。用户点停止后还要等模型把整个响应吐完，
// 体感上等于没取消。所以令牌还要能被 await —— 让 HTTP 那层把请求和
// 「取消发生了」放在一起 select，谁先到算谁。
//
// Notify 是纯 waker 机制，不需要 tokio 的 reactor 或 timer，所以在 gpui 的
// 执行器上也能 await。这点很重要：取消信号从 UI 线程发出，而等待它的代码
// 跑在专用运行时里，两边执行器不同。
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// 取消令牌。克隆出的副本共享同一个状态。
///
/// 一次性：取消之后不能重置。每轮对话新建一个 —— 复用会让「上一轮的取消」
/// 泄漏到下一轮，而这种 bug 只在用户快速点停止再发送时才出现，很难查。
#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// 请求取消。多次调用无害。
    pub fn cancel(&self) {
        // 先置标志再通知：反过来的话，等待方可能被唤醒后读到 false 又睡回去。
        self.inner.cancelled.store(true, Ordering::SeqCst);
        // notify_waiters 而不是 notify_one：可能有多处在等（HTTP 层 + 循环），
        // 每个都要收到。
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// 等到被取消。已经取消了就立刻返回。
    ///
    /// 先查标志再等通知，顺序不能反 —— 反了会漏掉「在开始等之前就已取消」
    /// 这种情况，然后永远等下去。
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.inner.notify.notified();
        // 注册监听之后再查一次：注册和上面那次检查之间可能有人调了 cancel。
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

/// 取消导致的错误。
///
/// 单独一个类型而不是复用 anyhow 的字符串，是为了让上层能区分
/// 「用户主动停的」和「真出错了」：
///   • UI 不该把它显示成红色报错
///   • resilience 的重试层不该重试它（见 is_retryable）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "已取消")
    }
}

impl std::error::Error for Cancelled {}

/// 判断一个错误链里有没有取消。
///
/// 用 downcast 遍历而不是比字符串 —— 错误经过几层 context 包装后，
/// 顶层的 Display 可能完全看不出是取消。
pub fn is_cancelled(err: &anyhow::Error) -> bool {
    err.chain().any(|e| e.is::<Cancelled>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_uncancelled() {
        assert!(!CancelToken::new().is_cancelled());
    }

    #[test]
    fn clones_share_state() {
        let a = CancelToken::new();
        let b = a.clone();
        a.cancel();
        assert!(b.is_cancelled(), "克隆应该共享状态");
    }

    #[tokio::test]
    async fn cancelled_returns_immediately_if_already_cancelled() {
        let t = CancelToken::new();
        t.cancel();
        // 已取消的令牌不该挂住 —— 这是「先查标志再等通知」那个顺序保证的
        t.cancelled().await;
    }

    #[tokio::test]
    async fn cancelled_wakes_on_cancel() {
        let t = CancelToken::new();
        let t2 = t.clone();
        let waiter = tokio::spawn(async move { t2.cancelled().await });
        // 给 waiter 一点时间进入等待
        tokio::task::yield_now().await;
        t.cancel();
        waiter.await.expect("等待方应该被唤醒");
    }

    #[test]
    fn detects_cancellation_through_context_layers() {
        let err = anyhow::Error::new(Cancelled)
            .context("调模型失败")
            .context("这一轮没跑完");
        // 顶层 Display 完全看不出是取消，所以必须遍历错误链
        assert!(!err.to_string().contains("已取消"));
        assert!(is_cancelled(&err));
    }

    #[test]
    fn plain_errors_are_not_cancellation() {
        assert!(!is_cancelled(&anyhow::anyhow!("网络挂了")));
    }
}
