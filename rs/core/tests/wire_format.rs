// ============================================================================
// tests/wire_format.rs —— 消息的 JSON 形状必须和 TS 版逐字节一致
// ----------------------------------------------------------------------------
// 为什么单独测这个：Message 在 Rust 侧被改成了 enum（TS 是 struct + 可选字段），
// 形状靠 serde 标注还原。标注错一个字（比如漏了 rename_all_fields）就会写出
// snake_case 的 toolCallId，TS 版写的会话文件读不进来、Rust 写的 TS 也读不了。
// 这里钉住那份契约。
// ============================================================================

use serde_json::json;
use smallest_agent_core::types::{Message, ToolCall};

/// TS 版 memory/store.ts 写出的会话文件就是一个 Message 数组。
/// 这里覆盖四种 role 的全部形状，含带工具调用的 assistant 和 tool 结果。
fn ts_written_json() -> serde_json::Value {
    json!([
        { "role": "system", "content": "你是一个简洁、诚实的中文助手。" },
        { "role": "user", "content": "北京天气怎么样" },
        {
            "role": "assistant",
            "content": "我查一下",
            "toolCalls": [
                { "id": "call_0", "name": "get_weather", "args": { "city": "北京" } }
            ]
        },
        {
            "role": "tool",
            "content": "{\"temp\":21}",
            "toolCallId": "call_0",
            "name": "get_weather"
        },
        { "role": "assistant", "content": "21 度。" }
    ])
}

#[test]
fn reads_session_json_written_by_ts() {
    let messages: Vec<Message> = serde_json::from_value(ts_written_json()).unwrap();
    assert_eq!(messages.len(), 5);

    match &messages[2] {
        Message::Assistant {
            content,
            tool_calls,
        } => {
            assert_eq!(content, "我查一下");
            assert_eq!(tool_calls.len(), 1);
            assert_eq!(tool_calls[0].id, "call_0");
            // args 是 JSON 对象，透传不做类型约束
            assert_eq!(tool_calls[0].args["city"], "北京");
        }
        other => panic!("应是 assistant，实际 {}", other.role()),
    }

    match &messages[3] {
        Message::Tool {
            tool_call_id, name, ..
        } => {
            // camelCase 的 toolCallId 必须能落到 tool_call_id 上
            assert_eq!(tool_call_id, "call_0");
            assert_eq!(name, "get_weather");
        }
        other => panic!("应是 tool，实际 {}", other.role()),
    }

    // 纯文本 assistant 反序列化后 tool_calls 为空（TS 那边是 undefined）
    match &messages[4] {
        Message::Assistant { tool_calls, .. } => assert!(tool_calls.is_empty()),
        other => panic!("应是 assistant，实际 {}", other.role()),
    }
}

#[test]
fn writes_json_ts_can_read() {
    let messages: Vec<Message> = serde_json::from_value(ts_written_json()).unwrap();
    // 往回写一遍，应与 TS 的原始 JSON 完全相等（字段名、嵌套、缺省全对上）
    let round_tripped = serde_json::to_value(&messages).unwrap();
    assert_eq!(round_tripped, ts_written_json());
}

#[test]
fn plain_assistant_omits_empty_tool_calls() {
    // 空 tool_calls 不能序列化出 "toolCalls":[]，否则和 TS 的 undefined 不等价
    let m = Message::assistant("就这样");
    assert_eq!(
        serde_json::to_string(&m).unwrap(),
        r#"{"role":"assistant","content":"就这样"}"#
    );
}

#[test]
fn tool_call_args_default_to_empty_object() {
    // 模型有时给出不带 args 的工具调用；缺省应是空对象而不是反序列化失败
    let tc: ToolCall = serde_json::from_value(json!({ "id": "c", "name": "noop" })).unwrap();
    assert!(tc.args.is_empty());
}
