# Smallest Agent - Electron 桌面版设计文档

**日期**: 2026-08-11  
**目标**: 将现有的 CLI agent 项目改造成 Electron 桌面应用，提供聊天界面，用于个人学习和开源分享

## 项目背景

现有项目 `smallest-agent` 是一个完整的 CLI 命令行 agent，包含：
- 手写 ReAct 循环（`src/agent.ts`）
- RAG（向量检索 + embedding）
- 记忆系统（会话持久化 + 上下文压缩）
- MCP 工具动态加载
- 生产化包装（缓存、重试、降级、流式输出、LLM-as-Judge）
- 评估系统

目标是在**完全不修改现有 `src/` 核心代码**的前提下，用 Electron 包装一个桌面端，主要用于：
1. 个人快速测试和学习 agent 开发
2. 开源分享给其他开发者学习

## 整体架构

### 架构选型：最小改动迁移

**Main 进程**（Node.js 环境）直接复用现有 `src/` 核心代码，**Renderer 进程**（浏览器环境）用 React 实现聊天 UI，通过 IPC 通信。

**优势**：
- 核心 agent 逻辑零修改
- 学习曲线平滑（只需学 Electron 基础 + IPC）
- Main 进程可直接运行 transformers.js embedding、MCP stdio server
- 技术栈成熟（Electron + React + Vite）

### 目录结构

```
smallest-agent/
├── src/              # 现有 agent 核心代码（完全不动）
│   ├── agent.ts      # ReAct 循环
│   ├── llm.ts        # 模型调用
│   ├── rag/          # 向量检索
│   ├── memory/       # 会话记忆
│   ├── mcp/          # MCP client
│   ├── tools/        # 工具执行器
│   ├── resilience.ts # 重试降级
│   ├── cache.ts      # LLM 缓存
│   ├── verify.ts     # LLM-as-Judge
│   └── ...
├── electron/         # 新增 Electron 代码
│   ├── main/         # Main 进程
│   │   ├── index.ts          # 主进程入口，创建窗口 + App 级装配
│   │   ├── agent-runtime.ts  # App 级装配：embedding/索引/MCP，长驻
│   │   ├── ipc-handlers.ts   # 请求级装配 + runAgent 调用
│   │   ├── sessions.ts       # 会话列表（readdir，SessionStore 没有 list）
│   │   ├── settings.ts       # electron-store + env 合并
│   │   ├── mcp-paths.ts      # 开发/生产两种 MCP server 启动方式
│   │   └── preload.ts        # contextBridge 暴露 electronAPI
│   └── renderer/     # Renderer 进程（前端）
│       ├── src/
│       │   ├── App.tsx               # 主组件
│       │   ├── components/
│       │   │   ├── SessionList.tsx   # 左侧会话列表
│       │   │   ├── ChatWindow.tsx    # 右侧聊天窗口
│       │   │   ├── MessageBubble.tsx # 单条消息
│       │   │   └── ToolCallIndicator.tsx  # 工具调用展示
│       │   ├── stores/               # 前端状态
│       │   └── api.ts                # IPC API 封装
│       ├── index.html
│       └── vite.config.ts
├── cli.ts            # 原 CLI 入口（保留）
├── mcp-server.ts     # MCP server（Main 进程启动）
└── package.json
```

### 进程职责

**Main 进程**：
- 创建应用窗口
- **App 级装配**：加载 embedding 模型、构建笔记索引、启动并连接 MCP server（启动时一次）
- 接收 Renderer 的 IPC 请求，**请求级装配** callModel 装饰链后调用 `runAgent`
- 管理会话文件（`userData/sessions/`）
- 流式推送 agent 输出给前端

**Renderer 进程**：
- 渲染聊天界面（会话列表 + 消息流）
- 管理前端状态（当前会话、消息列表）
- 通过 `window.electronAPI` 调用 Main 进程
- 实时显示流式消息、工具调用过程

**安全隔离**：
- 使用 `contextBridge` 暴露最小化 API
- 禁用 `nodeIntegration`，启用 `contextIsolation`
- Renderer 无法直接访问 Node.js API

## IPC 通信协议

### API 设计

