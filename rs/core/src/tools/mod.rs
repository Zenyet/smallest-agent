// ============================================================================
// tools/mod.rs —— 工具执行的「统一入口」（对应 TS 版 src/tools/index.ts）
// ----------------------------------------------------------------------------
// agent 循环在 Act 阶段调用 run_tool，按名字在注册表里查找并执行。
// 本地工具和 MCP 工具对循环完全透明——只要实现了 Tool trait 进了注册表，
// run_tool 就用同一套逻辑驱动。
// ============================================================================

pub mod files;
pub mod shell;
pub mod web;

use serde_json::json;

use crate::types::{Args, ToolRegistry};

/// 按名字查找工具、执行、把结果序列化成 JSON 字符串返回给模型。
///
/// 注意返回类型是 String 而不是 Result<String>：**错误也序列化成 JSON 返回**，
/// 不向上传播。这是 TS 版的关键设计，照搬过来 ——
/// 工具失败不该中断 agent 循环，模型应该能看到错误消息并自行决定重试或换路子。
/// 循环的健壮性就来自这里。
pub async fn run_tool(registry: &ToolRegistry, name: &str, args: &Args) -> String {
    // 名字不在注册表里 = 模型幻想了一个不存在的工具（hallucination），
    // 以 JSON 错误告知，不 panic 也不返回 Err。
    let Some(tool) = registry.get(name) else {
        return json!({ "error": format!("unknown tool: {name}") }).to_string();
    };

    match tool.run(args).await {
        // 统一序列化：模型下一轮读到的 tool 消息 content 永远是 JSON 字符串。
        // 与 TS 的 JSON.stringify 行为一致——工具返回字符串时会带上引号。
        Ok(output) => serde_json::to_string(&output)
            // to_string 只在含 NaN / 非字符串 key 等不可序列化值时失败，
            // 同样包成 JSON 错误而不是上抛。
            .unwrap_or_else(|e| json!({ "error": e.to_string() }).to_string()),
        // 捕获工具执行时的错误，同样包成 JSON。
        // 用 {:#} 展开 anyhow 的错误链（含 context），比 {} 只给最外层信息量大。
        Err(err) => json!({ "error": format!("{err:#}") }).to_string(),
    }
}
