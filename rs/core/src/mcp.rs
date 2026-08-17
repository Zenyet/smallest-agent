// ============================================================================
// mcp.rs —— 通用 MCP 客户端：连接 stdio 子进程并动态发现工具
//           （对应 TS 版 src/mcp/client.ts）
// ----------------------------------------------------------------------------
// MCP（Model Context Protocol）让模型能调用外部「工具服务器」。这个文件做的事：
// 不把工具写死在代码里，而是运行时向 MCP server 问「你有什么工具」，
// 拿到描述后动态组装成 agent 能用的 ToolRegistry。
//
// 调用链和 TS 版一致：
//   connect_mcp（建连接）→ load_mcp_tools（发现工具 + 包装成 Tool）
//   → load_mcp_tools_from_servers（多 server 合并，给上层用的入口）
//
// ## 与 TS 版的差异
//
// 1. TS 那边 McpToolClient 是个「最小接口」，方便测试注入假客户端。
//    这边同样抽了 trait（McpToolClient），但多了一层必要性：rmcp 的
//    RunningService 是具体类型、没有 trait 抽象，不包一层就没法单测。
//
// 2. TS 用 jsonSchema() 给 inputSchema 补 SDK 要的元数据字段。
//    这边不需要——Tool::parameters() 直接就是裸 JSON Schema。
//
// 3. rmcp 的工具结果是 Vec<ContentBlock>（可能含图片、音频、资源链接），
//    这里和 TS 一样只取 text 类型拼接。但多做一件事：MCP 有 is_error 标记，
//    TS 版忽略了它，这边把它转成 Err，让 run_tool 统一序列化成
//    {"error": ...} 交给模型——模型因此能知道工具失败了，而不是把错误文本
//    当成正常结果继续推理。
// ============================================================================

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use async_trait::async_trait;
use serde_json::{Map, Value, json};

use crate::runtime;
use crate::types::{Args, Tool, ToolRegistry};

/// 一个 MCP server 的启动方式：命令 + 参数。
#[derive(Debug, Clone)]
pub struct McpServerSpec {
    pub command: String,
    pub args: Vec<String>,
    /// 额外环境变量，叠在当前进程的环境之上。
    ///
    /// 必需而不是可选：有些 server 只能靠环境变量配置（API token、
    /// 运行模式开关）。Electron 版为了加这个字段专门复刻了一份连接器
    /// （`electron/main/mcp-connect.ts`，注释里写「代价是 6 行重复，
    /// 换来 src/ 一行不改」）—— 这边直接做进 spec 里，省掉那份重复。
    pub env: BTreeMap<String, String>,
}

impl McpServerSpec {
    pub fn new(
        command: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: BTreeMap::new(),
        }
    }

    pub fn with_env(mut self, env: BTreeMap<String, String>) -> Self {
        self.env = env;
        self
    }
}

/// 一个工具的描述，从 MCP server 的 tools/list 得来。
#[derive(Debug, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    /// 裸 JSON Schema，原样交给模型
    pub input_schema: Value,
}

/// 对 MCP 客户端能力的最小接口约束。
///
/// 抽 trait 的两个理由：测试能注入假客户端不起真子进程；
/// rmcp 的 RunningService 是具体类型没有 trait 抽象，不包一层没法替换。
#[async_trait]
pub trait McpToolClient: Send + Sync {
    async fn list_tools(&self) -> Result<Vec<McpToolInfo>>;
    /// 返回工具输出的文本。server 报错（is_error）时返回 Err。
    async fn call_tool(&self, name: &str, args: &Args) -> Result<String>;
}

/// 把一个 MCP server 暴露的单个工具适配成内部 Tool。
///
/// 每次 run 就是向同一个 server 发 tools/call。
struct McpTool {
    client: Arc<dyn McpToolClient>,
    info: McpToolInfo,
}

#[async_trait]
impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.info.name
    }
    fn description(&self) -> &str {
        &self.info.description
    }
    fn parameters(&self) -> Value {
        self.info.input_schema.clone()
    }
    async fn run(&self, args: &Args) -> Result<Value> {
        // 返回 Value::String 而不是 json!({"text": ...})：
        // run_tool 会对它做 serde_json::to_string，结果是带引号的 JSON 字符串，
        // 与 TS 版 JSON.stringify(string) 的行为一致。
        Ok(Value::String(
            self.client.call_tool(&self.info.name, args).await?,
        ))
    }
}

