// ============================================================================
// tests/memory.rs —— 会话落盘 + 上下文压缩
// ----------------------------------------------------------------------------
// 压缩那部分用假摘要器，不联网。重点覆盖几个「错了会在真实使用中出事」的点：
//   • 路径穿越防护（sessionId 里带 ../）
//   • 保留窗口不能以孤立 tool 消息开头（会被 API 拒）
//   • 存回去不能带 system（否则重载后两条系统提示叠着）
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::Result;
use async_trait::async_trait;
use smallest_agent_core::agent::{Compact, OnComplete};
use smallest_agent_core::memory::{
    CompactHook, CompactOptions, JsonSessionStore, SaveSessionHook, SessionStore, Summarize,
    compact_messages, estimate_tokens,
};
use smallest_agent_core::types::{Message, ToolCall};

/// 返回固定摘要的假摘要器，同时记调用次数（验「没超预算不该调模型」）。
#[derive(Default)]
struct FakeSummarizer {
    calls: AtomicU32,
}

#[async_trait]
impl Summarize for FakeSummarizer {
    async fn summarize(&self, messages: &[Message]) -> Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(format!("摘了 {} 条", messages.len()))
    }
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "smallest-agent-mem-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn user(s: &str) -> Message {
    Message::User { content: s.into() }
}

fn assistant_with_call(id: &str) -> Message {
    Message::Assistant {
        content: String::new(),
        tool_calls: vec![ToolCall {
            id: id.into(),
            name: "f".into(),
            args: Default::default(),
        }],
    }
}

fn tool_result(id: &str) -> Message {
    Message::Tool {
        content: "{}".into(),
        tool_call_id: id.into(),
        name: "f".into(),
    }
}

// ===== 会话存储 =====

#[tokio::test]
async fn missing_session_loads_empty() {
    let store = JsonSessionStore::new(tmpdir("missing")).unwrap();
    // 新会话不该报错，返回空历史
    assert!(store.load("never-saved").await.unwrap().is_empty());
}

