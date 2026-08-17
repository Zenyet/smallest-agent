// ============================================================================
// tests/decorators.rs —— 缓存 / 重试 / 降级三个装饰器，含套娃
// ----------------------------------------------------------------------------
// 重点验两件事：
//   1. 每层单独的行为（命中不联网、指数退避、降级换模型）
//   2. 套起来还对，且 agent 循环对这些层完全无感
// 全部脱网，用计数的假 CallModel。
// ============================================================================

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use smallest_agent_core::cache::{Cached, ResultCache, cache_key};
use smallest_agent_core::llm::ApiError;
use smallest_agent_core::resilience::{Retrying, Sleeper, WithFallback, is_retryable};
use smallest_agent_core::types::{CallModel, Message, ModelResult};

/// 记录调用次数、按剧本返回成功或失败的假模型。
struct Counting {
    calls: AtomicU32,
    /// 每次调用的结果：Ok(text) 或 Err(错误构造器)
    outcomes: Mutex<std::vec::IntoIter<Result<String, ApiError>>>,
}

impl Counting {
    fn new(outcomes: Vec<Result<String, ApiError>>) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicU32::new(0),
            outcomes: Mutex::new(outcomes.into_iter()),
        })
    }
    fn always_ok(text: &str) -> Arc<Self> {
        // 剧本给足，用不完
        Self::new((0..32).map(|_| Ok(text.to_string())).collect())
    }
    fn count(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl CallModel for Counting {
    async fn call(&self, _messages: &[Message]) -> Result<ModelResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.outcomes.lock().unwrap().next() {
            Some(Ok(text)) => Ok(ModelResult {
                text,
                tool_calls: vec![],
            }),
            Some(Err(e)) => Err(e.into()),
            None => Err(anyhow!("剧本用完了")),
        }
    }
}

fn api_err(status: Option<u16>, transport: bool) -> ApiError {
    ApiError {
        status,
        transport,
        message: "test".into(),
    }
}

/// 内存缓存，测试用，不碰磁盘。
#[derive(Default)]
struct MemCache {
    map: Mutex<std::collections::HashMap<String, ModelResult>>,
    writes: AtomicU32,
}

#[async_trait]
impl ResultCache for MemCache {
    async fn get(&self, key: &str) -> Option<ModelResult> {
        self.map.lock().unwrap().get(key).cloned()
    }
    async fn set(&self, key: &str, value: &ModelResult) -> Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.map
            .lock()
            .unwrap()
            .insert(key.to_string(), value.clone());
        Ok(())
    }
}

/// 记录等了多久但不真等的等待器。
#[derive(Default)]
struct FakeSleeper {
    slept: Mutex<Vec<Duration>>,
}

#[async_trait]
impl Sleeper for FakeSleeper {
    async fn sleep(&self, d: Duration) {
        self.slept.lock().unwrap().push(d);
    }
}

fn msgs(s: &str) -> Vec<Message> {
    vec![Message::User { content: s.into() }]
}

// ===== 缓存 =====

#[tokio::test]
async fn cache_hit_skips_inner_call() {
    let inner = Counting::always_ok("答案");
    let cache = Arc::new(MemCache::default());
    let hits = Arc::new(AtomicU32::new(0));
    let h = hits.clone();

    // Arc<MemCache> 直接满足 ResultCache（types.rs 那组 blanket impl），
    // 所以外面能留一份引用查 writes，不用再包一层
    let cached = Cached::new(inner.clone(), Box::new(cache.clone()), "m1").with_on_hit(move || {
        h.fetch_add(1, Ordering::SeqCst);
    });

    // 第一次未命中：调下层 + 写缓存
    assert_eq!(cached.call(&msgs("q")).await.unwrap().text, "答案");
    assert_eq!(inner.count(), 1);
    assert_eq!(cache.writes.load(Ordering::SeqCst), 1);
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    // 第二次命中：不调下层，触发 on_hit
    assert_eq!(cached.call(&msgs("q")).await.unwrap().text, "答案");
    assert_eq!(inner.count(), 1, "命中时不该再调下层");
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // 换问题：又是未命中
    cached.call(&msgs("另一个问题")).await.unwrap();
    assert_eq!(inner.count(), 2);
}

#[test]
fn cache_key_is_stable_and_model_scoped() {
    let m = msgs("同一个问题");
    // 同输入同 key
    assert_eq!(cache_key("m1", &m), cache_key("m1", &m));
    // 换模型 key 就变——同样的 messages 不同模型输出可能不同，必须分开存
    assert_ne!(cache_key("m1", &m), cache_key("m2", &m));
    // 换消息 key 也变
    assert_ne!(cache_key("m1", &m), cache_key("m1", &msgs("别的问题")));
    // 32 位十六进制
    let k = cache_key("m1", &m);
    assert_eq!(k.len(), 32);
    assert!(k.chars().all(|c| c.is_ascii_hexdigit()));
}

// ===== 重试 =====