/// 向一个 MCP server 发 tools/list，把每个工具描述包成 ToolRegistry 条目。
pub async fn load_mcp_tools(client: Arc<dyn McpToolClient>) -> Result<ToolRegistry> {
    let tools = client.list_tools().await.context("MCP tools/list 失败")?;
    let mut registry = ToolRegistry::new();
    for info in tools {
        let name = info.name.clone();
        let tool: Arc<dyn Tool> = Arc::new(McpTool {
            client: client.clone(),
            info,
        });
        registry.insert(name, tool);
    }
    Ok(registry)
}

/// 多个 MCP server 的工具合并成一个 ToolRegistry。
///
/// 同名工具后面的 server 覆盖前面的（BTreeMap::insert 语义，与 TS 的
/// Object.assign 一致），所以 server 顺序有意义。
///
/// connect 参数可注入，默认是 connect_mcp —— 依赖注入让这里可测，
/// 对应 TS 版 loadMcpToolsFromServers 的第二个默认参数。
pub async fn load_mcp_tools_from_servers(
    servers: &[McpServerSpec],
    connect: &(dyn Fn(McpServerSpec) -> ConnectFuture + Send + Sync),
) -> Result<McpTools> {
    let mut conns: Vec<Arc<dyn McpConnection>> = Vec::new();
    let mut tools = ToolRegistry::new();
    for spec in servers {
        let command = spec.command.clone();
        let conn = connect(spec.clone())
            .await
            .with_context(|| format!("连接 MCP server 失败：{command}"))?;
        let t = load_mcp_tools(conn.client()).await?;
        tools.extend(t);
        conns.push(conn);
    }
    Ok(McpTools { tools, conns })
}

/// connect 回调返回的 future 类型。
///
/// 写成 Pin<Box<dyn Future>> 而不是 async fn，是因为要能作为 &dyn Fn 参数传入
/// （async fn 每个都是不同的匿名类型，没法统一）。
///
/// 回调接收的是 McpServerSpec 的所有权而不是引用，future 因此是 'static。
/// 一开始写的是 `Fn(&McpServerSpec) -> ConnectFuture<'_>`，结果闭包的返回类型
/// 没法和参数位置要求的高阶 trait bound 统一（"one type is more general than
/// the other"）。spec 只是个 String + Vec<String>，clone 的代价远小于
/// 为省这一次 clone 去跟生命周期较劲。
pub type ConnectFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Arc<dyn McpConnection>>> + Send>>;

/// 一个已建立的连接。close 供程序退出时优雅断开。
#[async_trait]
pub trait McpConnection: Send + Sync {
    fn client(&self) -> Arc<dyn McpToolClient>;
    async fn close(&self) -> Result<()>;
}

/// load_mcp_tools_from_servers 的产物：合并后的工具 + 所有连接的句柄。
pub struct McpTools {
    pub tools: ToolRegistry,
    conns: Vec<Arc<dyn McpConnection>>,
}

/// 手写 Debug 而不是 derive：Arc<dyn McpConnection> 和 Arc<dyn Tool> 都没有 Debug。
/// 打工具名 + 连接数，足够排查「发现了哪些工具」这类问题。
impl std::fmt::Debug for McpTools {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpTools")
            .field("tools", &self.tools.keys().collect::<Vec<_>>())
            .field("connections", &self.conns.len())
            .finish()
    }
}

impl McpTools {
    /// 并发关闭所有连接，而不是串行等待，避免退出阶段多余延迟
    /// （对应 TS 的 Promise.all）。
    pub async fn close(&self) -> Result<()> {
        let futures: Vec<_> = self.conns.iter().map(|c| c.close()).collect();
        for r in futures_util::future::join_all(futures).await {
            r?;
        }
        Ok(())
    }
}

// ============================================================================
// 以下是基于 rmcp（MCP 官方 Rust SDK）的真实实现。
//
// 又一次撞上运行时接缝：rmcp 用 tokio::process 起子进程、用 tokio 的 IO 读写
// 管道，所以连接的建立和每次调用都得在专用运行时里跑。和 llm 一样走
// runtime::spawn，边界收敛在这几个函数里。
//
// 额外的约束是 RunningService 不是 Sync（内部有 tokio 的单向通道），
// 没法直接放进 Arc<dyn McpToolClient>（要求 Send + Sync）。所以让它整个
// 住在运行时那侧：RmcpClient 只持有一个 mpsc 发送端，把请求发进去、
// 用 oneshot 收回结果。这样跨线程的只有消息，不是服务对象本身。
// ============================================================================

