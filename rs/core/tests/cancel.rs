// ============================================================================
// tests/cancel.rs —— 取消机制
// ----------------------------------------------------------------------------
// 重点验的不是「能不能停」，而是**停的时候状态一致不一致**：
//   • 工具执行中取消，存盘的消息不能留下悬空 tool_calls（会让下次加载 400）
//   • 重试层不能重试取消（否则点停止还要等退避睡完）
//   • 降级层不能在取消时换备用模型
//   • 已经收到的部分文字要保住
// ============================================================================

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use smallest_agent_core::agent::{AgentDeps, OnComplete, run_agent};
use smallest_agent_core::cancel::{CancelToken, Cancelled, is_cancelled};
use smallest_agent_core::llm::ApiError;
use smallest_agent_core::resilience::{Retrying, Sleeper, WithFallback, is_retryable};
use smallest_agent_core::types::{
    AgentConfig, Args, CallModel, Message, ModelResult, Tool, ToolCall, ToolRegistry,
};

/// 调用时先等一下再返回，模拟真实的网络延迟，让测试有机会在「飞行中」取消。
struct SlowModel {
    result: ModelResult,
    token: CancelToken,
    calls: AtomicU32,
}

#[async_trait]
impl CallModel for SlowModel {
    async fn call(&self, _messages: &[Message]) -> Result<ModelResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        // 模拟 HTTP 层的行为：请求和取消赛跑，取消赢了就返回 Cancelled
        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(200)) => Ok(self.result.clone()),
            () = self.token.cancelled() => Err(anyhow::Error::new(Cancelled)),
        }
    }
}

/// 立刻返回、要调工具的假模型。
struct ToolCallingModel {
    calls: AtomicU32,
}

#[async_trait]
impl CallModel for ToolCallingModel {
    async fn call(&self, _messages: &[Message]) -> Result<ModelResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ModelResult {
            text: "我要调两个工具".into(),
            tool_calls: vec![
                ToolCall {
                    id: "c1".into(),
                    name: "slow".into(),
                    args: Default::default(),
                },
                ToolCall {
                    id: "c2".into(),
                    name: "slow".into(),
                    args: Default::default(),
                },
            ],
        })
    }
}

/// 跑起来就取消令牌的工具 —— 模拟「第一个工具跑着的时候用户点了停止」。
struct CancellingTool {
    token: CancelToken,
}

#[async_trait]
impl Tool for CancellingTool {
    fn name(&self) -> &str {
        "slow"
    }
    fn description(&self) -> &str {
        "跑的时候顺手取消"
    }
    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }
    async fn run(&self, _args: &Args) -> Result<Value> {
        self.token.cancel();
        Ok(json!("第一个工具跑完了"))
    }
}

/// 记录存盘内容。
#[derive(Default)]
struct RecordingStore {
    saved: Mutex<Vec<Vec<Message>>>,
}

#[async_trait]
impl OnComplete for RecordingStore {
    async fn on_complete(&self, messages: &[Message]) -> Result<()> {
        self.saved.lock().unwrap().push(messages.to_vec());
        Ok(())
    }
}

fn config() -> AgentConfig {
    AgentConfig {
        system_prompt: "测试".into(),
        max_turns: 10,
    }
}

fn registry(tools: Vec<Arc<dyn Tool>>) -> ToolRegistry {
    tools
        .into_iter()
        .map(|t| (t.name().to_string(), t))
        .collect()
}

// ===== 取消发生在模型调用中 =====

#[tokio::test]
async fn cancels_during_model_call() {
    let token = CancelToken::new();
    let model = Arc::new(SlowModel {
        result: ModelResult::default(),
        token: token.clone(),
        calls: AtomicU32::new(0),
    });
    let store = Arc::new(RecordingStore::default());

    let deps = AgentDeps::new(model.clone(), ToolRegistry::new(), config())
        .with_cancel(token.clone())
        .with_on_complete(store.clone());

    // 请求飞出去之后再取消
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        t.cancel();
    });

    let err = run_agent("问题", deps).await.unwrap_err();
    assert!(is_cancelled(&err), "应该是取消而不是别的错误：{err:#}");
    assert_eq!(model.calls.load(Ordering::SeqCst), 1, "不该重试");

    // 取消也要存盘：用户看到的东西不该在重开会话后消失
    let saved = store.saved.lock().unwrap();
    assert_eq!(saved.len(), 1, "取消时应该存了一次");
    // 此时 assistant 消息还没 push，存的是 system + user
    assert_eq!(saved[0].len(), 2);
}

// ===== 取消发生在工具执行中（最容易出错的那个） =====

