# 桌面版架构

## 一句话

Main 进程 import 现有的 `src/` 跑 agent，Renderer 用 React 画界面，中间靠 IPC 事件推送。**`src/` 一行没改**——这是本目录唯一的硬约束。

## 为什么要拆成两段装配

`cli.ts` 是「装配 → 跑一次 → 退出」。桌面端长驻，所以装配线拆成两段：

### App 级（`main/agent-runtime.ts`，启动时一次）

- embedding 模型（`makeEmbedder`）
- 笔记索引（`buildNotesIndex`）
- MCP 子进程（自建 server + 官方 filesystem server）

这些资源**贵**：embedding 模型要下载权重、笔记索引要全量扫描、MCP 子进程要 fork + IPC。而且它们与「具体问哪个问题」无关——同一套工具、同一份笔记，所有会话共用。启动时建好，长驻内存。

### 请求级（`main/agent-runner.ts`，每条消息一次）

- `callModel` 的装饰链（`buildCallModel`）：`withRetry` → `withCache` → `withFallback`

**为什么 `callModel` 不能只建一次？**

`makeCallModel(config, registry, onText)` 把流式回调 **闭包进了内部**（`src/llm.ts:73-76`）。如果全局只建一个，所有会话的 token 流都会涌向同一个 `onText`，没法按 `sessionId` 路由到正确的窗口。

所以每条请求用当前 `sessionId` 重建这条链——`onText` 绑定本次请求的 `sessionId`，推给正确的前端会话（`agent-runner.ts:109-113`）。

## 为什么串行

同一时刻只跑一个 `runAgent`（`agent-runner.ts:83` 的 `busy` 标志）。

**理由：**

1. **会话文件是读-改-写**：`SessionStore` 的 `save` 是 `readFile` → 修改 → `writeFile`。并发执行时，后写入的会覆盖先写入的历史。
2. **个人使用没有并发收益**：用户同一时刻只在看一个回答，并行跑两个 agent 只会抢 CPU / GPU，反而都变慢。

UI 会显示「哪个会话占着锁」，并提供跳转到该会话的按钮。

## 零修改是怎么做到的

四个接缝，全是现有代码本来就留好的：

### 1. `loadConfig(env)` 接受 env 参数

`src/config.ts` 的 `loadConfig` 签名是 `(env = process.env)`。设置面板把用户输入拼成 env 形状（`main/config-env.ts`），不改 `src/config.ts`：

```typescript
// main/config-env.ts
export function buildEnv(settings: DesktopSettings): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: settings.apiKey ?? '',
    DEEPSEEK_BASE_URL: settings.baseUrl,
    DEEPSEEK_MODEL: settings.model,
    // ...
  }
}
```

### 2. `loadMcpToolsFromServers(servers, connect)` 的第二个参数可注入连接器

`src/mcp/client.ts` 的 `loadMcpToolsFromServers` 接受一个 `connect` 函数。桌面端传一个带 env 的版本（`main/mcp-connect.ts`），解决打包后 `ELECTRON_RUN_AS_NODE` 传不进子进程的问题：

```typescript
// main/mcp-connect.ts
export async function connectMcpWithEnv(spec: McpServerSpec) {
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    // ...
  })
  return connectMcp(child.stdin, child.stdout)
}
```

### 3. `runAgent` 的 `onTurn` / `onComplete` 钩子

直接用来推 IPC 事件和存会话（`agent-runner.ts:124-154`）。`src/agent.ts` 从一开始就预留了这两个钩子。

### 4. `AgentDeps.callModel` 是注入的（取消就靠它）

这个接缝一开始没被算进来，因为它看着只是"为了测试能塞假模型"。但它同时也是**取消的入口**。

`runAgent` 的签名确实不收 `AbortSignal`，所以一度以为桌面版只能继承"跑起来就停不下来"。实际上 ReAct 循环每轮第一件事就是调 `callModel`（`src/agent.ts:53`），而 `runAgent` **不捕获**它的抛错——包一层"进来先查取消令牌，已取消就抛"的装饰器，循环就会在下一轮入口停下，异常一路上抛到 `agent-runner` 的 `catch`：

```typescript
// main/cancel.ts
export function withCancel(inner: CallModel, token: CancelToken): CallModel {
  return async (messages) => {
    token.throwIfCancelled()
    return inner(messages)
  }
}
```

