// ============================================================================
// tests/mcp.rs —— MCP 工具发现与调用
// ----------------------------------------------------------------------------
// 分两层：
//   • 假客户端：测翻译层和多 server 合并语义，不起子进程，快
//   • 真子进程：拿项目自带的 @modelcontextprotocol/server-filesystem 跑一遍
//     完整链路（起进程 → 握手 → tools/list → tools/call），验 rmcp 集成
//     真的通。node_modules 不在时自动跳过。
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{Result, bail};
use async_trait::async_trait;
use serde_json::{Value, json};
use smallest_agent_core::mcp::{
    ConnectFuture, McpConnection, McpServerSpec, McpToolClient, McpToolInfo, load_mcp_tools,
    load_mcp_tools_from_servers,
};
use smallest_agent_core::tools::run_tool;
use smallest_agent_core::types::Args;

// ===== 假客户端 =====

struct FakeClient {
    tools: Vec<McpToolInfo>,
    calls: AtomicU32,
    /// 调用时返回的内容；Err 模拟 server 报错
    outcome: Result<String, String>,
}

impl FakeClient {
    fn new(names: &[&str], outcome: Result<String, String>) -> Arc<Self> {
        Arc::new(Self {
            tools: names
                .iter()
                .map(|n| McpToolInfo {
                    name: n.to_string(),
                    description: format!("{n} 的说明"),
                    input_schema: json!({
                        "type": "object",
                        "properties": { "q": { "type": "string" } }
                    }),
                })
                .collect(),
            calls: AtomicU32::new(0),
            outcome,
        })
    }
}

#[async_trait]
impl McpToolClient for FakeClient {
    async fn list_tools(&self) -> Result<Vec<McpToolInfo>> {
        Ok(self.tools.clone())
    }
    async fn call_tool(&self, _name: &str, _args: &Args) -> Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match &self.outcome {
            Ok(s) => Ok(s.clone()),
            Err(e) => bail!("{e}"),
        }
    }
}

struct FakeConn(Arc<FakeClient>);

#[async_trait]
impl McpConnection for FakeConn {
    fn client(&self) -> Arc<dyn McpToolClient> {
        self.0.clone()
    }
    async fn close(&self) -> Result<()> {
        Ok(())
    }
}

fn args(v: Value) -> Args {
    v.as_object().cloned().unwrap_or_default()
}

#[tokio::test]
async fn discovers_tools_into_registry() {
    let client = FakeClient::new(&["read_file", "write_file"], Ok("内容".into()));
    let registry = load_mcp_tools(client.clone()).await.unwrap();

    assert_eq!(registry.len(), 2);
    let t = registry.get("read_file").unwrap();
    assert_eq!(t.name(), "read_file");
    assert_eq!(t.description(), "read_file 的说明");
    // input_schema 原样透传给模型，没有 TS 那边 jsonSchema() 的包装层
    assert_eq!(t.parameters()["type"], "object");
    assert_eq!(t.parameters()["properties"]["q"]["type"], "string");
}

