// ============================================================================
// resilience.rs —— 韧性包装：限流重试 + 备用模型降级
//                  （对应 TS 版 src/resilience.ts）
// ----------------------------------------------------------------------------
// 两个「CallModel 纯包装」：
//   • Retrying：遇到 429 / 5xx / 超时等可恢复错误，按指数退避自动重试
//   • WithFallback：主模型失败时无缝切到备用模型，调用方无感知
//
// 都是「持有内层 CallModel 的结构体」，可自由嵌套：
//   Cached::new(Retrying::new(WithFallback::new(a, b)), ...)
// agent 循环完全不感知这些层，对应 TS 的 withCache(withRetry(...)) 套娃。
//
// ## 与 TS 版的一处实质改进
//
// TS 的 defaultRetryable 靠正则匹配错误消息判断能不能重试：
//   /rate.?limit|timeout|ECONN|ETIMEDOUT|fetch failed/i
// 这在换 SDK、换 provider、甚至 Node 升版本改了错误文案后就静默失效 ——
// 不该重试的重试了顶多浪费点钱，该重试的没重试就是用户看到报错。
//
// 这边改成看 ApiError 的结构化字段（status / transport），llm.rs 在构造错误时
// 就把 HTTP 状态码记下来了，判断不依赖任何文案。
// ============================================================================

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;

use crate::llm::ApiError;
use crate::runtime;
use crate::types::{CallModel, Message, ModelResult};

/// 判断一个错误是否「值得重试」。
///
/// 429 限流、5xx 服务端错误、传输层错误（连不上 / 超时）值得重试；
/// 其余 4xx 是请求本身有问题，重了也一样，不重试。
/// 拿不到 ApiError（比如响应解析失败）默认不重试 —— 那类错误重试通常也是同样结果。
pub fn is_retryable(err: &anyhow::Error) -> bool {
    // 取消永不重试。
    //
    // 少了这一条，用户点停止会触发「重试 2 次」—— 每次都立刻被取消，
    // 但退避的 sleep 照睡（300ms + 600ms），而且 WithFallback 还会再拿备用模型
    // 试一遍。表现出来就是「点了停止，界面又转了一秒才停」。
    if crate::cancel::is_cancelled(err) {
        return false;
    }
    let Some(api) = err.downcast_ref::<ApiError>() else {
        return false;
    };
    if api.transport {
        return true;
    }
    matches!(api.status, Some(429) | Some(500..=599))
}

/// 可注入的等待器。测试传一个不真等的实现，重试用例就不用睡几百毫秒。
///
/// 对应 TS 版 RetryOptions.sleep 那个可选参数。
#[async_trait]
pub trait Sleeper: Send + Sync {
    async fn sleep(&self, d: Duration);
}

/// Arc 转发，理由同 types.rs 里 CallModel 的那两个：
/// 测试想在外面留一份引用断言「等了多久」，不必自己写一层包装。
#[async_trait]
impl<T: Sleeper + ?Sized> Sleeper for Arc<T> {
    async fn sleep(&self, d: Duration) {
        (**self).sleep(d).await
    }
}

/// 默认等待器：走 runtime.rs 的跨执行器 sleep。
///
/// 不能直接 await tokio::time::sleep —— 那要求当前线程处于 tokio 上下文，
/// 在 gpui 的执行器上会 panic。
pub struct RealSleeper;

#[async_trait]
impl Sleeper for RealSleeper {
    async fn sleep(&self, d: Duration) {
        runtime::sleep(d).await
    }
}

/// 给任意 CallModel 套上指数退避重试。
pub struct Retrying<C> {
    inner: C,
    /// 最大重试次数，默认 2（即最多调 3 次）
    retries: u32,
    /// 第一次重试等多久，默认 300ms
    base_delay: Duration,
    sleeper: Box<dyn Sleeper>,
    predicate: Box<dyn Fn(&anyhow::Error) -> bool + Send + Sync>,
}

impl<C> Retrying<C> {
    pub fn new(inner: C) -> Self {
        Self {
            inner,
            retries: 2,
            base_delay: Duration::from_millis(300),
            sleeper: Box::new(RealSleeper),
            predicate: Box::new(is_retryable),
        }
    }

    pub fn with_retries(mut self, retries: u32) -> Self {
        self.retries = retries;
        self
    }

    pub fn with_base_delay(mut self, d: Duration) -> Self {
        self.base_delay = d;
        self
    }

    pub fn with_sleeper(mut self, s: Box<dyn Sleeper>) -> Self {
        self.sleeper = s;
        self
    }

    pub fn with_predicate(
        mut self,
        p: impl Fn(&anyhow::Error) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.predicate = Box::new(p);
        self
    }
}

#[async_trait]
impl<C: CallModel> CallModel for Retrying<C> {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult> {
        // attempt 从 0 开始，每次等 base_delay * 2^attempt（300ms、600ms、1200ms…）
        // 这就是「指数退避」：错误越多等越久，避免持续轰炸限速中的 API。
        for attempt in 0..=self.retries {
            match self.inner.call(messages).await {
                Ok(r) => return Ok(r),
                Err(err) => {
                    // 已是最后一次机会，或这个错误根本不值得重试：直接上抛，
                    // 不再 sleep，避免不必要等待。
                    if attempt == self.retries || !(self.predicate)(&err) {
                        return Err(err);
                    }
                    // 2^attempt 用移位算，attempt 上限是 retries，不会溢出
                    let delay = self.base_delay * (1u32 << attempt);
                    self.sleeper.sleep(delay).await;
                }
            }
        }
        // 循环必然在里面 return（retries 至少让 attempt 取到 0 一次），
        // 这行只是让编译器满意。
        unreachable!("重试循环必然在内部返回")
    }
}

/// 降级回调，用于打日志或告警，让运维知道主模型在降级运行。
pub type OnFallback = Box<dyn Fn(&anyhow::Error) + Send + Sync>;

/// 给主模型套一层「保底」：任何错误都转向备用。
///
/// 不同于 Retrying（同一模型重试），这里是**换一个模型** ——
/// 典型场景是主力用贵的、备用用便宜的，在成本和可用性之间取平衡。
pub struct WithFallback<P, F> {
    primary: P,
    fallback: F,
    on_fallback: Option<OnFallback>,
}

impl<P, F> WithFallback<P, F> {
    pub fn new(primary: P, fallback: F) -> Self {
        Self {
            primary,
            fallback,
            on_fallback: None,
        }
    }

    pub fn with_on_fallback(mut self, f: impl Fn(&anyhow::Error) + Send + Sync + 'static) -> Self {
        self.on_fallback = Some(Box::new(f));
        self
    }
}

#[async_trait]
impl<P: CallModel, F: CallModel> CallModel for WithFallback<P, F> {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult> {
        match self.primary.call(messages).await {
            Ok(r) => Ok(r),
            // 取消不该触发降级：用户是要停下来，不是要换个模型再试一遍。
            Err(err) if crate::cancel::is_cancelled(&err) => Err(err),
            Err(err) => {
                if let Some(cb) = &self.on_fallback {
                    cb(&err);
                }
                // 备用的错误不再捕获，直接上抛 —— 两级都失败才算真正失败。
                self.fallback.call(messages).await
            }
        }
    }
}
