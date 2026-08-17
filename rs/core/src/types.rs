// ============================================================================
// types.rs —— 全项目共享的「词汇表」（对应 TS 版 src/types.ts）
// ----------------------------------------------------------------------------
// 与 TS 版的三处有意偏离，其余逐字段对齐：
//
//   1. Message 从「struct + 一堆 Option 字段」改成 enum。
//      TS 里 toolCalls / toolCallId / name 都是可选字段，靠注释说明
//      「哪个 role 才有哪个字段」，编译器管不了；llm.ts 里因此出现了
//      `m.toolCallId!` 这种非空断言。Rust 的 enum 能把这条规则变成类型，
//      非法组合（比如带 toolCallId 的 user 消息）根本构造不出来。
//      序列化后的 JSON 形状和 TS 完全一致，见下面的 serde 标注，
//      所以 TS 版写出的 .sessions/*.json 能被这边直接读。
//
//   2. Tool.parameters 从 zod schema 变成裸 JSON Schema（serde_json::Value）。
//      TS 那边 zod schema 要经 AI SDK 的 tool() / jsonSchema() 包装才能给模型，
//      Rust 没有这层中间商，直接写 JSON Schema 反而更短。
//
//   3. CallModel 从函数类型别名变成 trait。
//      TS 的 `type CallModel = (messages) => Promise<ModelResult>` 靠高阶函数
//      套娃（withCache(withRetry(...))）。Rust 里闭包 + BoxFuture 能编但难读，
//      改成 trait + 「持有内层的结构体」来实现同一套装饰器链：
//      Cached<Retrying<Raw>> 和 TS 的嵌套一一对应。
//      注意 trait 里的原生 async fn 不支持 dyn，所以用 async_trait 宏，
//      这样才能有 Arc<dyn CallModel>。
// ============================================================================

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 工具调用的参数：JSON 对象。对应 TS 的 `Record<string, unknown>`。
/// 用 Map 而不是 Value，是为了在类型上排除「args 不是对象」这种非法状态。
pub type Args = Map<String, Value>;

/// 模型在 assistant 消息里「声明要调用某个工具」时附带的信息。
///
/// id 由模型生成，必须和后续 Message::Tool 的 tool_call_id 对上，
/// 模型才能把「调用请求」和「调用结果」关联起来。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub args: Args,
}

/// agent 循环里流转的「消息」单元，一条对应 LLM 消息协议里的一个 turn。
///
/// serde 标注决定了 JSON 形状，三个标注各管一件事：
///   - `tag = "role"`：把变体名写成 `"role"` 字段，而不是默认的外层嵌套
///   - `rename_all = "lowercase"`：变体名 System → `"system"`
///   - `rename_all_fields = "camelCase"`：字段名 tool_call_id → `"toolCallId"`
///
/// 结果就是和 TS 版逐字节一致的 JSON：
///   `{"role":"tool","content":"...","toolCallId":"call_1","name":"get_weather"}`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "role",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Message {
    /// 系统提示，每次调模型时作为首条消息注入。
    System { content: String },
    /// 用户输入。
    User { content: String },
    /// 模型输出。两种形态：纯文本（最终回答）或带工具调用。
    /// tool_calls 为空时不序列化，这样纯文本 assistant 的 JSON 里
    /// 不会多出一个 `"toolCalls":[]`，与 TS 的 `undefined` 行为一致。
    Assistant {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
    },
    /// 工具执行结果，喂回模型的那一条。ReAct 循环靠它把真实数据带进下一轮推理。
    Tool {
        content: String,
        tool_call_id: String,
        name: String,
    },
}

impl Message {
    /// role 的字符串形式。给 trace 打印和调试用，不参与序列化。
    pub fn role(&self) -> &'static str {
        match self {
            Message::System { .. } => "system",
            Message::User { .. } => "user",
            Message::Assistant { .. } => "assistant",
            Message::Tool { .. } => "tool",
        }
    }

    /// 消息正文。四个变体都有 content，所以这里总能取到。
    pub fn content(&self) -> &str {
        match self {
            Message::System { content }
            | Message::User { content }
            | Message::Assistant { content, .. }
            | Message::Tool { content, .. } => content,
        }
    }

    /// 便利构造：纯文本 assistant（tool_calls 为空）。
    pub fn assistant(content: impl Into<String>) -> Self {
        Message::Assistant {
            content: content.into(),
            tool_calls: Vec::new(),
        }
    }
}