```typescript
interface ElectronAPI {
  // 会话管理
  listSessions(): Promise<SessionMeta[]>
  createSession(): Promise<string>
  deleteSession(sessionId: string): Promise<void>
  loadSession(sessionId: string): Promise<Message[]>   // 切换会话时拉历史消息

  // Agent 交互
  sendMessage(sessionId: string, message: string): Promise<void>

  // 设置
  getSettings(): Promise<Settings>
  saveSettings(settings: Partial<Settings>): Promise<void>

  // 事件监听（Main → Renderer），返回取消订阅函数
  onMessageChunk(cb: (data: MessageChunkEvent) => void): () => void
  onToolCall(cb: (data: ToolCallEvent) => void): () => void
  onMessageComplete(cb: (data: MessageCompleteEvent) => void): () => void
  onVerdict(cb: (data: VerdictEvent) => void): () => void
  onCacheHit(cb: (data: { sessionId: string }) => void): () => void
  onError(cb: (data: ErrorEvent) => void): () => void
  onRuntimeStatus(cb: (data: RuntimeStatusEvent) => void): () => void  // 启动进度
}
```

### 事件类型

```typescript
interface MessageChunkEvent {
  sessionId: string
  text: string          // 增量 delta，不是全量
  isComplete: boolean
}

interface ToolCallEvent {
  sessionId: string
  turn: number
  toolName: string
  args: Record<string, unknown>
  output: string
}

interface MessageCompleteEvent {
  sessionId: string
  text: string          // 完整答案，前端用它替换累积的流式文本，保证最终一致
}

// 对应 cli.ts 的 makeVerifier：有工具证据时才发
interface VerdictEvent {
  sessionId: string
  grounded: boolean
  issues: string[]
}

interface ErrorEvent {
  sessionId: string
  code: 'API_KEY_MISSING' | 'MODEL_ERROR' | 'MAX_TURNS' | 'BUSY' | 'UNKNOWN'
  message: string
}
// 注：没有 TOOL_ERROR。runTool 捕获工具异常并包成 JSON 返回给模型
// （src/tools/index.ts），工具失败不会中断 agent 循环，因此以工具卡片的
// 内容形式展示，不走顶层错误事件。
// BUSY：已有 runAgent 在跑时再次 sendMessage。

// App 级装配的进度（加载 embedding 模型可能要几十秒）
interface RuntimeStatusEvent {
  phase: 'embedding' | 'indexing' | 'mcp' | 'ready' | 'failed'
  detail: string
}
```

### 消息流程

用户发送消息后：

1. **Renderer → Main**: `electronAPI.sendMessage(sessionId, userInput)`
2. **Main 进程**:
   - 用 `createJsonSessionStore` 加载该会话历史
   - 组装请求级 callModel（绑定本次 sessionId 的流式回调）
   - 调用 `runAgent(userInput, deps)`
   - `onText` 推送文本 delta，`onTurn` 推送工具调用
   - 跑完若有工具证据，调 `makeVerifier` 做 LLM-as-Judge 核查
3. **Main → Renderer**（事件推送）:
   `message-chunk` → `tool-call` → `message-complete` → （可选）`verdict`

**设计理念**：
- 流式优先（用户实时看到 agent 思考过程和逐字输出）
- 事件驱动（Main 主动推送，Renderer 被动接收，不轮询）
- 每个事件都带 sessionId，前端据此路由；用户在 agent 跑的过程中切换会话，
  回来后消息仍然完整
- **串行执行**：同一时刻只有一个 `runAgent` 在跑（见「关键差异」一节的并发约束）。
  运行中前端禁用输入框；`sendMessage` 在已有任务时直接返回错误事件。

## UI 设计

### 主界面布局

```
┌─────────────────────────────────────────────────┐
│  Smallest Agent                            ⚙️ ─ □ ✕│
├──────────────┬──────────────────────────────────┤
│              │                                  │
│  Sessions    │         Chat Window              │
│              │                                  │
│  ● New Chat  │  👤 你好，帮我查天气            │
│              │                                  │
│  Session 1   │  🤖 好的，让我查一下...          │
│  Session 2   │     🔧 get_weather(city="北京")  │
│  Session 3   │     → 晴天，25°C                 │
│              │     根据查询结果，北京今天...     │
│              │                                  │
│              │  👤 [新消息输入框]          [发送]│
└──────────────┴──────────────────────────────────┘
```

### 核心组件

**App.tsx**
- 全局状态：当前 sessionId、会话列表
- 布局：左侧 SessionList + 右侧 ChatWindow