#[tokio::test]
async fn cancelling_mid_tools_leaves_no_dangling_tool_calls() {
    let token = CancelToken::new();
    let model = Arc::new(ToolCallingModel {
        calls: AtomicU32::new(0),
    });
    let store = Arc::new(RecordingStore::default());

    let deps = AgentDeps::new(
        model,
        registry(vec![Arc::new(CancellingTool {
            token: token.clone(),
        })]),
        config(),
    )
    .with_cancel(token)
    .with_on_complete(store.clone());

    let err = run_agent("问题", deps).await.unwrap_err();
    assert!(is_cancelled(&err));

    let saved = store.saved.lock().unwrap();
    assert_eq!(saved.len(), 1);
    let messages = &saved[0];

    // 关键断言：每个 tool_call 都要有对应的 tool 结果。
    // 少一个的话，下次加载这个会话时 OpenAI 兼容 API 会 400。
    let requested: Vec<&str> = messages
        .iter()
        .filter_map(|m| match m {
            Message::Assistant { tool_calls, .. } => Some(tool_calls),
            _ => None,
        })
        .flatten()
        .map(|tc| tc.id.as_str())
        .collect();
    let answered: Vec<&str> = messages
        .iter()
        .filter_map(|m| match m {
            Message::Tool { tool_call_id, .. } => Some(tool_call_id.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(requested.len(), 2, "模型请求了两个工具调用");
    for id in &requested {
        assert!(
            answered.contains(id),
            "tool_call {id} 没有对应的结果，会让下次加载失败。已有：{answered:?}"
        );
    }

    // 第一个工具真跑了，第二个应该是「已取消」
    let cancelled_results = messages
        .iter()
        .filter(|m| matches!(m, Message::Tool { .. }) && m.content().contains("已取消"))
        .count();
    assert_eq!(cancelled_results, 1, "只有没跑的那个该标已取消");
}

// ===== 取消不该被重试 / 降级 =====

#[test]
fn cancellation_is_never_retryable() {
    assert!(!is_retryable(&anyhow::Error::new(Cancelled)));
    // 包了几层 context 也要认出来
    let wrapped = anyhow::Error::new(Cancelled).context("调模型失败");
    assert!(!is_retryable(&wrapped));
    // 对照：429 仍然该重试
    assert!(is_retryable(&anyhow::Error::new(ApiError {
        status: Some(429),
        transport: false,
        message: "rate limit".into(),
    })));
}

struct AlwaysCancelled;

#[async_trait]
impl CallModel for AlwaysCancelled {
    async fn call(&self, _messages: &[Message]) -> Result<ModelResult> {
        Err(anyhow::Error::new(Cancelled))
    }
}

struct CountingOk(AtomicU32);

#[async_trait]
impl CallModel for CountingOk {
    async fn call(&self, _messages: &[Message]) -> Result<ModelResult> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(ModelResult::default())
    }
}

#[derive(Default)]
struct CountingSleeper(AtomicU32);

#[async_trait]
impl Sleeper for CountingSleeper {
    async fn sleep(&self, _d: Duration) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn retry_layer_does_not_sleep_on_cancellation() {
    // 少了这条保护，点停止会走完 300ms + 600ms 的退避，
    // 表现成「点了停止界面又转了一秒」
    let sleeper = Arc::new(CountingSleeper::default());
    let retrying = Retrying::new(AlwaysCancelled)
        .with_retries(2)
        .with_sleeper(Box::new(sleeper.clone()));

    let err = retrying.call(&[]).await.unwrap_err();
    assert!(is_cancelled(&err));
    assert_eq!(sleeper.0.load(Ordering::SeqCst), 0, "取消不该退避等待");
}

#[tokio::test]
async fn fallback_layer_does_not_switch_model_on_cancellation() {
    // 用户是要停下来，不是要换个模型再试一遍
    let fallback = Arc::new(CountingOk(AtomicU32::new(0)));
    let model = WithFallback::new(AlwaysCancelled, fallback.clone());

    let err = model.call(&[]).await.unwrap_err();
    assert!(is_cancelled(&err));
    assert_eq!(
        fallback.0.load(Ordering::SeqCst),
        0,
        "取消时不该去调备用模型"
    );
}

// ===== 取消前就已取消 =====

#[tokio::test]
async fn already_cancelled_token_stops_before_first_call() {
    let token = CancelToken::new();
    token.cancel();
    let model = Arc::new(CountingOk(AtomicU32::new(0)));

    let deps = AgentDeps::new(model.clone(), ToolRegistry::new(), config()).with_cancel(token);
    let err = run_agent("问题", deps).await.unwrap_err();

    assert!(is_cancelled(&err));
    // compact 之后那次检查应该在第一次调模型之前就拦住
    assert_eq!(model.0.load(Ordering::SeqCst), 0, "一次模型都不该调");
}
