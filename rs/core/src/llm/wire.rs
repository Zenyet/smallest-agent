// ============================================================================
// llm/wire.rs —— 内部类型 ↔ OpenAI chat completions 线格式的翻译，纯逻辑
// ----------------------------------------------------------------------------
// 对应 TS 版 llm.ts 里的 toSdkMessages / sdkTools / mapToolCalls，
// 区别是 TS 那边翻译的目标是 Vercel AI SDK 的 ModelMessage，这边直接是 HTTP
// 请求体。少了一层中间商，反而更短更直白。
//
// 这个文件不含任何 HTTP、不含 async，全是纯函数 ——
// llm.ts 里那些容易出错的地方（消息形状、工具调用分片累积）都在这里，
// 所以刻意跟网络层分开，能脱网全覆盖单测。
// ============================================================================

use anyhow::{Result, anyhow, bail};
use serde_json::{Map, Value, json};

use crate::types::{Message, ModelResult, ToolCall, ToolRegistry};

/// 内部 Message[] → OpenAI messages 数组。
///
/// 每种 role 的「形状」不一样，这是消息协议里最容易出错的地方：
///   - tool 消息用 tool_call_id 关联请求，content 是纯字符串
///   - 带工具调用的 assistant 必须带 tool_calls 数组，且**每个 arguments 是
///     JSON 字符串而不是对象** —— 这是 OpenAI 线格式的坑，写成对象会被拒
///   - 纯文本 assistant 只要 content
///
/// 注意 Message::Tool 里的 name 字段**不往线上发**。OpenAI 的 tool 消息规范只有
/// role / content / tool_call_id 三个字段，多发一个 name 有些严格的兼容实现会拒。
/// 我们内部留着 name 是给 trace 和 UI 用的。
pub fn to_wire_messages(messages: &[Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| match m {
            Message::System { content } => json!({ "role": "system", "content": content }),
            Message::User { content } => json!({ "role": "user", "content": content }),
            Message::Tool {
                content,
                tool_call_id,
                ..
            } => json!({
                "role": "tool",
                "content": content,
                "tool_call_id": tool_call_id,
            }),
            Message::Assistant {
                content,
                tool_calls,
            } if !tool_calls.is_empty() => json!({
                "role": "assistant",
                "content": content,
                "tool_calls": tool_calls.iter().map(|tc| json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        // arguments 必须是字符串化的 JSON，不是对象
                        "arguments": Value::Object(tc.args.clone()).to_string(),
                    },
                })).collect::<Vec<_>>(),
            }),
            Message::Assistant { content, .. } => {
                json!({ "role": "assistant", "content": content })
            }
        })
        .collect()
}

/// ToolRegistry → OpenAI tools 数组。
///
/// TS 那边 parameters 是 zod schema，要过 AI SDK 的 tool() 包装才能转成
/// JSON Schema；这边 Tool::parameters() 直接就是 JSON Schema，原样塞进去。
pub fn to_wire_tools(registry: &ToolRegistry) -> Vec<Value> {
    registry
        .values()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name(),
                    "description": t.description(),
                    "parameters": t.parameters(),
                },
            })
        })
        .collect()
}

/// 组装 chat completions 请求体。
///
/// tools 为空时**不能**发 `"tools": []` —— 部分兼容实现（含 DeepSeek）
/// 对空数组的处理不一致，干脆整个字段省掉。
pub fn build_request(
    model: &str,
    temperature: f64,
    messages: &[Message],
    registry: &ToolRegistry,
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": model,
        "temperature": temperature,
        "messages": to_wire_messages(messages),
        "stream": stream,
    });
    let tools = to_wire_tools(registry);
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    body
}

/// 把线格式的一个 tool_call 对象映射回内部 ToolCall。
///
/// arguments 在线上是字符串，这里解析回对象。模型偶尔会吐出不合法的 JSON
/// （截断、多余逗号），这时报错而不是静默当空参数 ——
/// 静默的话工具会拿着空参数跑出个莫名其妙的结果，比直接失败更难查。
/// 报错会向上走到重试层，重试一次通常就好了。
pub fn parse_tool_call(v: &Value) -> Result<ToolCall> {
    let id = v["id"].as_str().unwrap_or_default().to_string();
    let name = v["function"]["name"]
        .as_str()
        .ok_or_else(|| anyhow!("tool_call 缺少 function.name: {v}"))?
        .to_string();
    let raw = v["function"]["arguments"].as_str().unwrap_or("");
    Ok(ToolCall {
        id,
        name,
        args: parse_args(raw)?,
    })
}

/// 解析 arguments 字符串。空字符串按「无参数」处理 ——
/// 模型调无参工具时经常给 "" 或 "{}"，两者都该当空对象。
pub fn parse_args(raw: &str) -> Result<Map<String, Value>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(other) => bail!("工具参数应是 JSON 对象，得到的是 {other}"),
        Err(e) => bail!("工具参数不是合法 JSON（{e}）：{trimmed}"),
    }
}

/// 解析非流式响应 → ModelResult。
///
/// content 在纯工具调用轮次会是 null（模型只输出工具调用、没有文字），
/// 用 unwrap_or_default 保证 text 永远是字符串，agent 循环无需空判断
/// （对应 TS 的 `result.text ?? ''`）。
pub fn parse_response(body: &Value) -> Result<ModelResult> {
    let choice = body["choices"]
        .get(0)
        .ok_or_else(|| anyhow!("响应里没有 choices：{body}"))?;
    let msg = &choice["message"];
    let tool_calls = msg["tool_calls"]
        .as_array()
        .map(|arr| arr.iter().map(parse_tool_call).collect::<Result<Vec<_>>>())
        .transpose()?
        .unwrap_or_default();
    Ok(ModelResult {
        text: msg["content"].as_str().unwrap_or_default().to_string(),
        tool_calls,
    })
}