**SessionList.tsx**
- 展示所有会话（从 `electronAPI.listSessions()` 获取）
- "New Chat" 按钮
- 点击切换会话
- 删除会话

**ChatWindow.tsx**
- 展示当前会话的消息列表
- 底部输入框 + 发送按钮
- 调用 `electronAPI.sendMessage()`
- 监听流式事件，实时更新 UI

**MessageBubble.tsx**
- 渲染用户消息 / assistant 消息
- 支持 Markdown 渲染（代码高亮、列表）
- 展示工具调用过程（可折叠）

**ToolCallIndicator.tsx**
- 工具名、参数、返回结果
- JSON 可折叠查看

### 状态管理

使用 React `useState` + `useEffect`（不引入额外状态库）：

```typescript
// App.tsx
const [sessions, setSessions] = useState<SessionMeta[]>([])
const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

// ChatWindow.tsx
const [messages, setMessages] = useState<Message[]>([])
const [streamingText, setStreamingText] = useState<string>('')
const [isAgentThinking, setIsAgentThinking] = useState(false)
```

### 视觉风格

**v1 只做深色主题**（不做明暗切换，减少一个变量；所有颜色走 CSS 变量，将来加浅色主题只需换变量值）：
- 5-7 层深色表面（#05070C, #0A0D12, #0F131C, #161D2B, #1E2636）
- 色相：cyan/emerald 系（#38BDF8, #6EE7B7）用于技术/数据感
- 单一高亮色用于按钮、链接、工具调用标记
- 圆角：按钮 999px pill，消息气泡 16px
- 字体流式缩放 `clamp()`
- 所有颜色和间距用 CSS 变量

## 复用现有代码

### 关键差异：CLI 是「一次性装配」，桌面端是「长驻装配 + 多次运行」

`cli.ts` 的结构是「装配 → 跑一次 → `mcp.close()` 退出」。桌面端必须把这条装配线拆成两段，
这是 CLI → Electron 迁移中唯一真正需要重新设计的地方：

| 阶段 | 内容 | 生命周期 |
|---|---|---|
| **App 级装配**（贵，只做一次） | embedding 模型加载、`buildNotesIndex`、`loadMcpToolsFromServers`、工具注册表合并 | 应用启动时执行，退出时 `mcp.close()` |
| **请求级装配**（便宜，每条消息一次） | `makeCallModel` + `withRetry` / `withCache` / `withFallback`、`onTurn`、`onComplete` | 每次 `sendMessage` 重建 |

**为什么 callModel 必须是请求级的**：`makeCallModel(config, registry, onText)` 把流式回调
**闭包进了 callModel 内部**。如果在 App 启动时装配一次，所有会话的 token 流都会涌向同一个
`onText`，无法区分 sessionId。所以每次请求用当前 sessionId 重新构建这条装饰链。
`createOpenAICompatible` 的开销可以忽略；真正贵的（embedding 索引、MCP 子进程）留在 App 级。

**并发约束**：Main 进程同一时刻只跑一个 `runAgent`。请求进来时若已有运行中的任务，
排队或拒绝（前端禁用输入框）。理由：会话文件是「读-改-写」，并发会互相覆盖；
且 DeepSeek 并发请求对个人使用没有收益。这也让 UI 的「思考中」状态语义明确。

### App 级装配（`electron/main/agent-runtime.ts`）

```typescript
// 应用启动时执行一次，把贵的资源建好长驻
import { loadConfig } from '../../src/config'
import { makeEmbedder } from '../../src/rag/embed'
import { buildNotesIndex } from '../../src/rag/index'
import { makeSearchNotesTool } from '../../src/tools/searchNotes'
import { loadMcpToolsFromServers } from '../../src/mcp/client'

export async function createRuntime(config: Config) {
  const embed = await makeEmbedder(config)
  const store = await buildNotesIndex({ notesDir: config.notesDir, embed })

  const mcp = await loadMcpToolsFromServers([
    { command: mcpServerCommand(), args: mcpServerArgs() },  // 打包后路径不同，见下
    { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', config.notesDir] },
  ])

  const searchTool = makeSearchNotesTool({ store, embed })
  const registry = { ...mcp.tools, [searchTool.name]: searchTool }

  return { registry, close: () => mcp.close() }
}
```

### 请求级装配（`electron/main/ipc-handlers.ts`）