#[tokio::test]
async fn roundtrips_session() {
    let dir = tmpdir("roundtrip");
    let store = JsonSessionStore::new(&dir).unwrap();

    let messages = vec![
        user("北京天气"),
        assistant_with_call("c1"),
        tool_result("c1"),
        Message::assistant("21 度"),
    ];
    store.save("s1", &messages).await.unwrap();
    assert_eq!(store.load("s1").await.unwrap(), messages);

    // 写出来的是缩进过的 JSON，人肉可读、可 diff
    let raw = std::fs::read_to_string(dir.join("s1.json")).unwrap();
    assert!(raw.contains("\n  "), "应该是缩进格式");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn sessions_are_isolated() {
    let dir = tmpdir("isolated");
    let store = JsonSessionStore::new(&dir).unwrap();
    store.save("a", &[user("给 a 的")]).await.unwrap();
    store.save("b", &[user("给 b 的")]).await.unwrap();

    assert_eq!(store.load("a").await.unwrap()[0].content(), "给 a 的");
    assert_eq!(store.load("b").await.unwrap()[0].content(), "给 b 的");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn session_id_cannot_escape_directory() {
    // 没有 safe_id 的话这个 id 会写到 <dir>/../../pwned.json
    let dir = tmpdir("traversal");
    let store = JsonSessionStore::new(&dir).unwrap();
    store.save("../../pwned", &[user("x")]).await.unwrap();

    // 非法字符全变 '_'，文件老实待在会话目录里
    let entries: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["______pwned.json"]);
    assert!(!dir.parent().unwrap().join("pwned.json").exists());
    std::fs::remove_dir_all(&dir).ok();
}

// ===== token 估算 =====

#[test]
fn estimates_cjk_and_ascii_differently() {
    // CJK 约 1 token/字
    assert_eq!(estimate_tokens(&[user("你好世界")]), 4);
    // ASCII 约 4 字符/token，向上取整
    assert_eq!(estimate_tokens(&[user("abcd")]), 1);
    assert_eq!(estimate_tokens(&[user("abcde")]), 2);
    // 混排相加
    assert_eq!(estimate_tokens(&[user("你好abcd")]), 3);
    // 多条累加
    assert_eq!(estimate_tokens(&[user("你好"), user("世界")]), 4);
    assert_eq!(estimate_tokens(&[]), 0);
}

// ===== 上下文压缩 =====

fn opts(max_tokens: usize, keep_recent: usize, s: Arc<FakeSummarizer>) -> CompactOptions {
    CompactOptions {
        max_tokens,
        keep_recent,
        summarize: s,
    }
}

#[tokio::test]
async fn under_budget_does_not_call_model() {
    let s = Arc::new(FakeSummarizer::default());
    let messages = vec![user("短")];
    let out = compact_messages(messages.clone(), &opts(1000, 2, s.clone()))
        .await
        .unwrap();

    assert_eq!(out, messages);
    assert_eq!(s.calls.load(Ordering::SeqCst), 0, "没超预算不该调模型");
}

#[tokio::test]
async fn compacts_older_messages_keeping_system_and_recent() {
    let s = Arc::new(FakeSummarizer::default());
    let messages = vec![
        Message::System {
            content: "系统提示".into(),
        },
        user("第一个问题啊啊啊啊啊啊啊啊啊啊"),
        Message::assistant("第一个回答啊啊啊啊啊啊啊啊啊啊"),
        user("第二个问题啊啊啊啊啊啊啊啊啊啊"),
        Message::assistant("第二个回答啊啊啊啊啊啊啊啊啊啊"),
        user("最近的问题"),
        Message::assistant("最近的回答"),
    ];

    let out = compact_messages(messages, &opts(20, 2, s.clone()))
        .await
        .unwrap();

    assert_eq!(s.calls.load(Ordering::SeqCst), 1);
    // system + 摘要 + 最近 2 条
    assert_eq!(out.len(), 4);
    assert!(
        matches!(out[0], Message::System { .. }),
        "system 必须留在最前"
    );
    // 摘要是 user 而不是 system —— 这样它能过持久化的 system 过滤，
    // 重载时也不会和真正的 system prompt 重复
    assert_eq!(out[1].role(), "user");
    assert!(out[1].content().starts_with("【之前对话摘要】"));
    assert_eq!(out[2].content(), "最近的问题");
    assert_eq!(out[3].content(), "最近的回答");
}

#[tokio::test]
async fn recent_window_never_starts_with_orphan_tool() {
    // 保留窗口正好落在 tool 消息上时，必须把它丢掉 ——
    // 它对应的 assistant(tool_calls) 已经被摘进 older，
    // 孤立的 tool 消息会被 OpenAI 兼容 API 拒绝（400）。
    let s = Arc::new(FakeSummarizer::default());
    let messages = vec![
        Message::System {
            content: "系统提示".into(),
        },
        user("很长的问题啊啊啊啊啊啊啊啊啊啊啊啊"),
        assistant_with_call("c1"),
        tool_result("c1"),
        Message::assistant("答案啊啊啊啊啊啊啊啊啊啊啊啊"),
    ];

    // keep_recent=2 会让窗口从 tool_result 开始
    let out = compact_messages(messages, &opts(10, 2, s)).await.unwrap();

    // 摘要之后第一条不能是 tool
    let after_summary = &out[2..];
    assert!(
        !matches!(after_summary[0], Message::Tool { .. }),
        "保留窗口不该以 tool 开头，实际：{:?}",
        after_summary[0].role()
    );
}

#[tokio::test]
async fn nothing_to_compact_returns_unchanged() {
    // keep_recent 大于历史长度 → older 为空，无可压缩
    let s = Arc::new(FakeSummarizer::default());
    let messages = vec![
        Message::System {
            content: "系统提示".into(),
        },
        user("啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊"),
    ];
    let out = compact_messages(messages.clone(), &opts(1, 10, s.clone()))
        .await
        .unwrap();

    assert_eq!(out, messages);
    assert_eq!(s.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn works_without_system_message() {
    let s = Arc::new(FakeSummarizer::default());
    let messages = vec![
        user("第一个啊啊啊啊啊啊啊啊啊啊啊啊"),
        Message::assistant("第二个啊啊啊啊啊啊啊啊啊啊啊啊"),
        user("最近的"),
    ];
    let out = compact_messages(messages, &opts(10, 1, s)).await.unwrap();

    // 没有 system，第一条就是摘要
    assert_eq!(out[0].role(), "user");
    assert!(out[0].content().starts_with("【之前对话摘要】"));
    assert_eq!(out[1].content(), "最近的");
}

// ===== 接到循环上的钩子 =====

#[tokio::test]
async fn compact_hook_implements_agent_trait() {
    let s = Arc::new(FakeSummarizer::default());
    let hook = CompactHook::new(1000, 2, s);
    let messages = vec![user("短的")];
    // 走 agent::Compact 这个 trait 调进去
    assert_eq!(hook.compact(messages.clone()).await.unwrap(), messages);
}

#[tokio::test]
async fn save_hook_strips_system_messages() {
    // system prompt 每次 run_agent 都会重新注入，存进去会导致重载后叠两条
    let dir = tmpdir("savehook");
    let store: Arc<dyn SessionStore> = Arc::new(JsonSessionStore::new(&dir).unwrap());
    let hook = SaveSessionHook::new(store.clone(), "s1");

    hook.on_complete(&[
        Message::System {
            content: "系统提示".into(),
        },
        user("问题"),
        Message::assistant("回答"),
    ])
    .await
    .unwrap();

    let loaded = store.load("s1").await.unwrap();
    assert_eq!(loaded.len(), 2, "system 不该被存下来");
    assert!(loaded.iter().all(|m| m.role() != "system"));
    std::fs::remove_dir_all(&dir).ok();
}
