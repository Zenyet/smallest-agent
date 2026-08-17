// ============================================================================
// tests/stream.rs —— SSE 解码 + 流式分片累积
// ----------------------------------------------------------------------------
// 这是整个迁移最容易出错的一块（TS 那边由 AI SDK 免费提供），所以测得细一点。
// 全部脱网：直接喂字节数组，不起 HTTP。
// ============================================================================

use serde_json::json;
use smallest_agent_core::llm::stream::{SseDecoder, SseEvent, StreamAccumulator, parse_sse_line};

// ===== SseDecoder：字节流 → 完整行 =====

#[test]
fn splits_lines_across_chunks() {
    let mut d = SseDecoder::default();
    // 一行被切成三段送进来
    assert!(d.push(b"data: {\"a\"").is_empty());
    assert!(d.push(b":1}").is_empty());
    assert_eq!(d.push(b"\n"), vec![r#"data: {"a":1}"#]);
}

#[test]
fn handles_utf8_split_mid_character() {
    // 「北」是 3 字节 E5 8C 97。在字符中间切开，解码器必须缓冲到完整为止，
    // 否则 from_utf8 会拿到半个字符。这是中文场景下最阴的一个 bug。
    let text = "data: 北京\n";
    let bytes = text.as_bytes();
    let mut d = SseDecoder::default();

    // 在第一个汉字的第 2 个字节处切断
    let cut = "data: ".len() + 1;
    assert!(d.push(&bytes[..cut]).is_empty());
    let lines = d.push(&bytes[cut..]);
    assert_eq!(lines, vec!["data: 北京"]);
}

#[test]
fn strips_crlf() {
    let mut d = SseDecoder::default();
    assert_eq!(d.push(b"data: x\r\n"), vec!["data: x"]);
}

#[test]
fn yields_multiple_lines_from_one_chunk() {
    let mut d = SseDecoder::default();
    let lines = d.push(b"data: 1\n\ndata: 2\n");
    assert_eq!(lines, vec!["data: 1", "", "data: 2"]);
}

#[test]
fn flush_returns_trailing_line_without_newline() {
    let mut d = SseDecoder::default();
    assert!(d.push(b"data: [DONE]").is_empty());
    assert_eq!(d.flush().as_deref(), Some("data: [DONE]"));
    // 取过一次就空了
    assert_eq!(d.flush(), None);
}

// ===== parse_sse_line =====

#[test]
fn classifies_sse_lines() {
    assert_eq!(
        parse_sse_line("data: {\"x\":1}"),
        SseEvent::Data("{\"x\":1}".into())
    );
    assert_eq!(parse_sse_line("data: [DONE]"), SseEvent::Done);
    assert_eq!(parse_sse_line(""), SseEvent::Ignore);
    // keep-alive 心跳注释
    assert_eq!(parse_sse_line(": ping"), SseEvent::Ignore);
    // 其他 SSE 字段
    assert_eq!(parse_sse_line("event: message"), SseEvent::Ignore);
    // data: 后面没内容
    assert_eq!(parse_sse_line("data:"), SseEvent::Ignore);
}

// ===== StreamAccumulator：文本增量 =====

#[test]
fn accumulates_text_and_reports_deltas() {
    let mut acc = StreamAccumulator::default();
    let mut seen = Vec::new();
    for piece in ["你", "好", "世界"] {
        let chunk = json!({ "choices": [{ "delta": { "content": piece } }] });
        if let Some(d) = acc.push_chunk(&chunk) {
            seen.push(d);
        }
    }
    assert_eq!(seen, vec!["你", "好", "世界"]);
    let result = acc.finish().unwrap();
    assert_eq!(result.text, "你好世界");
    assert!(result.tool_calls.is_empty());
}

#[test]
fn ignores_null_and_empty_content() {
    let mut acc = StreamAccumulator::default();
    // 工具调用轮次 content 是 null
    assert_eq!(
        acc.push_chunk(&json!({ "choices": [{ "delta": { "content": null } }] })),
        None
    );
    // 空字符串也不该触发回调
    assert_eq!(
        acc.push_chunk(&json!({ "choices": [{ "delta": { "content": "" } }] })),
        None
    );
    // 完全没有 delta 字段
    assert_eq!(acc.push_chunk(&json!({ "choices": [{}] })), None);
    assert_eq!(acc.finish().unwrap().text, "");
}

// ===== StreamAccumulator：tool_calls 分片（核心） =====

#[test]
fn reassembles_tool_call_from_fragments() {
    let mut acc = StreamAccumulator::default();
    // 真实的分片形态：第一片带 id + name，后续只有 arguments 碎片
    let chunks = vec![
        json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}
        ]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"{\"ci"}}
        ]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"ty\":\"北京\"}"}}
        ]}}]}),
    ];
    for c in &chunks {
        // 工具调用分片不产生文本增量
        assert_eq!(acc.push_chunk(c), None);
    }

    let r = acc.finish().unwrap();
    assert_eq!(r.tool_calls.len(), 1);
    assert_eq!(r.tool_calls[0].id, "call_1");
    assert_eq!(r.tool_calls[0].name, "get_weather");
    // arguments 只在 finish 时才解析——中途的碎片是不合法 JSON
    assert_eq!(r.tool_calls[0].args["city"], "北京");
}