```typescript
import { runAgent, type TurnInfo } from '../../src/agent'
import { makeCallModel } from '../../src/llm'
import { withRetry, withFallback } from '../../src/resilience'
import { createDiskCache, withCache } from '../../src/cache'
import { createJsonSessionStore } from '../../src/memory/store'
import { makeSummarizer } from '../../src/memory/summarize'
import { compactMessages } from '../../src/memory/compact'

ipcMain.handle('send-message', async (_e, sessionId: string, userInput: string) => {
  const config = loadConfig(mergedEnv())          // 用户设置覆盖 process.env，见「用户设置」
  const sessions = createJsonSessionStore(config.sessionsDir)
  const history = await sessions.load(sessionId)

  // 流式回调绑定到本次请求的 sessionId
  const onText = (delta: string) =>
    mainWindow.webContents.send('message-chunk', { sessionId, text: delta, isComplete: false })

  // 和 cli.ts 完全相同的装饰链：withRetry → withCache → withFallback
  const cache = config.cacheEnabled ? createDiskCache(config.cacheDir) : undefined
  const build = (model: string) => {
    let cm = withRetry(makeCallModel({ ...config, model }, runtime.registry, onText),
                       { retries: config.maxRetries })
    if (cache) cm = withCache(cm, cache, model,
      () => mainWindow.webContents.send('cache-hit', { sessionId }))
    return cm
  }
  const primary = build(config.model)
  const callModel = config.fallbackModel === config.model
    ? primary
    : withFallback(primary, build(config.fallbackModel), () => {})

  const summarize = makeSummarizer(makeCallModel(config, {}))

  const answer = await runAgent(userInput, {
    callModel,
    tools: runtime.registry,
    config,
    history,
    compact: (messages) => compactMessages(messages, {
      maxTokens: config.maxContextTokens,
      keepRecent: config.keepRecent,
      summarize,
    }),
    onComplete: (messages) =>
      sessions.save(sessionId, messages.filter((m) => m.role !== 'system')),
    onTurn: (info: TurnInfo) => {
      for (const t of info.toolResults) {
        mainWindow.webContents.send('tool-call', {
          sessionId, turn: info.turn, toolName: t.name, args: t.args, output: t.output,
        })
      }
    },
  })

  mainWindow.webContents.send('message-complete', { sessionId, text: answer })
})
```

注意这段代码调用的都是 `src/` 里**已存在的真实导出**：`createJsonSessionStore(dir)` 返回
`{ load, save }`，`compactMessages(messages, opts)`，`loadMcpToolsFromServers(servers)`——
和 `cli.ts` 用的是同一套 API，没有为桌面端新增任何 `src/` 代码。

### MCP Server 的打包问题（必须解决）

`cli.ts` 用 `npx tsx mcp-server.ts` 启动自建 server。**打包后的 Electron 应用里这条命令会失败**：
用户机器上不一定有 `npx`，`tsx` 是 devDependency 不会被打进包，`mcp-server.ts` 也是未编译的 TS。

正确做法是用 Electron 自带的 Node 运行编译后的 JS：`process.execPath` + 环境变量
`ELECTRON_RUN_AS_NODE=1`（让 Electron 二进制以纯 Node 模式执行脚本）。

**但这里撞上了零修改约束**：`connectMcp(opts: { command, args })` 只传了 command 和 args，
没有 env 字段；MCP SDK 的 `StdioClientTransport` 在未指定 env 时使用内置安全名单
（PATH / HOME 等），`ELECTRON_RUN_AS_NODE` 不在名单里，传不进子进程。

**解法：用现有的依赖注入接缝，不改 `src/`。**
`loadMcpToolsFromServers(servers, connect = connectMcp)` 的第二个参数允许注入自定义连接器
（原本是为测试留的）。桌面端传一个带 env 的版本即可：

```typescript
// electron/main/mcp-connect.ts —— 复刻 connectMcp，只多传一个 env
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpConnection } from '../../src/mcp/client'

export async function connectMcpWithEnv(opts: {
  command: string; args: string[]; env?: Record<string, string>
}): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env: { ...process.env as Record<string, string>, ...opts.env },
  })
  const client = new Client({ name: 'smallest-agent-desktop', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}
```

```typescript
// 装配时注入
const mcp = await loadMcpToolsFromServers(mcpServers(), connectMcpWithEnv)
```

