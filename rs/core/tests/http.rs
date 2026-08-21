// ============================================================================
// tests/http.rs —— HttpCallModel 的端到端测试，含运行时接缝
// ----------------------------------------------------------------------------
// 起一个最小的本地 HTTP 服务（裸 TcpListener，不引 web 框架）吐预设响应，
// 把 HttpCallModel 指过去。这里验的是 wire/stream 单测覆盖不到的那部分：
//   • 运行时接缝：在**非 tokio 执行器**上 await call() 能不能跑
//     （这正是接 gpui 时的处境，编译通过并不能证明它工作）
//   • 流式路径：SSE 端到端 + on_text 回调
//   • 非流式路径
//   • 非 2xx 的状态码有没有原样落到 ApiError.status 上（重试层要靠它）
// ============================================================================

use std::sync::{Arc, Mutex};

use smallest_agent_core::llm::{ApiError, HttpCallModel};
use smallest_agent_core::types::{CallModel, Config, Message};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

/// 起一个只应答一次的服务，返回它的 base_url。
/// raw 是完整的 HTTP 响应报文（含状态行和头）。
async fn serve_once(raw: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        // 先把请求读干净再应答，否则客户端可能收到 connection reset
        let mut buf = vec![0u8; 8192];
        let mut total = 0;
        loop {
            let n = sock.read(&mut buf[total..]).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            total += n;
            let text = String::from_utf8_lossy(&buf[..total]);
            // 头读完了，且 body 也够了（按 Content-Length 判断）
            if let Some(idx) = text.find("\r\n\r\n") {
                let len: usize = text
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length: ")
                            .or_else(|| l.strip_prefix("Content-Length: "))
                    })
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                if total >= idx + 4 + len {
                    break;
                }
            }
        }
        sock.write_all(raw.as_bytes()).await.unwrap();
        // 不发 Content-Length，靠关连接表示 body 结束（配 Connection: close）
        sock.shutdown().await.unwrap();
    });
    format!("http://{addr}")
}

fn config(base_url: &str) -> Config {
    Config {
        api_key: "sk-test".into(),
        base_url: base_url.to_string(),
        model: "deepseek-chat".into(),
        temperature: 0.0,
        native_search: Default::default(),
        max_turns: 10,
        system_prompt: "测试".into(),
        embedding_model: String::new(),
        notes_dir: String::new(),
        hf_endpoint: None,
        local_model_path: None,
        session_id: "t".into(),
        sessions_dir: String::new(),
        max_context_tokens: 2000,
        keep_recent: 6,
        fallback_model: "deepseek-chat".into(),
        max_retries: 2,
        cache_enabled: false,
        cache_dir: String::new(),
        stream: false,
    }
}

fn user(s: &str) -> Vec<Message> {
    vec![Message::User { content: s.into() }]
}

const JSON_OK: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: application/json\r\n",
    "Connection: close\r\n\r\n",
    r#"{"choices":[{"message":{"content":"你好"}}]}"#
);

// SSE：文本分三片，中间夹一个 keep-alive 注释行，最后 [DONE]
const SSE_OK: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: text/event-stream\r\n",
    "Connection: close\r\n\r\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
    ": keep-alive\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"好世\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"界\"}}]}\n\n",
    "data: [DONE]\n\n"
);

#[tokio::test]
async fn non_streaming_roundtrip() {
    let url = serve_once(JSON_OK).await;
    let model = HttpCallModel::new(&config(&url), Default::default()).unwrap();

    let r = model.call(&user("hi")).await.unwrap();
    assert_eq!(r.text, "你好");
    assert!(r.tool_calls.is_empty());
}

#[tokio::test]
async fn streaming_invokes_on_text_per_delta() {
    let url = serve_once(SSE_OK).await;
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();

    let model = HttpCallModel::new(&config(&url), Default::default())
        .unwrap()
        .with_on_text(Arc::new(move |d: &str| {
            sink.lock().unwrap().push(d.to_string())
        }));

    let r = model.call(&user("hi")).await.unwrap();
    // 回调按分片逐次触发
    assert_eq!(*seen.lock().unwrap(), vec!["你", "好世", "界"]);
    // 最终文本是拼起来的
    assert_eq!(r.text, "你好世界");
}

#[tokio::test]
async fn http_error_keeps_status_code() {
    // 429 必须原样落到 ApiError.status 上——重试层靠它判断，
    // 而不是像 TS 版那样正则匹配错误消息文本。
    let url = serve_once(concat!(
        "HTTP/1.1 429 Too Many Requests\r\n",
        "Content-Type: application/json\r\n",
        "Connection: close\r\n\r\n",
        r#"{"error":{"message":"rate limit"}}"#
    ))
    .await;
    let model = HttpCallModel::new(&config(&url), Default::default()).unwrap();

    let err = model.call(&user("hi")).await.unwrap_err();
    let api = err
        .downcast_ref::<ApiError>()
        .expect("应该能 downcast 回 ApiError");
    assert_eq!(api.status, Some(429));
    assert!(!api.transport);
    assert!(api.message.contains("rate limit"));
}

/// 连不上要标记成传输层错误（重试层据此重试，而不是当业务错误上抛）。
///
/// 这个用例同时是 loopback 绕过代理的回归测试。开发机上常设着
/// http_proxy=127.0.0.1:7890，如果 build_client 不放过 loopback，
/// 这个请求会被塞进代理、代理连不上端口 1 回一个 502 ——
/// 于是拿到的是 status=Some(502)、transport=false，断言就挂。
/// 换句话说：这条绿了才说明本地模型服务（ollama 之类）在代理开着时能连上。
#[tokio::test]
async fn transport_error_is_flagged() {
    // 指向一个没人监听的端口
    let model = HttpCallModel::new(&config("http://127.0.0.1:1"), Default::default()).unwrap();
    let err = model.call(&user("hi")).await.unwrap_err();
    let api = err.downcast_ref::<ApiError>().unwrap();
    assert!(api.transport, "连不上应标记为传输层错误");
    assert_eq!(api.status, None);
}

/// 运行时接缝的关键用例。
///
/// 在**非 tokio 执行器**上 await call()：futures_executor::block_on 跑在一个
/// 普通 std 线程上，完全没有 tokio 的 reactor。如果 HttpCallModel 没把 reqwest
/// 的活隔到自己的运行时里，这里会 panic（no reactor running）。
/// 这就是接 gpui（smol 系执行器）时的处境。
#[test]
fn calls_from_non_tokio_executor() {
    // 服务端仍需要一个 tokio 运行时来跑；它和被测对象的运行时是两个独立的。
    let server_rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let url = server_rt.block_on(serve_once(JSON_OK));
    // 让服务端运行时在后台线程继续驱动 accept
    let _guard = std::thread::spawn(move || {
        server_rt.block_on(async {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
    });

    let model = HttpCallModel::new(&config(&url), Default::default()).unwrap();
    // 注意：这里不是 #[tokio::test]，当前线程没有任何 tokio 上下文
    let r = futures_executor::block_on(model.call(&user("hi"))).unwrap();
    assert_eq!(r.text, "你好");
}