use rmcp::ServiceExt as _;
use rmcp::model::CallToolRequestParams;
use tokio::sync::{mpsc, oneshot};

/// 发给后台 MCP 任务的请求。
enum McpRequest {
    ListTools(oneshot::Sender<Result<Vec<McpToolInfo>>>),
    CallTool {
        name: String,
        args: Map<String, Value>,
        reply: oneshot::Sender<Result<String>>,
    },
    Close(oneshot::Sender<Result<()>>),
}

/// 真实的 MCP 客户端：只是个通往后台任务的通道。
pub struct RmcpClient {
    tx: mpsc::UnboundedSender<McpRequest>,
}

#[async_trait]
impl McpToolClient for RmcpClient {
    async fn list_tools(&self) -> Result<Vec<McpToolInfo>> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(McpRequest::ListTools(reply))
            .map_err(|_| anyhow::anyhow!("MCP 后台任务已退出"))?;
        rx.await.context("等 tools/list 回复失败")?
    }

    async fn call_tool(&self, name: &str, args: &Args) -> Result<String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(McpRequest::CallTool {
                name: name.to_string(),
                args: args.clone(),
                reply,
            })
            .map_err(|_| anyhow::anyhow!("MCP 后台任务已退出"))?;
        rx.await.context("等 tools/call 回复失败")?
    }
}

/// 一个真实连接：持有通道，close 时通知后台任务收尾。
pub struct RmcpConnection {
    client: Arc<RmcpClient>,
}

#[async_trait]
impl McpConnection for RmcpConnection {
    fn client(&self) -> Arc<dyn McpToolClient> {
        self.client.clone()
    }
    async fn close(&self) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        // 通道已断说明后台任务早退了，当作已关闭
        if self.client.tx.send(McpRequest::Close(reply)).is_err() {
            return Ok(());
        }
        rx.await.context("等关闭回复失败")?
    }
}

/// 起一个 stdio 子进程并建立 MCP 连接。
///
/// stdio 模式：父进程把子进程的 stdin/stdout 当管道，协议消息通过管道互传。
pub async fn connect_mcp(spec: &McpServerSpec) -> Result<Arc<dyn McpConnection>> {
    let (tx, mut rx) = mpsc::unbounded_channel::<McpRequest>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<()>>();
    let command = spec.command.clone();
    let args = spec.args.clone();
    let env = spec.env.clone();

    // 整个服务对象住在运行时那侧，外面只留通道 —— 见本段开头的注释。
    runtime::handle().spawn(async move {
        let mut cmd = tokio::process::Command::new(&command);
        cmd.args(&args);
        // 叠在继承的环境之上（不是替换）—— server 通常还需要 PATH、HOME 之类
        cmd.envs(&env);
        let transport = match rmcp::transport::TokioChildProcess::new(cmd) {
            Ok(t) => t,
            Err(e) => {
                let _ = ready_tx.send(Err(anyhow::Error::new(e).context("起 MCP 子进程失败")));
                return;
            }
        };
        // () 作为 ClientHandler：我们不处理 server 主动发起的请求
        let service = match ().serve(transport).await {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(anyhow::Error::new(e).context("MCP 握手失败")));
                return;
            }
        };
        if ready_tx.send(Ok(())).is_err() {
            // 调用方已经放弃等待，收尾退出
            let _ = service.cancel().await;
            return;
        }

        while let Some(req) = rx.recv().await {
            match req {
                McpRequest::ListTools(reply) => {
                    let r = service
                        .list_all_tools()
                        .await
                        .map_err(|e| anyhow::Error::new(e).context("tools/list 失败"))
                        .map(|tools| tools.into_iter().map(to_tool_info).collect());
                    let _ = reply.send(r);
                }
                McpRequest::CallTool { name, args, reply } => {
                    let params = CallToolRequestParams::new(name).with_arguments(args);
                    let r = match service.call_tool(params).await {
                        Ok(res) => extract_text(res),
                        Err(e) => Err(anyhow::Error::new(e).context("tools/call 失败")),
                    };
                    let _ = reply.send(r);
                }
                McpRequest::Close(reply) => {
                    let r = service
                        .cancel()
                        .await
                        .map(|_| ())
                        .map_err(|e| anyhow::Error::new(e).context("关闭 MCP 连接失败"));
                    let _ = reply.send(r);
                    return;
                }
            }
        }
        // 通道被 drop（McpTools 没了），顺手收尾子进程
        let _ = service.cancel().await;
    });

    ready_rx.await.context("等 MCP 连接就绪失败")??;
    Ok(Arc::new(RmcpConnection {
        client: Arc::new(RmcpClient { tx }),
    }))
}