代价是 6 行代码重复，换来 `src/` 一行不动——这正是那个 `connect` 参数存在的意义。
（`servers` 数组的元素类型是 `{ command, args }`，多带一个 `env` 字段在 TS 上需要
类型断言或让注入函数自己按 command 判断是否加 env，实现时二选一。）

**开发 / 生产两套启动参数**（`electron/main/mcp-paths.ts`）：

| | 自建 mcp-server | filesystem server |
|---|---|---|
| 开发 | `npx tsx mcp-server.ts` | `npx -y @modelcontextprotocol/server-filesystem <dir>` |
| 生产 | `process.execPath` + `resourcesPath/mcp-server.js`，`ELECTRON_RUN_AS_NODE=1` | 仍走 `npx`（不打包），失败即跳过 |

**filesystem server 降级为可选**：它依赖 `npx` 联网拉包，打包环境不可靠。
启动时尝试连接，失败则跳过，UI 标注「文件系统工具不可用」，不阻塞应用启动。
自建 mcp-server 是必需的（`get_weather` + Skills 都在里面），必须走上面的编译方案。

**连带影响**：`loadMcpToolsFromServers(servers)` 对传入的 server 数组是「全成功或全失败」，
无法让其中一个可选。所以要调用两次——必需的自建 server 一次、可选的 fs server 一次
（包在 try 里），再合并两个 registry。`close()` 需要同时关掉两个连接。

### 会话文件管理

继续使用 `createJsonSessionStore` 读写 JSON 文件，零修改。两点调整：
- **存储路径**：CLI 用相对路径 `.sessions/`；打包后应用目录只读，改用
  `app.getPath('userData')/sessions`。通过 `loadConfig` 的 env 注入 `SESSIONS_DIR` 实现，不改代码。
- **会话列表**：`SessionStore` 接口只有 `load`/`save`，没有 `list`。
  `listSessions()` 在 Main 进程直接 `readdir` 会话目录实现，属于 Electron 层的新代码，不动 `src/`。
  会话标题取该会话第一条 user 消息的前 30 字符。

### RAG / Embedding

`transformers.js` 在 Main 进程（Node.js 环境）直接运行，与 CLI 一致：
- 模型缓存目录同样指向 `app.getPath('userData')`
- `buildNotesIndex` 在 App 级装配时执行一次，索引常驻内存
- `notes/` 目录路径由用户在设置中指定（对应 `NOTES_DIR`）

## 开发工具链

### 技术栈

- **Main**: TypeScript（由 electron-vite 用 esbuild 打包，生产不依赖 tsx）
- **Renderer**: React + Vite + TypeScript
- **构建**: electron-vite（Main / Preload / Renderer 三段构建 + 热重载）
- **打包**: electron-builder

版本一律装当前最新稳定版（`pnpm add -D electron electron-builder electron-vite react react-dom @vitejs/plugin-react`），
不在文档里钉死版本号——现有项目已经在用 AI SDK v6、Zod v4 这些较新的版本，保持一致。

### package.json 脚本

```json
{
  "scripts": {
    "dev": "tsx cli.ts",                    // 原 CLI
    "dev:electron": "electron-vite dev",    // 开发 Electron
    "build:electron": "electron-vite build",
    "package:mac": "electron-builder --mac",
    "package:win": "electron-builder --win",
    "package:linux": "electron-builder --linux"
  }
}
```

### electron-builder 配置

```json
{
  "build": {
    "appId": "com.smallest-agent.app",
    "productName": "Smallest Agent",
    "files": [
      "out/**/*",              // electron-vite 产物（main + preload + renderer）
      "skills/**/*",           // skills markdown，运行时读取
      "!node_modules/tsx/**"   // 生产不需要 tsx
    ],
    "extraResources": [
      { "from": "out/mcp-server.js", "to": "mcp-server.js" }  // 编译后的 MCP server
    ],
    "mac": { "target": ["dmg", "zip"] },
    "win": { "target": ["nsis", "portable"] }
  }
}
```

`src/` 的代码由 electron-vite 打包进 main bundle（因为 main 直接 import 它们），
不需要单独列在 `files` 里。`@huggingface/transformers` 含原生依赖，需在
`asarUnpack` 中排除以保证能正常加载——打包阶段实测确认。

### 新增依赖

