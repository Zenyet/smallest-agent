// ============================================================================
// smallest-agent-core —— agent 核心逻辑，不含任何 UI 依赖
// ----------------------------------------------------------------------------
// 迁移自 TS 版 src/，模块名与文件一一对应，方便两版对照阅读：
//
//   types.rs      ← src/types.ts      消息协议 / 工具 / 配置的「词汇表」
//   config.rs     ← src/config.ts     环境变量 → Config
//   tools/mod.rs  ← src/tools/index.ts 工具执行统一入口
//   agent.rs      ← src/agent.ts      ReAct 循环
//   llm/          ← src/llm.ts        HTTP + 线格式 + SSE
//   cache.rs      ← src/cache.ts      磁盘缓存装饰器
//   resilience.rs ← src/resilience.ts 重试 + 降级装饰器
//   mcp.rs        ← src/mcp/client.ts MCP 客户端，动态发现工具
//   mcp_config.rs ← （无对应）        MCP server 列表配置。TS 版写死在代码里
//   memory.rs     ← src/memory/*      会话落盘 + 上下文压缩
//   runtime.rs    ← （无对应）        跨执行器的运行时接缝，Rust 特有
//   cancel.rs     ← （无对应）        取消令牌。TS 版没有，所以那边不敢让用户停
//   provider/     ← （无对应）        「一轮由谁来跑」：内置 agent 或外部 CLI
//   approval.rs   ← （无对应）        危险操作前确认。唯一一处请求-响应通路
//
// 尚未迁移：rag（fastembed-rs，会换 embedding 模型，索引要重建）。
// eval 不迁——测试脚手架留在 TS 侧，照样能对着 Rust 二进制跑。
// ============================================================================

pub mod agent;
pub mod approval;
pub mod cache;
pub mod cancel;
pub mod config;
pub mod llm;
pub mod mcp;
pub mod mcp_config;
pub mod memory;
pub mod provider;
pub mod resilience;
pub mod runtime;
pub mod tools;
pub mod types;

// 常用类型提到 crate 根，调用方不用写三层路径。
pub use agent::{AgentDeps, TurnInfo, run_agent};
pub use approval::{ApprovalOutcome, ApprovalRequest, Approver};
pub use cache::{Cached, DiskCache, ResultCache, cache_key};
pub use cancel::{CancelToken, Cancelled};
pub use config::{SYSTEM_PROMPT, load_config};
pub use llm::{ApiError, HttpCallModel};
pub use mcp::{McpServerSpec, load_mcp_tools_from_servers};
pub use memory::{JsonSessionStore, SessionMeta, SessionStore, estimate_tokens, new_session_id};
pub use provider::{BuiltinProvider, Provider, TurnEvent, TurnRequest};
pub use resilience::{Retrying, WithFallback, is_retryable};
pub use types::{AgentConfig, Args, CallModel, Config, Message, ModelResult, Tool, ToolCall};