/// call_model 每次调用的返回值：文本回答 + 这轮想调的工具列表（可能为空）。
///
/// agent 循环根据 tool_calls.is_empty() 判断「继续循环」还是「终止返回 text」。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelResult {
    pub text: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
}

/// 「怎么调模型」这件事的抽象。
///
/// agent 循环只依赖这个 trait，不认识具体实现，所以：
///   - 测试能注入返回固定 ModelResult 的假实现，不联网
///   - 缓存 / 重试 / 降级各层是「持有内层 CallModel 的结构体」，可任意套娃，
///     循环对这些层完全无感
#[async_trait]
pub trait CallModel: Send + Sync {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult>;
}

// Arc / Box 的转发实现。
//
// 没有这两个的话，装饰器套娃在遇到共享所有权时就断了：AgentDeps.call_model 是
// Arc<dyn CallModel>，而 Cached<C> 要求 C: CallModel ——
// Cached::new(arc_model, ..) 会编不过。测试里想复用同一个假模型也一样卡住。
//
// ?Sized 是为了同时覆盖 Arc<具体类型> 和 Arc<dyn CallModel>。
#[async_trait]
impl<T: CallModel + ?Sized> CallModel for Arc<T> {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult> {
        (**self).call(messages).await
    }
}

#[async_trait]
impl<T: CallModel + ?Sized> CallModel for Box<T> {
    async fn call(&self, messages: &[Message]) -> Result<ModelResult> {
        (**self).call(messages).await
    }
}

/// 单个工具：描述 + 参数 schema + 执行函数。
///
/// 本地工具和 MCP 工具都实现这个 trait，agent 循环对两者无法区分 ——
/// 这就是工具系统「可插拔」的落点。
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// 参数的 JSON Schema，直接给模型看。
    fn parameters(&self) -> Value;
    /// 执行。返回 Result 而不是像 TS 那样返回 unknown ——
    /// 错误在 run_tool 里被序列化成 JSON 交给模型，不会中断 agent 循环。
    async fn run(&self, args: &Args) -> Result<Value>;
}

/// 工具注册表：name → Tool。
///
/// 用 BTreeMap 而不是 HashMap：迭代顺序确定，工具列表每次以同样顺序发给模型，
/// 缓存 key 才稳定（HashMap 的随机顺序会让同样的输入算出不同的 key）。
pub type ToolRegistry = BTreeMap<String, Arc<dyn Tool>>;

/// 运行时配置，由 config.rs 从环境变量读取并填默认值。
///
/// 字段按 TS 版的阶段划分注释分组，逐字段对齐 src/types.ts 的 Config。
#[derive(Debug, Clone)]
pub struct Config {
    // Stage 0：模型调用
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    pub max_turns: u32,
    pub system_prompt: String,

    // Stage 3：RAG
    pub embedding_model: String,
    pub notes_dir: String,
    /// HuggingFace 下载源；国内连不上官方时设为镜像 https://hf-mirror.com
    pub hf_endpoint: Option<String>,
    /// 本地模型目录；设了就离线加载、不走网络
    pub local_model_path: Option<String>,

    // Stage 2：记忆
    /// 会话标识；不同 id 互不干扰
    pub session_id: String,
    pub sessions_dir: String,
    /// 历史超过这个估算 token 数就压缩
    pub max_context_tokens: u32,
    /// 压缩时保留的最近消息条数
    pub keep_recent: usize,

    // Stage 4：韧性
    /// 主模型连续失败时切到的备用模型
    pub fallback_model: String,
    /// 瞬时错误的额外重试次数
    pub max_retries: u32,

    // Stage 4b：缓存 + 流式
    pub cache_enabled: bool,
    pub cache_dir: String,
    pub stream: bool,
}

/// agent 循环真正用到的那两个配置项。
///
/// TS 那边写的是 `Pick<Config, 'systemPrompt' | 'maxTurns'>`，
/// Rust 没有 Pick，就单独定义一个小结构体，同样达到「循环不依赖整个 Config」
/// 的效果 —— 测试里构造它只要两个字段。
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub system_prompt: String,
    pub max_turns: u32,
}

impl From<&Config> for AgentConfig {
    fn from(c: &Config) -> Self {
        AgentConfig {
            system_prompt: c.system_prompt.clone(),
            max_turns: c.max_turns,
        }
    }
}