```
devDependencies:  electron, electron-builder, electron-vite,
                  react, react-dom, @vitejs/plugin-react, vite,
                  @types/react, @types/react-dom
dependencies:     electron-store          # 设置持久化，运行时需要
                  react-markdown + shiki  # Markdown 渲染 + 代码高亮（Renderer 打包进 bundle，
                                          # 放 dev 也可，按 electron-vite 惯例即可）
```

现有的 `ai` / `@ai-sdk/openai-compatible` / `@huggingface/transformers` /
`@modelcontextprotocol/sdk` / `zod` / `dotenv` 全部保持在 `dependencies`，Main 进程运行时要用。

### 开发流程

1. **开发 CLI**: `pnpm dev "问题"`（现有流程不变）
2. **开发 Electron**: `pnpm dev:electron`
   - Main 进程修改自动重启
   - Renderer 修改热重载
3. **打包**: `pnpm package:mac` 生成 `.dmg`

### 调试支持

- Main 进程：`--inspect` 端口（VSCode attach）
- Renderer 进程：Chrome DevTools
- 保留所有 trace 日志输出到终端

## 错误处理与用户体验

### 错误处理

**Main 进程错误**：
- Agent 运行错误（模型 API 失败、工具失败、`maxTurns` 耗尽）通过 `error` 事件推送，带错误码
- 会话文件读写失败：本轮对话保留在前端内存，提示「会话未能保存」，不中断当前对话
- 自建 MCP server 启动失败：**阻塞式提示**（核心工具都在里面），显示重试按钮
- filesystem MCP server 失败：静默降级，设置面板标注「文件系统工具不可用」

**Renderer 进程错误**：
- IPC 调用失败：toast 提示
- Main 进程崩溃：Electron 会重启窗口，前端重新拉会话历史恢复

**用户友好提示**：
```
API_KEY_MISSING: "请在设置中配置 DeepSeek API Key"
MODEL_ERROR:     "模型调用失败，请检查网络或 API 配额"
MAX_TURNS:       "Agent 反复调用工具未能收敛，已停止（可在设置中调大 maxTurns）"
BUSY:            "上一个问题还在处理中，请稍候"
```
工具执行失败不算顶层错误——`runTool` 把异常包成 `{"error": "..."}` 返回给模型，
UI 在对应的工具卡片里把它标红显示，模型自己决定重试或换路径。

### 加载状态

**首次启动**：
- 启动画面消费 `runtime-status` 事件，逐阶段显示：
  「正在加载 embedding 模型…」→「正在索引笔记（N 个片段）」→「正在连接 MCP 工具…」→ 就绪
- 首次运行需从 HuggingFace 下载 embedding 模型，可能耗时数十秒，必须有明确进度提示
- 装配未完成时输入框禁用

**Agent 思考中**：
- 输入框禁用
- 工具调用卡片实时插入消息流（`tool-call` 事件到达即渲染）
- 缓存命中时显示「🟢 缓存命中」标记（`cache-hit` 事件）

**流式输出**：
- 打字机效果，光标闪烁
- `message-complete` 到达时用完整文本替换累积的 delta，保证最终一致
- 若有工具证据，末尾追加核查结果徽章（✅ 有证据支撑 / ⚠️ 存疑 + issues 列表）

### 用户设置

设置面板（⚙️）配置：
- DeepSeek API Key / Base URL / Model / Fallback Model
- Notes 目录路径（RAG 数据源）
- 流式开关、缓存开关、最大重试次数
- Token 预算（`MAX_CONTEXT_TOKENS`）、保留最近轮数（`KEEP_RECENT`）

**实现方式**：`loadConfig(env: NodeJS.ProcessEnv = process.env)` 已经接受 env 参数，
所以设置面板不需要改 `src/config.ts`——把用户设置转成 env 形状后合并即可：

```typescript
const mergedEnv = () => ({
  ...process.env,
  ...settingsStore.get('env'),           // { DEEPSEEK_API_KEY: '...', NOTES_DIR: '...' }
  SESSIONS_DIR: join(app.getPath('userData'), 'sessions'),
  LLM_CACHE_DIR: join(app.getPath('userData'), 'llm-cache'),
})
const config = loadConfig(mergedEnv())
```

设置用 `electron-store` 持久化到 `userData`。API Key 存明文（个人本地工具，
不引入 keytar 等系统钥匙串依赖以免增加跨平台打包复杂度）——README 中注明这一点。

