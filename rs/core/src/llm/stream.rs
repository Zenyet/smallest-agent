// ============================================================================
// llm/stream.rs —— SSE 解码 + 流式分片累积，纯逻辑
// ----------------------------------------------------------------------------
// TS 版这块是免费的：Vercel AI SDK 的 streamText 内部处理了 SSE 解析和
// tool_calls 分片重组，llm.ts 只要 `for await (const delta of result.textStream)`。
// Rust 没有这层，得自己来。这是整个迁移唯一真正棘手的地方，原因有两个：
//
//   1. 字节流的切分位置是任意的。一个 UTF-8 汉字占 3 字节，可能被拆在两个
//      chunk 里；一行 SSE 也可能跨 chunk。所以缓冲区必须是 Vec<u8>，
//      只在遇到 \n（ASCII，不可能出现在多字节序列内部）时才切出完整行转 String。
//      直接对每个 chunk 调 from_utf8 会在中文上炸。
//
//   2. tool_calls 是按 index 分片流下来的：
//        {"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}
//        {"index":0,"function":{"arguments":"{\"ci"}}
//        {"index":0,"function":{"arguments":"ty\":\"北京\"}"}}
//      第一片带 id 和 name，后续只带 arguments 碎片，要按 index 拼起来。
//      多个并行工具调用会交错到达，所以得用 index → 半成品 的映射，
//      不能假设「一个调用的所有分片是连续的」。
// ============================================================================

use std::collections::BTreeMap;

use anyhow::Result;
use serde_json::Value;

use crate::llm::wire::parse_args;
use crate::types::{ModelResult, ToolCall};

/// SSE 行解码器：吃任意切分的字节流，吐完整的行。
#[derive(Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
}

/// 一行 SSE 的语义。
#[derive(Debug, PartialEq)]
pub enum SseEvent {
    /// `data: {...}` 里的 JSON 载荷
    Data(String),
    /// `data: [DONE]`，流正常结束
    Done,
    /// 空行、注释、其他字段，忽略
    Ignore,
}

impl SseDecoder {
    /// 喂一段字节，返回其中所有**完整**的行。不完整的尾巴留在缓冲区等下一段。
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut lines = Vec::new();
        // \n 是 ASCII，UTF-8 的多字节序列里每个字节都 >= 0x80，
        // 所以在字节层面按 \n 切不会切坏汉字。
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            // 去掉行尾的 \n 和可能的 \r
            let end = line.len() - 1;
            let end = if end > 0 && line[end - 1] == b'\r' {
                end - 1
            } else {
                end
            };
            // 到这里一定是完整行，转 String 是安全的
            lines.push(String::from_utf8_lossy(&line[..end]).into_owned());
        }
        lines
    }

    /// 流结束时缓冲区里可能还剩最后一行（服务端没发末尾换行）。
    pub fn flush(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let line = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        Some(line)
    }
}

/// 解析一行 SSE。
pub fn parse_sse_line(line: &str) -> SseEvent {
    let line = line.trim_end();
    // 注释行（keep-alive 心跳常用 `:` 开头）和空行都忽略
    let Some(payload) = line.strip_prefix("data:") else {
        return SseEvent::Ignore;
    };
    let payload = payload.trim();
    if payload == "[DONE]" {
        return SseEvent::Done;
    }
    if payload.is_empty() {
        return SseEvent::Ignore;
    }
    SseEvent::Data(payload.to_string())
}

/// 一个还没拼完的工具调用。
#[derive(Default, Debug)]
struct Partial {
    id: String,
    name: String,
    /// arguments 的碎片，按到达顺序拼接
    args_buf: String,
}

/// 把流式分片累积成最终的 ModelResult。
#[derive(Default)]
pub struct StreamAccumulator {
    text: String,
    /// index → 半成品。BTreeMap 保证 finish 时按 index 升序输出，
    /// 与非流式路径的顺序一致。
    tool_calls: BTreeMap<u64, Partial>,
}

impl StreamAccumulator {
    /// 吃一个 chunk 的 JSON。返回这个 chunk 里的文本增量（如果有），
    /// 调用方拿它触发 on_text 回调实时显示。
    pub fn push_chunk(&mut self, chunk: &Value) -> Option<String> {
        let delta = &chunk["choices"][0]["delta"];

        if let Some(arr) = delta["tool_calls"].as_array() {
            for tc in arr {
                // index 缺失时按 0 处理：单个工具调用的场景有些实现会省略
                let index = tc["index"].as_u64().unwrap_or(0);
                let slot = self.tool_calls.entry(index).or_default();
                // id 和 name 只在第一片出现，用 if let 而不是覆盖，
                // 避免后续空片把已拿到的值清掉
                if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                    slot.id = id.to_string();
                }
                if let Some(name) = tc["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                    slot.name = name.to_string();
                }
                if let Some(frag) = tc["function"]["arguments"].as_str() {
                    slot.args_buf.push_str(frag);
                }
            }
        }

        // content 在工具调用轮次是 null，用 as_str 过滤掉
        let text = delta["content"].as_str().filter(|s| !s.is_empty())?;
        self.text.push_str(text);
        Some(text.to_string())
    }

    /// 收尾：把累积的碎片解析成 ModelResult。
    ///
    /// arguments 只有在这里才解析 —— 中途的碎片是不完整的 JSON，
    /// 提前解析必然失败。这就是必须先按 index 全部拼完再解析的原因。
    pub fn finish(self) -> Result<ModelResult> {
        let tool_calls = self
            .tool_calls
            .into_values()
            .map(|p| {
                Ok(ToolCall {
                    id: p.id,
                    name: p.name,
                    args: parse_args(&p.args_buf)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(ModelResult {
            text: self.text,
            tool_calls,
        })
    }
}