#[tokio::test]
async fn retries_on_429_with_exponential_backoff() {
    let inner = Counting::new(vec![
        Err(api_err(Some(429), false)),
        Err(api_err(Some(429), false)),
        Ok("终于成功".into()),
    ]);
    let sleeper = Arc::new(FakeSleeper::default());

    let retrying = Retrying::new(inner.clone())
        .with_retries(2)
        .with_base_delay(Duration::from_millis(300))
        .with_sleeper(Box::new(sleeper.clone()));

    let r = retrying.call(&msgs("q")).await.unwrap();
    assert_eq!(r.text, "终于成功");
    assert_eq!(inner.count(), 3, "两次失败 + 一次成功");
    // 指数退避：300ms、600ms
    assert_eq!(
        *sleeper.slept.lock().unwrap(),
        vec![Duration::from_millis(300), Duration::from_millis(600)]
    );
}

#[tokio::test]
async fn does_not_retry_client_errors() {
    // 400 是请求本身的问题，重试没意义
    let inner = Counting::new(vec![Err(api_err(Some(400), false))]);
    let retrying = Retrying::new(inner.clone()).with_sleeper(Box::new(FakeSleeper::default()));

    assert!(retrying.call(&msgs("q")).await.is_err());
    assert_eq!(inner.count(), 1, "4xx 不该重试");
}

#[tokio::test]
async fn gives_up_after_max_retries() {
    let inner = Counting::new(vec![
        Err(api_err(Some(503), false)),
        Err(api_err(Some(503), false)),
        Err(api_err(Some(503), false)),
    ]);
    let retrying = Retrying::new(inner.clone())
        .with_retries(2)
        .with_sleeper(Box::new(FakeSleeper::default()));

    let err = retrying.call(&msgs("q")).await.unwrap_err();
    assert_eq!(inner.count(), 3, "retries=2 意味着最多调 3 次");
    // 最后一次的错误原样上抛
    assert_eq!(err.downcast_ref::<ApiError>().unwrap().status, Some(503));
}

#[test]
fn retryable_classification() {
    // 靠结构化字段判断，不匹配错误文案——这是相对 TS 版的实质改进
    assert!(is_retryable(&api_err(Some(429), false).into()));
    assert!(is_retryable(&api_err(Some(500), false).into()));
    assert!(is_retryable(&api_err(Some(503), false).into()));
    assert!(
        is_retryable(&api_err(None, true).into()),
        "传输层错误该重试"
    );

    assert!(!is_retryable(&api_err(Some(400), false).into()));
    assert!(!is_retryable(&api_err(Some(401), false).into()));
    assert!(!is_retryable(&api_err(Some(404), false).into()));
    // 拿不到 ApiError 时默认不重试
    assert!(!is_retryable(&anyhow!("随便一个错误")));
}

// ===== 降级 =====

#[tokio::test]
async fn falls_back_to_secondary_model() {
    let primary = Counting::new(vec![Err(api_err(Some(500), false))]);
    let fallback = Counting::always_ok("备用答的");
    let notified = Arc::new(AtomicU32::new(0));
    let n = notified.clone();

    let model = WithFallback::new(primary.clone(), fallback.clone()).with_on_fallback(move |_| {
        n.fetch_add(1, Ordering::SeqCst);
    });

    let r = model.call(&msgs("q")).await.unwrap();
    assert_eq!(r.text, "备用答的");
    assert_eq!(primary.count(), 1);
    assert_eq!(fallback.count(), 1);
    assert_eq!(notified.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn both_failing_propagates_fallback_error() {
    let primary = Counting::new(vec![Err(api_err(Some(500), false))]);
    let fallback = Counting::new(vec![Err(api_err(Some(429), false))]);
    let model = WithFallback::new(primary, fallback);

    let err = model.call(&msgs("q")).await.unwrap_err();
    // 上抛的是备用的错误，不是主模型的
    assert_eq!(err.downcast_ref::<ApiError>().unwrap().status, Some(429));
}

// ===== 套娃 =====

#[tokio::test]
async fn layers_compose() {
    // Cached(Retrying(WithFallback(primary, fallback)))
    // 对应 TS 的 withCache(withRetry(withFallback(...)))
    let primary = Counting::new(vec![
        Err(api_err(Some(429), false)), // 重试第 1 次
        Err(api_err(Some(429), false)), // 重试第 2 次，用尽
        Err(api_err(Some(429), false)), // 第 3 次仍失败 → 交给降级
    ]);
    let fallback = Counting::always_ok("降级答的");
    let cache = Arc::new(MemCache::default());

    // 注意层序：重试包在降级**外面**，所以是「主模型重试到用尽才降级」。
    // 反过来包（降级在外）会变成「主模型一失败就降级，降级完的整体再重试」。
    let stack = Cached::new(
        Retrying::new(WithFallback::new(primary.clone(), fallback.clone()))
            .with_retries(2)
            .with_sleeper(Box::new(FakeSleeper::default())),
        Box::new(cache.clone()),
        "m1",
    );

    let r = stack.call(&msgs("q")).await.unwrap();
    assert_eq!(r.text, "降级答的");

    // 第二次同样的问题：缓存命中，一层都不走
    let before_primary = primary.count();
    let before_fallback = fallback.count();
    let r2 = stack.call(&msgs("q")).await.unwrap();
    assert_eq!(r2.text, "降级答的");
    assert_eq!(primary.count(), before_primary);
    assert_eq!(fallback.count(), before_fallback);
}
