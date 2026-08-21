// ============================================================================
// llm/mod.rs —— 唯一直接接触 HTTP 的文件（「边界层」）
//               对应 TS 版 src/llm.ts
// ----------------------------------------------------------------------------
// 职责：把内部的 Message[] / ToolRegistry / Config 翻译成 chat completions
// 请求，把结果映射回 ModelResult。纯逻辑都挪去了 wire.rs 和 stream.rs，
// 这里只剩「发请求、收字节」。
//
// reqwest 要 tokio 的 reactor 才能跑，而 gpui 用自己的执行器 ——
// 这个接缝统一由 runtime.rs 处理，这里只是它的使用方之一。
// call() 里那句 runtime::spawn 就是边界，细节见 runtime.rs 的文件头注释。
// ============================================================================

pub mod stream;
pub mod wire;

use std::fmt;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use futures_util::StreamExt as _;
use serde_json::Value;

use crate::cancel::CancelToken;
use crate::llm::stream::{SseDecoder, SseEvent, StreamAccumulator, parse_sse_line};
use crate::llm::wire::{build_request, parse_response};
use crate::runtime;
use crate::types::{CallModel, Config, Message, ModelResult, ToolRegistry};

/// 流式文本回调。
///
/// **注意它在 tokio 的工作线程上被调用**，不是主线程。接 gpui 时不能在这里
/// 直接改 UI 状态，要往 channel 里发、由主线程取。
pub type OnText = Arc<dyn Fn(&str) + Send + Sync>;

/// 调模型失败的结构化错误。
///
/// TS 版的 resilience.ts 靠正则匹配错误消息判断能不能重试
/// （`/rate.?limit|timeout|ECONN/i`），字符串一变就失效。这边把 HTTP 状态码和
/// 「是不是传输层错误」显式记下来，重试层直接看字段。
#[derive(Debug)]
pub struct ApiError {
    /// HTTP 状态码。传输层错误（连不上、超时）没有状态码。
    pub status: Option<u16>,
    /// 传输层错误（连接失败、超时、TLS 出错），区别于服务端返回的业务错误。
    pub transport: bool,
    pub message: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(s) => write!(f, "模型请求失败（HTTP {s}）：{}", self.message),
            None => write!(f, "模型请求失败：{}", self.message),
        }
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    fn from_reqwest(e: reqwest::Error) -> Self {
        ApiError {
            status: e.status().map(|s| s.as_u16()),
            transport: e.is_timeout() || e.is_connect() || e.is_request(),
            message: e.to_string(),
        }
    }
}

