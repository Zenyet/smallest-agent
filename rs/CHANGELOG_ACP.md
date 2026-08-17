# ACP Provider 实现

## 改动概要

新增外部 agent CLI 支持，走 Agent Client Protocol (ACP) 标准协议。

## 核心变更

### 1. Provider 抽象层 (`core/src/provider/mod.rs`)

引入 `Provider` trait，统一内置 agent 和外部 CLI 的接口：

```rust
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn manages_own_tools(&self) -> bool;
    async fn run_turn(&self, req: TurnRequest) -> Result<String>;
}
```

- `TurnRequest` 包含问题、历史、事件流、取消令牌
- `TurnEvent` 统一事件类型（文字增量、工具调用、降级、缓存命中）
- `EventSink` 是事件的去处，UI 通过它实时更新界面

### 2. 内置 Agent 迁移 (`core/src/provider/builtin.rs`)

把原来的 `run_agent` 包成 `BuiltinProvider`：

- 装配逻辑（HTTP → 降级 → 重试 → 缓存）从 UI 挪到这里
- 每轮重绑取消令牌，复用 HTTP client 的连接池
- 把 `OnTurn` 回调转成统一的 `TurnEvent::ToolCall`

### 3. ACP Provider (`core/src/provider/acp.rs`)

驱动外部 CLI（claude code / codex / opencode）：

- 懒连接：第一次对话才起子进程，避免启动时白起不用的进程
- 长命会话：连接住在后台任务里，外面只留 mpsc 发送端
- 协议转发：
  - ACP 的 `SessionNotification` → `TurnEvent`
  - ACP 的 `RequestPermissionRequest` → 我们的 `ApprovalRequest`
- 取消支持：用户点停止时立刻中断 CLI

预设了两个官方适配器：

```rust
AcpSpec::claude_code(cwd)  // @agentclientprotocol/claude-agent-acp
AcpSpec::codex(cwd)        // @agentclientprotocol/codex-acp
```

### 4. 审批机制 (`core/src/approval.rs`)

危险操作（写文件、执行命令）前的确认：

- `Approver` trait：UI 实现它（弹卡片），CLI 实现成读 stdin，测试实现成固定答案
- `ApprovalRequest`：包含标题、细节、选项列表
- `Responder`：oneshot 回信通道，Drop 时自动回 Cancelled
- 5 分钟超时：避免被忽略的请求把会话永久挂住

内置 agent 和 ACP provider 都用它 —— 前者是 MCP 工具可能改磁盘，后者是协议里就有 `session/request_permission`。

### 5. UI 适配 (`ui/src/chat.rs`)

- `ChatView` 不再直接持有 `CallModel`，改持有 `Arc<dyn Provider>`
- 每个会话存自己的 `pending_approval` 和 `cancel` 令牌
- 工具状态变成 `ToolsStatus`（Loading / Ready / Failed），后台连 MCP 时不阻塞界面
- 审批卡片渲染在消息流里，用户点按钮后 `Responder::respond`

### 6. MCP 配置文件化 (`ui/src/mcp_config.rs`)

从代码里写死的数组改成 `~/.config/smallest-agent/mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "disabled": true
    }
  }
}
```

形状照 Claude Desktop / Cursor / Cline 的配置，用户能直接粘过来。

## 为什么这样改

### Provider 抽象的必要性

原来的设计是「UI 直接调 `run_agent`」，外加一摞装饰器（重试、降级、缓存）。要支持外部 CLI 有两条路：

1. 让 CLI 也实现 `CallModel` —— 但它不是「调一次模型」，而是「跑一轮对话」，语义不匹配
2. 抽象出 `Provider` —— 一轮对话的完整逻辑，内置和外部都实现它

选了 2，因为：
- 内置和外部的差异不只是「谁调模型」，还有工具管理、取消语义、审批流程
- UI 完全不关心背后是哪种，只认 `TurnEvent` 流

### 长命会话的必要性

ACP SDK 的 API 是作用域式的：

```rust
Client.builder()...connect_with(agent, |connection| async { ... })
```

闭包返回连接就断。但我们要的是「建一次会话，多轮对话」—— 用户在同一个会话里连续提问，而 CLI 那侧维护着上下文（这正是用外部 CLI 的意义）。

解法是让连接住在后台任务里，外面只留 mpsc 发送端。每轮对话发一条命令进去，任务里的闭包一直不返回，所以连接一直活着。

### 审批机制的设计

两个 provider 都需要它，理由不同但形状一样：

- 内置 agent：MCP 工具里的 `write_file` / `execute_command` 会改用户的磁盘
- ACP provider：协议里就有 `session/request_permission`，agent 写文件前会主动问

统一成 `Approver` trait，UI 实现它（弹卡片等用户点），CLI 实现成读 stdin，测试实现成固定答案。

带超时（5 分钟）是必须的 —— 用户可能关了窗口或没注意到卡片，而 agent 任务在等一个永远不会来的答案，那个会话就永久卡住，连「停止」都点不了。

## 测试覆盖

- 90 个已有测试全部通过（cancel / config / decorators / cache / http / mcp / memory / stream / wire）
- 审批机制有独立测试（`approval.rs` 里的 10 个）
- 没有 ACP 的集成测试 —— 它要真起 npx 子进程，太慢且依赖网络

## 未来工作

- [ ] UI 里切换 provider（下拉菜单或侧边栏）
- [ ] ACP provider 的重连逻辑（子进程崩了之后自动重启）
- [ ] 审批卡片的「本会话都允许」选项（目前只有「允许 / 拒绝」）
- [ ] 外部 CLI 的工具列表展示（ACP 协议里有 `tools/list`）