#[tokio::test]
async fn tool_run_goes_through_client() {
    let client = FakeClient::new(&["echo"], Ok("回来了".into()));
    let registry = load_mcp_tools(client.clone()).await.unwrap();

    let out = run_tool(&registry, "echo", &args(json!({ "q": "hi" }))).await;
    // run_tool 对结果做 JSON 序列化，字符串会带引号（与 TS 的 JSON.stringify 一致）
    assert_eq!(out, r#""回来了""#);
    assert_eq!(client.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn server_error_becomes_json_error_not_a_result() {
    // MCP 报错时不能把错误文本当正常结果喂回模型 —— 这是相对 TS 版的改进，
    // TS 那边忽略 is_error，错误文本会被模型当成有效数据继续推理。
    let client = FakeClient::new(&["boom"], Err("文件不存在".into()));
    let registry = load_mcp_tools(client).await.unwrap();

    let out = run_tool(&registry, "boom", &args(json!({}))).await;
    assert!(out.starts_with(r#"{"error":"#), "实际：{out}");
    assert!(out.contains("文件不存在"));
}

#[tokio::test]
async fn merges_servers_with_later_overriding() {
    let a = FakeClient::new(&["shared", "only_a"], Ok("A".into()));
    let b = FakeClient::new(&["shared", "only_b"], Ok("B".into()));
    let (ca, cb) = (a.clone(), b.clone());

    let specs = vec![
        McpServerSpec::new("server-a", Vec::<String>::new()),
        McpServerSpec::new("server-b", Vec::<String>::new()),
    ];
    let connect = move |spec: McpServerSpec| -> ConnectFuture {
        let client = if spec.command == "server-a" {
            ca.clone()
        } else {
            cb.clone()
        };
        Box::pin(async move {
            let conn: Arc<dyn McpConnection> = Arc::new(FakeConn(client));
            Ok(conn)
        })
    };

    let merged = load_mcp_tools_from_servers(&specs, &connect).await.unwrap();
    assert_eq!(merged.tools.len(), 3, "shared 只算一个");
    assert!(merged.tools.contains_key("only_a"));
    assert!(merged.tools.contains_key("only_b"));

    // 同名工具：后面的 server 覆盖前面的（与 TS 的 Object.assign 一致）
    let out = run_tool(&merged.tools, "shared", &args(json!({}))).await;
    assert_eq!(out, r#""B""#);

    merged.close().await.unwrap();
}

#[tokio::test]
async fn connect_failure_names_the_server() {
    let specs = vec![McpServerSpec::new("does-not-exist", ["--flag"])];
    let connect =
        |_spec: McpServerSpec| -> ConnectFuture { Box::pin(async { bail!("起不来") }) };

    let err = load_mcp_tools_from_servers(&specs, &connect)
        .await
        .unwrap_err();
    // 错误链里要能看出是哪个 server 挂的
    assert!(
        format!("{err:#}").contains("does-not-exist"),
        "实际：{err:#}"
    );
}

// ===== 真子进程：端到端 =====

/// 项目自带的 filesystem MCP server。没装 node_modules 就跳过。
fn filesystem_server() -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../node_modules/.bin/mcp-server-filesystem");
    p.canonicalize().ok().filter(|p| p.exists())
}

#[tokio::test]
async fn end_to_end_against_real_stdio_server() {
    let Some(bin) = filesystem_server() else {
        eprintln!("跳过：node_modules/.bin/mcp-server-filesystem 不存在");
        return;
    };

    // 给 server 一个只含一个文件的临时目录作为允许访问范围。
    //
    // 必须 canonicalize：macOS 上 std::env::temp_dir() 返回 /var/folders/...，
    // 而 /var 是 /private/var 的符号链接。filesystem server 会把允许目录规范化，
    // 却拿它去比未规范化的请求路径，于是 /var/... 被判成「不在 /private/var/... 里」，
    // 报 Access denied。
    let dir = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("smallest-agent-mcp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.txt"), "来自 MCP 的内容").unwrap();

    let spec = McpServerSpec::new(
        bin.to_string_lossy().to_string(),
        [dir.to_string_lossy().to_string()],
    );

    let merged = load_mcp_tools_from_servers(
        std::slice::from_ref(&spec),
        &smallest_agent_core::mcp::default_connect,
    )
    .await
    .expect("连真 MCP server 失败");

    // 动态发现：工具不是写死的，是问出来的
    assert!(
        !merged.tools.is_empty(),
        "应该发现了工具：{:?}",
        merged.tools.keys().collect::<Vec<_>>()
    );
    assert!(
        merged.tools.contains_key("read_text_file") || merged.tools.contains_key("read_file"),
        "实际发现的工具：{:?}",
        merged.tools.keys().collect::<Vec<_>>()
    );

    // 真调一次
    let tool_name = if merged.tools.contains_key("read_text_file") {
        "read_text_file"
    } else {
        "read_file"
    };
    let path = dir.join("note.txt").to_string_lossy().to_string();
    let out = run_tool(&merged.tools, tool_name, &args(json!({ "path": path }))).await;
    assert!(out.contains("来自 MCP 的内容"), "实际：{out}");

    merged.close().await.unwrap();
    std::fs::remove_dir_all(&dir).ok();
}