装饰要套在**最外层**（`buildCallModel` 的返回值之外）：套在 `withRetry` 里面，取消会被当成可重试的失败反复退避；套在 `withFallback` 里面，取消会触发"换备用模型"，反而多打一次请求。

### 额外的能力

`SessionStore` 没有 `list` 方法——会话列表是桌面端新增的能力（`main/sessions.ts`），同样没动 `src/`。它扫描 `.sessions/*.json`，按 `mtime` 倒序返回。

## 审批闸口是怎么实现的

写工具（`write_file` / `edit_file` / `create_directory` / `move_file`）执行前必须用户显式确认。但 `src/` 不能改，而 `runAgent` 的工具执行流程是：

```
runAgent → runTool(tools, name, args) → registry[name].run(args)
```

**方案：注册表装饰器**（`main/approval.ts`）。

`guardRegistry(registry, sessionId, gate, emit)` 返回一个新注册表，其中写工具的 `run` 被换成：

```typescript
run: async (args) => {
  const decision = await gate.requestApproval({ sessionId, toolName, args })
  if (decision === 'deny') {
    return { denied: true, reason: `用户拒绝了 ${name} 操作` }
  }
  return originalTool.run(args)
}
```

这个装饰过的注册表传给 `runAgent`，闸口就自动落在 agent 循环内部、工具执行之前，`src/` 一行不动。

**为什么拒绝返回 `{denied: true}` 而不是抛错？**

`runTool` 会把抛错包成 `{"error":...}`，模型容易理解成「工具坏了」而反复重试。明确告诉它是用户拒绝，它才会换路子（`approval.ts:148-153`）。

**超时处理：** 5 分钟后自动按「拒绝」结算（fail-closed）。否则 Renderer 窗口被关掉时，`requestApproval` 的 promise 永不落地，会一路挂住工具循环 → `agent-runner.run()`，而 `busy` 标志只在 `finally` 里清——结果是整个 app 永久性拒绝新消息（`BUSY`），直到重启进程（`approval.ts:42-47`）。

## 测试策略

纯逻辑模块 **不 import `electron`**，`app.getPath()` 之类的值由调用方传参——这样 vitest 能在纯 Node 下直接跑它们（`tests/electron/`，142 个测试）。

只有 `main/index.ts` 和 `main/ipc-handlers.ts` 碰 electron API，它们只做接线，靠手动验收。

## 打包的两个坑

### 1. MCP server 路径

`cli.ts` 用 `npx tsx mcp-server.ts` 启动自建 server，打包后这条命令必然失败：用户机器不一定有 npx，tsx 是 devDependency 不进包，`mcp-server.ts` 也没编译。

**生产环境改用 Electron 自带的 Node 跑编译产物**（`main/mcp-paths.ts`）：

```typescript
{
  command: process.execPath,
  args: [join(resourcesPath, 'mcp-server.js')],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}
```

`ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以纯 Node 模式执行脚本，不再开窗口。

### 2. skills 目录必须和 mcp-server.js 一起打包

`mcp-server.ts` 用 `import.meta.url` 找 `skills/`（`mcp-server.ts:22-23`）：

```typescript
const here = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(here, 'skills')
```

所以打包时 `skills/` 必须和 `mcp-server.js` 一起放进 `resourcesPath`。见 `package.json` 的 `extraResources`：

```json
"extraResources": [
  { "from": "out/main/mcp-server.js", "to": "mcp-server.js" },
  { "from": "skills", "to": "skills" }
]
```

如果这里配错，`list_skills` 会返回空数组，而 `get_weather` 等其他工具仍正常——失败是**静默**的，只能靠「agent 不会调 code-review 技能」这个现象反推。

## 设计系统

UI 移植自 [beautifului.dev](https://beautifului.dev)。token 值从该站生产环境 CSS 提取（它同样用 Tailwind v4，MIT），取其 `.dark` 作用域那一套——本项目 v1 只做深色。

**两个要点**（`electron/renderer/src/styles.css:1-10`）：

1. **颜色按语义命名**（`page` / `canvas` / `surface` / `inset` / `field`），不是层级编号。各有用途：`page` 是窗口底色，`surface` 是抬起的卡片，`inset` 是凹陷区（代码块），`field` 是输入控件。别拿 `surface` 当边框用。

2. **边界用 hairline ring 而不是 border**——`shadow-card` 的第一层是 `0 0 0 1px var(--line)`，叠上柔和投影。用 `shadow-card` / `shadow-hairline`，而不是 `border border-line`。

**字号层级**：全在 13px 及以下（13 / 12.5 / 12 / 11.5 / 11）。`font-medium` 是默认字重，`font-semibold` 只用于标题。这个「小字号 + 中等字重 + 紧凑间距」的组合是精致感的主体（`styles.css:77-85`）。

**控件高度**：统一 `h-7`（28px），配 `rounded-control`（8px）。

**注意**：该站没有发布可复用的组件或授权许可——本项目只采用了其设计模式和实测的尺度 token，代码全部手写。

## 已知限制

- **API Key 存明文**：用 `electron-store` 持久化到 `userData`，不加密。个人本地工具，不引 keytar 以免增加跨平台打包复杂度（`main/settings-store.ts:1-2`）。
- **官方 filesystem server 依赖 npx**：打包环境不可靠（用户机器可能没装 npx、网络可能不通）。连不上就跳过，UI 标注「文件系统工具不可用」，不阻塞启动（`main/agent-runtime.ts:56-66`）。
- **取消只到轮边界**：点停止之后，当前这一轮的模型请求和已经开跑的工具会跑完，到下一轮才停。长工具（shell、网络）下可能等几十秒。要真正打断正在流的请求，得把 `abortSignal` 传给 SDK 的 `streamText` / `generateText`，而 `makeCallModel` 没有这个参数——零修改下只能在 `electron/` 里复制一份带 signal 的版本，连带复制 `toSdkMessages` 那堆逐形状翻译，以后 `src/llm.ts` 改了这边不会跟着变。取舍见 `main/cancel.ts` 的文件头。
- **工具执行中途停不下来**：同上一条的另一面。工具边界的取消要装饰注册表、返回 `{cancelled:true}` 告知模型（不能抛错，`runTool` 会把抛错吃掉包成 `{"error":...}`，模型只会当成"工具坏了"然后重试），而长工具还得自己接 signal 才能真停。
- **一个悬着的审批会挡住所有会话**：串行锁不分会话，所以会话 A 的写操作等你确认时，会话 B 也发不出消息，最长 5 分钟（超时自动拒绝）。UI 会说明是谁占着锁并提供跳转按钮，但这仍然是个真实的阻塞。现在多了一条出路：去那个会话点停止（取消会连带把它名下悬着的审批结算掉）。

## 文件清单

```
electron/
├── main/                     主进程（Node.js 环境）
│   ├── index.ts             Electron app 入口：创建窗口、启动 runtime
│   ├── ipc-handlers.ts      IPC 接线：把 Renderer 请求路由到 runtime
│   ├── agent-runtime.ts     App 级装配：embedding / 笔记索引 / MCP 子进程
│   ├── agent-runner.ts      请求级装配：callModel 装饰链 + 串行锁
│   ├── approval.ts          审批闸口：注册表装饰器 + 超时
│   ├── cancel.ts            取消令牌：装饰注入的 callModel，在轮边界停下
│   ├── call-model.ts        buildCallModel：retry / cache / fallback 包装
│   ├── config-env.ts        设置 → env 映射（不改 src/config.ts）
│   ├── sessions.ts          会话列表：扫描 .sessions/*.json（不改 src/）
│   ├── settings-store.ts    持久化设置到 userData（明文）
│   ├── mcp-connect.ts       MCP 连接器：注入 env（不改 src/mcp/）
│   ├── mcp-paths.ts         开发 vs 打包环境的 MCP server 路径
│   └── preload.ts           暴露 IPC 到 Renderer（contextBridge）
├── renderer/                 前端（React + Vite）
│   ├── src/
│   │   ├── App.tsx          根组件：Sidebar + ChatView + Settings
│   │   ├── components/      UI 组件（ChatMessage / Sidebar / Settings ...）
│   │   ├── hooks/           useSettings / useSessions
│   │   ├── styles.css       设计系统 token + 全局样式
│   │   └── main.tsx         React 入口
│   └── index.html           CSP: default-src 'self'
└── shared/
    └── channels.ts          IPC 事件类型定义（Main ↔ Renderer 契约）
```

## 相关文件

- 根目录 [`README.md`](../README.md)：完整的 Stage 0-5 学习地图
- [`cli.ts`](../cli.ts)：CLI 版本（**建议先读这个**，再回来看桌面版如何拆分）
- [`src/agent.ts`](../src/agent.ts)：agent 循环本体（CLI 和桌面版共用）