/// connect_mcp 的 ConnectFuture 包装，直接传给 load_mcp_tools_from_servers。
pub fn default_connect(spec: McpServerSpec) -> ConnectFuture {
    Box::pin(async move { connect_mcp(&spec).await })
}

/// rmcp 的 Tool → 内部 McpToolInfo。
fn to_tool_info(t: rmcp::model::Tool) -> McpToolInfo {
    McpToolInfo {
        name: t.name.to_string(),
        description: t.description.map(|d| d.to_string()).unwrap_or_default(),
        // input_schema 是 Arc<JsonObject>，取出来转成 Value
        input_schema: Value::Object((*t.input_schema).clone()),
    }
}

/// 从 CallToolResult 里取文本。
///
/// content 是数组，可能含图片 / 音频 / 资源链接；这里只取 text 拼接，
/// 足以覆盖本项目所有工具的输出（与 TS 版一致）。
///
/// 比 TS 版多做一件事：MCP 有 is_error 标记，TS 那边忽略了它，
/// 于是工具报错的文本会被当成正常结果喂回模型。这边转成 Err，
/// 由 run_tool 统一包成 {"error": ...}，模型能看出这是失败。
fn extract_text(res: rmcp::model::CallToolResult) -> Result<String> {
    let text = res
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");

    if res.is_error.unwrap_or(false) {
        // structured_content 有时带更具体的错误信息，一并带上便于排查
        match &res.structured_content {
            Some(sc) if text.is_empty() => bail!("MCP 工具报错：{sc}"),
            Some(sc) => bail!("MCP 工具报错：{text}（{sc}）"),
            None if text.is_empty() => bail!("MCP 工具报错（无错误详情）"),
            None => bail!("MCP 工具报错：{text}"),
        }
    }

    // 没有 text 内容但有结构化结果时，退化成结构化结果的 JSON。
    // 否则模型会拿到空字符串，完全不知道发生了什么。
    if text.is_empty()
        && let Some(sc) = res.structured_content
    {
        return Ok(json!(sc).to_string());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    // extract_text 是私有函数，放模块内测。测的是「rmcp 的结果 → 内部字符串」
    // 这层翻译里几个容易漏的分支。
    use super::*;
    use rmcp::model::{CallToolResult, ContentBlock};

    #[test]
    fn joins_multiple_text_blocks() {
        let res = CallToolResult::success(vec![
            ContentBlock::text("第一段"),
            ContentBlock::text("第二段"),
        ]);
        assert_eq!(extract_text(res).unwrap(), "第一段\n第二段");
    }

    #[test]
    fn skips_non_text_blocks() {
        // 图片等非文本块直接跳过，只取 text（与 TS 版一致）
        let res = CallToolResult::success(vec![
            ContentBlock::text("说明"),
            ContentBlock::image("BASE64", "image/png"),
        ]);
        assert_eq!(extract_text(res).unwrap(), "说明");
    }

    #[test]
    fn empty_content_is_empty_string() {
        assert_eq!(extract_text(CallToolResult::success(vec![])).unwrap(), "");
    }

    #[test]
    fn is_error_becomes_err() {
        // 这是相对 TS 版的改进：TS 忽略 is_error，错误文本会被当成正常结果
        // 喂回模型，模型于是基于「文件不存在」这句话继续推理，而不知道调用失败了。
        let res = CallToolResult::error(vec![ContentBlock::text("文件不存在")]);
        let err = extract_text(res).unwrap_err();
        assert!(err.to_string().contains("文件不存在"));
        assert!(err.to_string().contains("MCP 工具报错"));
    }

    #[test]
    fn error_without_text_still_reports() {
        let res = CallToolResult::error(vec![]);
        let err = extract_text(res).unwrap_err();
        assert!(err.to_string().contains("无错误详情"));
    }
}