#[test]
fn handles_interleaved_parallel_tool_calls() {
    // 两个并行调用，分片交错到达。按 index 分组，不能假设连续。
    let mut acc = StreamAccumulator::default();
    let chunks = vec![
        json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"a","function":{"name":"f0","arguments":"{\"x\":"}}
        ]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[
            {"index":1,"id":"b","function":{"name":"f1","arguments":"{\"y\":"}}
        ]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"1}"}}
        ]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[
            {"index":1,"function":{"arguments":"2}"}}
        ]}}]}),
    ];
    for c in &chunks {
        acc.push_chunk(c);
    }

    let r = acc.finish().unwrap();
    assert_eq!(r.tool_calls.len(), 2);
    // BTreeMap 保证按 index 升序输出
    assert_eq!(r.tool_calls[0].name, "f0");
    assert_eq!(r.tool_calls[0].args["x"], 1);
    assert_eq!(r.tool_calls[1].name, "f1");
    assert_eq!(r.tool_calls[1].args["y"], 2);
}

#[test]
fn later_empty_fragments_do_not_clobber_id_and_name() {
    // 有些实现在后续分片里带 "id":"" / "name":""，不能把已拿到的值冲掉
    let mut acc = StreamAccumulator::default();
    acc.push_chunk(&json!({"choices":[{"delta":{"tool_calls":[
        {"index":0,"id":"keep","function":{"name":"keep_me","arguments":"{}"}}
    ]}}]}));
    acc.push_chunk(&json!({"choices":[{"delta":{"tool_calls":[
        {"index":0,"id":"","function":{"name":"","arguments":""}}
    ]}}]}));

    let r = acc.finish().unwrap();
    assert_eq!(r.tool_calls[0].id, "keep");
    assert_eq!(r.tool_calls[0].name, "keep_me");
}

#[test]
fn missing_index_defaults_to_zero() {
    // 单个工具调用时有些实现省略 index
    let mut acc = StreamAccumulator::default();
    acc.push_chunk(&json!({"choices":[{"delta":{"tool_calls":[
        {"id":"c","function":{"name":"f","arguments":"{\"a\":1}"}}
    ]}}]}));
    let r = acc.finish().unwrap();
    assert_eq!(r.tool_calls.len(), 1);
    assert_eq!(r.tool_calls[0].args["a"], 1);
}

#[test]
fn text_and_tool_calls_can_coexist() {
    // 模型先说一句再调工具（思考链 + 工具调用）
    let mut acc = StreamAccumulator::default();
    acc.push_chunk(&json!({"choices":[{"delta":{"content":"我查一下"}}]}));
    acc.push_chunk(&json!({"choices":[{"delta":{"tool_calls":[
        {"index":0,"id":"c","function":{"name":"f","arguments":"{}"}}
    ]}}]}));

    let r = acc.finish().unwrap();
    assert_eq!(r.text, "我查一下");
    assert_eq!(r.tool_calls.len(), 1);
}

#[test]
fn truncated_arguments_error_out() {
    // 流被截断，arguments 拼不成合法 JSON。报错而不是静默当空参数——
    // 静默的话工具会拿空参数跑出个莫名其妙的结果，比失败更难查。
    let mut acc = StreamAccumulator::default();
    acc.push_chunk(&json!({"choices":[{"delta":{"tool_calls":[
        {"index":0,"id":"c","function":{"name":"f","arguments":"{\"a\":"}}
    ]}}]}));

    let err = acc.finish().unwrap_err();
    assert!(err.to_string().contains("不是合法 JSON"));
}

#[test]
fn empty_arguments_means_no_args() {
    // 无参工具：模型给 "" 或 "{}"，两者都该是空对象
    for raw in ["", "{}"] {
        let mut acc = StreamAccumulator::default();
        acc.push_chunk(&json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"c","function":{"name":"f","arguments":raw}}
        ]}}]}));
        let r = acc.finish().unwrap();
        assert!(r.tool_calls[0].args.is_empty(), "raw={raw:?}");
    }
}