**改 Notes 目录需要重建索引**：保存设置时若 `NOTES_DIR` 变化，重跑 App 级装配的
`buildNotesIndex` 并推 `runtime-status` 事件；其余设置项下次请求自动生效（因为 config 是请求级读取的）。

### 性能优化

- **虚拟滚动**：单会话消息 >100 条时启用
- **工具详情按需渲染**：工具卡片默认折叠，展开时才渲染完整 JSON
- **索引常驻**：`buildNotesIndex` 只在启动（和改 NOTES_DIR）时跑，不随每次提问重建

> 注：不做 embedding 懒加载。索引在启动阶段一次建好、配启动进度画面，
> 比「第一次问笔记问题时卡住几十秒」体验更好，也让 `search_notes` 的响应时间可预期。

### 开源友好

- README 标注 "CLI → Electron" 演进路径
- `electron/` 目录独立 README 讲解架构
- 保留 CLI 入口（两种方式并存）
- 关键文件保持高注释密度

## 实现里程碑

### Phase 1: 基础框架
- 搭建 electron-vite 开发环境（Main + Preload + Renderer 三段构建）
- Main 进程创建窗口，`contextIsolation` + `contextBridge` 跑通
- Preload 暴露一个 ping 方法，验证 IPC 双向可用
- Renderer 基础布局（左右两栏空壳）

### Phase 2: 打通 agent（本阶段最关键）
- `agent-runtime.ts`：App 级装配（embedding → 索引 → MCP），推 `runtime-status`
- `ipc-handlers.ts`：请求级装配 + `runAgent`，跑通一问一答
- 流式 `message-chunk` + `tool-call` 事件推送
- **验收**：桌面端能复现 `pnpm dev "列出我 notes 目录里有哪些文件"` 的完整效果

### Phase 3: 会话与 UI
- 会话列表（readdir 实现 list、创建、删除、切换）
- 消息气泡 + Markdown 渲染 + 代码高亮
- 工具调用卡片（可折叠 JSON）
- 深色主题样式落地

### Phase 4: 生产化
- 错误处理与错误码映射
- 启动进度画面、思考中状态、缓存命中标记
- LLM-as-Judge 核查徽章
- 设置面板（env 合并 + 改 NOTES_DIR 重建索引）
- 长会话虚拟滚动

### Phase 5: 打包发布
- **MCP server 编译方案**（`connectMcpWithEnv` 注入 + `process.execPath` + `ELECTRON_RUN_AS_NODE`）
- transformers.js 原生依赖的 `asarUnpack` 处理
- macOS 打包验证（主力平台），Windows 尽力而为
- README 补「CLI → Electron」演进说明，`electron/` 目录独立文档

风险最高的两项是 **Phase 2 的 App/请求级装配拆分**和 **Phase 5 的 MCP server 打包**，
其余都是常规工作。建议 Phase 2 完成后先自用一段时间再往下做。

## 技术约束

- **完全不修改 `src/` 核心代码**：桌面端只允许新增 `electron/` 下的文件。
  已知唯一的擦边处是 MCP 的 env 传递——用现有的 `connect` 注入参数绕开了（见上文）。
  若再发现某处必须改 `src/`，先停下来讨论——这通常意味着抽象边界没找对。
- Main 进程必须是 Node.js 环境（transformers.js 原生依赖、MCP stdio 子进程）
- 安全隔离：`nodeIntegration: false` + `contextIsolation: true` + `contextBridge`
- 同一时刻只跑一个 `runAgent`（会话文件读-改-写，且个人使用无并发需求）
- 主力平台 macOS；Windows/Linux 打包配置齐备但不作为验收标准
- 现有 `pnpm test`（vitest）必须保持全绿——桌面端不碰 `src/`，所以这一条应当自动成立，
  它同时也是「零修改」约束的回归检查

## 成功标准

1. **功能对等**：CLI 版本的能力（RAG、记忆、压缩、MCP、Skills、缓存、重试降级、
   流式、LLM-as-Judge）在桌面端都能用且可见
2. **代码复用**：`src/` 零修改，桌面端代码全部隔离在 `electron/`
3. **可打包**：`pnpm package:mac` 产出的 `.dmg` 在干净机器上能装能跑（含 MCP 工具）
4. **学习友好**：架构清晰、关键文件注释密度对齐 `src/agent.ts`、文档说明演进路径
5. **开源就绪**：CLI 与桌面端两个入口并存，README 讲清「先读 CLI 再读 Electron」的顺序
