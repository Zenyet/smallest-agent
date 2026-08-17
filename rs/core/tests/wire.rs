// ============================================================================
// tests/wire.rs —— 内部类型 → OpenAI chat completions 线格式
// ----------------------------------------------------------------------------
// 对应 TS 版 llm.ts 里 toSdkMessages 那段「逐形状翻译」。
// 消息形状错一处，模型就报 400 或者读不到工具结果，所以逐种 role 钉住。
// ============================================================================

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use smallest_agent_core::llm::wire::{
    build_request, parse_args, parse_response, to_wire_messages, to_wire_tools,
};
use smallest_agent_core::types::{Args, Message, Tool, ToolCall, ToolRegistry};

struct Dummy(&'static str);

#[async_trait]
impl Tool for Dummy {
    fn name(&self) -> &str {
        self.0
    }
    fn description(&self) -> &str {
        "测试工具"
    }
    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": { "q": { "type": "string" } } })
    }
    async fn run(&self, _args: &Args) -> Result<Value> {
        Ok(json!(null))
    }
}

fn registry(names: &[&'static str]) -> ToolRegistry {
    names
        .iter()
        .map(|n| {
            let t: Arc<dyn Tool> = Arc::new(Dummy(n));
            (n.to_string(), t)
        })
        .collect()
}

// ===== 消息形状 =====

#[test]
fn system_and_user_are_plain() {
    let wire = to_wire_messages(&[
        Message::System {
            content: "系统提示".into(),
        },
        Message::User {
            content: "问题".into(),
        },
    ]);
    assert_eq!(wire[0], json!({ "role": "system", "content": "系统提示" }));
    assert_eq!(wire[1], json!({ "role": "user", "content": "问题" }));
}

#[test]
fn plain_assistant_has_no_tool_calls_key() {
    let wire = to_wire_messages(&[Message::assistant("答案")]);
    assert_eq!(wire[0], json!({ "role": "assistant", "content": "答案" }));
    // 纯文本 assistant 不能带 tool_calls 字段
    assert!(wire[0].get("tool_calls").is_none());
}

#[test]
fn assistant_tool_calls_serialize_arguments_as_string() {
    // 这是 OpenAI 线格式最容易踩的坑：arguments 是 JSON **字符串**，不是对象。
    // 写成对象会被 400。
    let wire = to_wire_messages(&[Message::Assistant {
        content: "我查一下".into(),
        tool_calls: vec![ToolCall {
            id: "call_0".into(),
            name: "get_weather".into(),
            args: json!({ "city": "北京" }).as_object().cloned().unwrap(),
        }],
    }]);

    let tc = &wire[0]["tool_calls"][0];
    assert_eq!(tc["id"], "call_0");
    assert_eq!(tc["type"], "function");
    assert_eq!(tc["function"]["name"], "get_weather");
    let args = tc["function"]["arguments"].as_str().expect("必须是字符串");
    // 内容等价即可，键序不做要求
    assert_eq!(
        serde_json::from_str::<Value>(args).unwrap(),
        json!({ "city": "北京" })
    );
}

#[test]
fn tool_message_omits_name_on_the_wire() {
    // 内部 Message::Tool 带 name（给 trace / UI 用），但 OpenAI 的 tool 消息
    // 规范只有 role / content / tool_call_id，多发 name 有些严格实现会拒。
    let wire = to_wire_messages(&[Message::Tool {
        content: r#"{"temp":21}"#.into(),
        tool_call_id: "call_0".into(),
        name: "get_weather".into(),
    }]);
    assert_eq!(
        wire[0],
        json!({
            "role": "tool",
            "content": r#"{"temp":21}"#,
            "tool_call_id": "call_0",
        })
    );
    assert!(wire[0].get("name").is_none());
}

// ===== 工具与请求体 =====

#[test]
fn tools_carry_raw_json_schema() {
    let wire = to_wire_tools(&registry(&["search"]));
    assert_eq!(wire.len(), 1);
    assert_eq!(wire[0]["type"], "function");
    assert_eq!(wire[0]["function"]["name"], "search");
    // parameters 就是 Tool::parameters() 原样，没有 zod → JSON Schema 那一层
    assert_eq!(wire[0]["function"]["parameters"]["type"], "object");
}

#[test]
fn tools_are_ordered_deterministically() {
    // BTreeMap → 按名字升序，缓存 key 才稳定
    let wire = to_wire_tools(&registry(&["zebra", "alpha", "middle"]));
    let names: Vec<&str> = wire
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["alpha", "middle", "zebra"]);
}

#[test]
fn omits_tools_key_when_registry_empty() {
    // 空注册表不能发 "tools": []，部分兼容实现对空数组处理不一致
    let body = build_request("m", 0.0, &[], &BTreeMap::new(), false);
    assert!(body.get("tools").is_none());
}

#[test]
fn request_carries_model_temperature_and_stream_flag() {
    let body = build_request(
        "deepseek-chat",
        0.7,
        &[Message::User {
            content: "hi".into(),
        }],
        &registry(&["search"]),
        true,
    );
    assert_eq!(body["model"], "deepseek-chat");
    assert_eq!(body["temperature"], 0.7);
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
}

// ===== 非流式响应解析 =====

#[test]
fn parses_text_response() {
    let body = json!({ "choices": [{ "message": { "content": "答案" } }] });
    let r = parse_response(&body).unwrap();
    assert_eq!(r.text, "答案");
    assert!(r.tool_calls.is_empty());
}

#[test]
fn null_content_becomes_empty_string() {
    // 纯工具调用轮次 content 是 null；对应 TS 的 `result.text ?? ''`
    let body = json!({
        "choices": [{ "message": {
            "content": null,
            "tool_calls": [
                { "id": "c1", "type": "function",
                  "function": { "name": "f", "arguments": "{\"a\":1}" } }
            ]
        }}]
    });
    let r = parse_response(&body).unwrap();
    assert_eq!(r.text, "");
    assert_eq!(r.tool_calls.len(), 1);
    assert_eq!(r.tool_calls[0].args["a"], 1);
}

#[test]
fn missing_choices_errors() {
    let err = parse_response(&json!({ "error": "quota" })).unwrap_err();
    assert!(err.to_string().contains("没有 choices"));
}

// ===== parse_args 边界 =====

#[test]
fn parse_args_accepts_empty_and_object() {
    assert!(parse_args("").unwrap().is_empty());
    assert!(parse_args("   ").unwrap().is_empty());
    assert!(parse_args("{}").unwrap().is_empty());
    assert_eq!(parse_args(r#"{"a":1}"#).unwrap()["a"], 1);
}

#[test]
fn parse_args_rejects_non_object_and_malformed() {
    assert!(
        parse_args("[1,2]")
            .unwrap_err()
            .to_string()
            .contains("应是 JSON 对象")
    );
    assert!(
        parse_args(r#"{"a":"#)
            .unwrap_err()
            .to_string()
            .contains("不是合法 JSON")
    );
}