/// 建 HTTP client：沿用系统代理，但**放过 loopback**。
///
/// reqwest 默认读 http_proxy / https_proxy 环境变量，这对需要代理才能连上
/// 模型 API 的场景是对的，得保留。但它连 127.0.0.1 也往代理里塞 ——
/// 本地跑的 OpenAI 兼容服务（ollama、vLLM 之类）在代理开着时就连不上了，
/// 报出来还是个 502，看着像服务端问题，很难查。
///
/// 所以这里自己接管：目标是 loopback 就不走代理，其余交给环境变量。
fn build_client() -> Result<reqwest::Client> {
    let env_proxy = std::env::var("https_proxy")
        .or_else(|_| std::env::var("HTTPS_PROXY"))
        .or_else(|_| std::env::var("http_proxy"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
        .ok()
        .filter(|s| !s.trim().is_empty());

    let mut builder = reqwest::Client::builder();
    match env_proxy {
        Some(proxy_url) => {
            let proxy = reqwest::Proxy::custom(move |url| {
                let is_loopback = match url.host() {
                    Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                    Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                    Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
                    None => false,
                };
                if is_loopback {
                    None
                } else {
                    proxy_url.parse::<reqwest::Url>().ok()
                }
            });
            builder = builder.proxy(proxy);
        }
        // 没设代理环境变量：显式关掉代理探测，省得 reqwest 再去读系统设置
        None => builder = builder.no_proxy(),
    }
    builder.build().context("建 HTTP client 失败")
}

/// 走 HTTP 的 CallModel 实现。
///
/// 对应 TS 的 makeCallModel(config, registry, onText?)：
/// on_text 给了就走流式（SSE），没给就走非流式，对外是同一个 CallModel。
pub struct HttpCallModel {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
    temperature: f64,
    /// 这家厂商自带的联网搜索怎么开。跟着 Config 走，见 types.rs。
    native_search: crate::vendors::SearchSupport,
    registry: ToolRegistry,
    on_text: Option<OnText>,
    /// 取消令牌。默认是个永不取消的空令牌，所以不关心取消的调用方
    /// （CLI、测试）什么都不用做。
    cancel: CancelToken,
}

impl HttpCallModel {
    pub fn new(config: &Config, registry: ToolRegistry) -> Result<Self> {
        Ok(Self {
            client: build_client()?,
            base_url: config.base_url.trim_end_matches('/').to_string(),
            api_key: config.api_key.clone(),
            model: config.model.clone(),
            temperature: config.temperature,
            native_search: config.native_search.clone(),
            registry,
            on_text: None,
            cancel: CancelToken::new(),
        })
    }

    /// 设了就走流式。对应 TS 里传 onText 的分支。
    pub fn with_on_text(mut self, on_text: OnText) -> Self {
        self.on_text = Some(on_text);
        self
    }

    /// 绑定取消令牌，返回一个**共享同一个 client** 的副本。
    ///
    /// 取 &self 而不是 self（不同于其它 builder）：取消令牌是每轮换一个的，
    /// 而调用方要留着基座复用连接池。消费所有权的话每轮都得重建 client，
    /// 等于每次对话重新 TLS 握手。
    pub fn with_cancel(&self, cancel: CancelToken) -> Self {
        Self {
            client: self.client.clone(),
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            temperature: self.temperature,
            native_search: self.native_search.clone(),
            registry: self.registry.clone(),
            on_text: self.on_text.clone(),
            cancel,
        }
    }

    /// 换模型但复用同一个 client。降级到备用模型时用。
    pub fn with_model(&self, model: &str) -> Self {
        Self {
            client: self.client.clone(),
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            model: model.to_string(),
            temperature: self.temperature,
            native_search: self.native_search.clone(),
            registry: self.registry.clone(),
            on_text: self.on_text.clone(),
            cancel: self.cancel.clone(),
        }
    }
}

#[async_trait]
impl CallModel for HttpCallModel {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult> {
        let streaming = self.on_text.is_some();
        // 请求体在这里就构造好：spawn 进去的 future 必须是 'static，
        // 不能借用 &[Message]。
        let body = build_request(
            &self.model,
            self.temperature,
            messages,
            &self.registry,
            streaming,
            &self.native_search,
        );

        let client = self.client.clone();
        let url = format!("{}/chat/completions", self.base_url);
        let api_key = self.api_key.clone();
        let on_text = self.on_text.clone();
        let cancel = self.cancel.clone();

        // 开跑前先看一眼：上一轮的取消可能刚发生，没必要再发一次请求
        if cancel.is_cancelled() {
            return Err(anyhow::Error::new(crate::cancel::Cancelled));
        }

        // ===== 运行时边界 =====
        // 里面是 tokio 的世界（reqwest 能跑），外面在任何执行器上都能 await。
        // 见 runtime.rs。
        //
        // ## 两条路径的取消方式不同，这是有意的
        //
        // 流式：用 spawn（**不** abort），靠 read_sse 内部每个 chunk 查令牌然后
        // break → finish()，把已经收到的半截答案作为 Ok 返回。
        // 用户屏幕上已经显示的文字因此能存进会话，切走再回来还在。
        //
        // 非流式：用 spawn_cancellable，取消时 abort。那条路径上没有「部分结果」
        // 这回事（响应体没收完就什么都没有），abort 能让连接立刻断开。
        //
        // 最初两条都走 spawn_cancellable，结果是个竞态：read_sse 的 break 和
        // 外层的 abort 谁先到不确定，「保住部分文字」时好时坏 —— 实测取消后
        // 会话文件里只有 user 消息，半截答案丢了。
        let task = async move {
            let resp = client
                .post(&url)
                .bearer_auth(&api_key)
                .json(&body)
                .send()
                .await
                .map_err(ApiError::from_reqwest)?;

            // 非 2xx：把响应体带进错误消息。状态码单独记在 ApiError.status 上，
            // 重试层靠它判断 429 / 5xx，不用去匹配字符串。
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let message = resp
                    .text()
                    .await
                    .unwrap_or_else(|e| format!("<读响应体失败：{e}>"));
                return Err(ApiError {
                    status: Some(status),
                    transport: false,
                    message,
                });
            }

            match on_text {
                Some(on_text) => read_sse(resp, &on_text, &cancel).await,
                None => {
                    let json: Value = resp.json().await.map_err(ApiError::from_reqwest)?;
                    parse_response(&json).map_err(|e| ApiError {
                        status: None,
                        transport: false,
                        message: format!("{e:#}"),
                    })
                }
            }
        };

        if streaming {
            // 内层 ? 把 ApiError 转成 anyhow::Error，重试层之后用
            // downcast_ref::<ApiError>() 取回状态码。
            Ok(runtime::spawn(task).await??)
        } else {
            Ok(runtime::spawn_cancellable(task, &self.cancel).await??)
        }
    }
}

/// 读 SSE 流，边收边触发 on_text，收完拼成 ModelResult。
///
/// 两层解析：SseDecoder 负责「字节流 → 完整行」（处理跨 chunk 的汉字和断行），
/// StreamAccumulator 负责「行里的 JSON → 累积状态」（处理 tool_calls 分片）。
/// 分两层是因为这两件事的失败模式完全不同，混在一起没法单测。
async fn read_sse(
    resp: reqwest::Response,
    on_text: &OnText,
    cancel: &CancelToken,
) -> std::result::Result<ModelResult, ApiError> {
    let mut decoder = SseDecoder::default();
    let mut acc = StreamAccumulator::default();
    let mut stream = resp.bytes_stream();

    let wrap = |e: anyhow::Error| ApiError {
        status: None,
        transport: false,
        message: format!("{e:#}"),
    };

    'outer: while let Some(chunk) = stream.next().await {
        // 每个 chunk 查一次取消。
        //
        // 外层的 spawn_cancellable 已经会 abort 整个任务，这里再查一次是为了
        // **保住已经收到的部分文字**：abort 是硬砍，acc 里的内容会丢；
        // 主动 break 能走到下面的 finish()，把这半截答案交出去。
        // 用户点停止时屏幕上已经显示的东西不该凭空消失。
        if cancel.is_cancelled() {
            break 'outer;
        }
        let chunk = chunk.map_err(ApiError::from_reqwest)?;
        for line in decoder.push(&chunk) {
            match parse_sse_line(&line) {
                SseEvent::Data(payload) => {
                    // 单个 chunk 解析失败不该炸掉整个流：有些实现会插入
                    // 非标准的 keep-alive 载荷。跳过继续读。
                    if let Ok(json) = serde_json::from_str::<Value>(&payload)
                        && let Some(delta) = acc.push_chunk(&json)
                    {
                        on_text(&delta);
                    }
                }
                SseEvent::Done => break 'outer,
                SseEvent::Ignore => {}
            }
        }
    }

    // 服务端没发末尾换行时，最后一行还在缓冲区里
    if let Some(line) = decoder.flush()
        && let SseEvent::Data(payload) = parse_sse_line(&line)
        && let Ok(json) = serde_json::from_str::<Value>(&payload)
        && let Some(delta) = acc.push_chunk(&json)
    {
        on_text(&delta);
    }

    acc.finish().map_err(wrap)
}
