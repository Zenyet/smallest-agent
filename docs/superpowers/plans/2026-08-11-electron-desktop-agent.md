# Electron 桌面版 Agent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完全不修改 `src/` 的前提下，用 Electron 把现有 CLI agent 包装成带聊天界面的桌面应用。

**Architecture:** Main 进程（Node.js 环境）直接 import 现有 `src/` 代码，分成「App 级装配」（embedding 索引 + MCP 子进程，启动一次长驻）和「请求级装配」（callModel 装饰链，每条消息重建，因为流式回调必须绑定当前 sessionId）。Renderer 进程用 React 渲染聊天界面，两者通过 contextBridge 暴露的 `window.electronAPI` 做 IPC，Main 用事件主动推送流式文本和工具调用。

**Tech Stack:** Electron + electron-vite（esbuild 三段构建）+ React + TypeScript + vitest + electron-builder

**Spec:** `docs/superpowers/specs/2026-08-11-electron-desktop-agent-design.md`

## Global Constraints

- **`src/` 一行不改**，`cli.ts`、`mcp-server.ts`、`tests/` 现有文件同样不改。所有新代码进 `electron/`。若某任务看起来必须改 `src/`，停下来问，不要自行修改。
- **纯逻辑模块禁止 `import ... from 'electron'`**。`app.getPath()` 之类的值由调用方以参数传入。原因：vitest 跑在纯 Node 下，import electron 会直接失败。只有 `electron/main/index.ts` 和 `electron/main/ipc-handlers.ts` 允许 import electron。
- **`pnpm test` 必须全绿**（现有 22 个测试文件 + 新增的）。这既是回归检查，也是「零修改」约束的验证——`src/` 没动，旧测试就不该红。
- **`pnpm typecheck` 必须通过**。
- **提交策略**：每个任务末尾有 commit 步骤，但按本项目规则，**除非用户在对话中明确说了「提交/commit」，否则不要执行 `git commit`**，把改动留在工作区并报告即可。真要提交时用显式路径 `git add <file>...`，禁止 `git add -A`/`git add .`。
- **worktree 隔离**：执行本计划前先建独立 worktree（`git worktree add ../smallest-agent-electron -b feat/electron-desktop`），不要在主工作区切分支。
- **串行执行**：同一时刻只允许一个 `runAgent` 在跑。
- **安全隔离**：`nodeIntegration: false` + `contextIsolation: true`，Renderer 只能通过 `window.electronAPI` 访问 Main。
- **v1 只做深色主题**，颜色全部走 CSS 变量。
- 主力平台 macOS。Windows/Linux 配置写全但不作为验收标准。

## 文件结构

新增文件及其职责（`src/` 完全不出现在这个列表里）：

| 文件 | 职责 | 可单测 |
|---|---|---|
| `electron.vite.config.ts` | 三段构建配置（main / preload / renderer） | 否 |
| `electron/shared/channels.ts` | IPC 频道名常量 + 事件类型定义，Main 和 Renderer 共用 | 是 |
| `electron/main/config-env.ts` | 用户设置 → env 对象的合并（喂给 `loadConfig`） | 是 |
| `electron/main/mcp-paths.ts` | 开发/生产两套 MCP server 启动参数 | 是 |
| `electron/main/mcp-connect.ts` | 带 env 的 MCP 连接器（注入给 `loadMcpToolsFromServers`） | 部分 |
| `electron/main/agent-runtime.ts` | App 级装配：embedding → 索引 → MCP → 合并 registry | 是 |
| `electron/main/errors.ts` | 异常 → ErrorEvent 错误码映射 | 是 |
| `electron/main/call-model.ts` | 请求级 callModel 装饰链（retry/cache/fallback） | 否 |
| `electron/main/agent-runner.ts` | 请求级装配 + `runAgent` 调用 + 串行锁 + 事件发射 | 是 |
| `electron/main/sessions.ts` | 会话列表/新建/删除/标题（`SessionStore` 没有 list） | 是 |
| `electron/main/settings-store.ts` | electron-store 读写设置 | 否 |
| `electron/main/ipc-handlers.ts` | 把上面这些接到 ipcMain 上 | 否 |
| `electron/main/index.ts` | 创建窗口、启动装配、生命周期 | 否 |
| `electron/main/preload.ts` | contextBridge 暴露 `window.electronAPI` | 否 |
| `electron/renderer/src/chat-reducer.ts` | 前端事件累积成消息列表（纯 reducer） | 是 |
| `electron/renderer/src/api.ts` | `window.electronAPI` 的类型安全封装 | 否 |
| `electron/renderer/src/App.tsx` | 布局 + 全局状态 | 是 |
| `electron/renderer/src/components/*.tsx` | SessionList / ChatWindow / MessageBubble / ToolCallIndicator / StartupScreen / SettingsPanel | 是 |
| `electron/renderer/src/styles.css` | 深色主题 CSS 变量 | 否 |

测试放 `tests/electron/`，沿用现有 vitest 风格（`describe`/`it`/`expect` + 注入假实现，不用 mock 框架）。

---

### Task 1: 脚手架 —— electron-vite 三段构建 + 能打开的空窗口

**Files:**
- Create: `electron.vite.config.ts`
- Create: `electron/main/index.ts`
- Create: `electron/main/preload.ts`
- Create: `electron/renderer/index.html`
- Create: `electron/renderer/src/main.tsx`
- Create: `electron/renderer/src/App.tsx`
- Modify: `package.json`（scripts + main 字段 + 新依赖）
- Modify: `tsconfig.json`（include 加 electron，compilerOptions 加 jsx / DOM lib）
- Modify: `.gitignore`（加 `out/`、`dist-electron/`）

**Interfaces:**
- Consumes: 无
- Produces: `pnpm dev:electron` 能打开一个显示「Smallest Agent」的窗口；构建产物路径 `out/main/index.js`、`out/preload/preload.cjs`、`out/renderer/`

- [ ] **Step 1: 安装依赖**

```bash
pnpm add -D electron electron-vite electron-builder vite @vitejs/plugin-react react react-dom @types/react @types/react-dom jsdom @testing-library/react
pnpm add electron-store react-markdown shiki
```

- [ ] **Step 2: 写 electron-vite 配置**

`electron.vite.config.ts`：

```ts
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = import.meta.dirname

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 两个入口：主进程，以及编译后的 mcp-server（打包时要用，见 Task 18）
        input: {
          index: resolve(root, 'electron/main/index.ts'),
          'mcp-server': resolve(root, 'mcp-server.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(root, 'electron/main/preload.ts'),
        // preload 在 contextIsolation 下必须是 CJS，显式指定扩展名避免 type:module 干扰
        output: { format: 'cjs', entryFileNames: 'preload.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'electron/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(root, 'electron/renderer/index.html') },
    },
  },
})
```

- [ ] **Step 3: 写主进程入口**

`electron/main/index.ts`：

```ts
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

// ESM 主进程没有 __dirname，用 import.meta.url 还原（和 mcp-server.ts 同样的手法）
const here = dirname(fileURLToPath(import.meta.url))

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    backgroundColor: '#05070C',
    webPreferences: {
      preload: join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 开发时连 vite dev server（热重载），生产时加载构建产物
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(here, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 4: 写 preload 占位**

`electron/main/preload.ts`：

```ts
import { contextBridge } from 'electron'

// Task 2 会把真正的 API 挂上来，这里先证明 contextBridge 链路通了
contextBridge.exposeInMainWorld('electronAPI', {})
```

- [ ] **Step 5: 写 renderer 骨架**

`electron/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>Smallest Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`electron/renderer/src/main.tsx`：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`electron/renderer/src/App.tsx`：

```tsx
export function App() {
  return <h1>Smallest Agent</h1>
}
```

- [ ] **Step 6: 改 package.json**

加 `"main": "out/main/index.js"`，scripts 里加：

```json
"dev:electron": "electron-vite dev",
"build:electron": "electron-vite build",
"preview:electron": "electron-vite preview"
```

保留原有的 `dev` / `eval` / `test` / `typecheck` 不动。

- [ ] **Step 7: 改 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "cli.ts", "tests", "electron", "electron.vite.config.ts"]
}
```

- [ ] **Step 8: .gitignore 加构建产物**

在末尾追加两行：

```
out
dist-electron
```

- [ ] **Step 9: 验证窗口能打开**

Run: `pnpm dev:electron`
Expected: 弹出窗口显示「Smallest Agent」，DevTools 控制台无报错。

> 如果主进程报 ESM 相关加载错误（`Cannot use import statement outside a module` 之类），
> 说明 Electron 版本对 ESM 主进程的支持需要调整：把 `electron.vite.config.ts` 里 main 的
> `build.rollupOptions.output.format` 显式设为 `'es'`，并确认 `package.json` 的 `main` 字段
> 指向实际产物文件名（`ls out/main/` 看一眼）。

- [ ] **Step 10: 验证旧测试没被影响**

Run: `pnpm test && pnpm typecheck`
Expected: 全部通过。

- [ ] **Step 11: Commit**

```bash
git add electron.vite.config.ts electron/ package.json pnpm-lock.yaml tsconfig.json .gitignore
git commit -m "feat(electron): scaffold electron-vite three-part build with empty window"
```

---

### Task 2: IPC 频道契约 + preload 打通双向通信

**Files:**
- Create: `electron/shared/channels.ts`
- Modify: `electron/main/preload.ts`
- Modify: `electron/main/index.ts`（临时挂一个 ping handler）
- Modify: `electron/renderer/src/App.tsx`（临时调 ping）
- Test: `tests/electron/channels.test.ts`

**Interfaces:**
- Consumes: Task 1 的窗口
- Produces:
  - `CH` 常量对象：`CH.listSessions`/`CH.createSession`/`CH.deleteSession`/`CH.loadSession`/`CH.sendMessage`/`CH.getSettings`/`CH.saveSettings`/`CH.ping`（invoke 类）与 `CH.messageChunk`/`CH.toolCall`/`CH.messageComplete`/`CH.verdict`/`CH.cacheHit`/`CH.error`/`CH.runtimeStatus`（推送类）
  - 事件类型：`MessageChunkEvent`、`ToolCallEvent`、`MessageCompleteEvent`、`VerdictEvent`、`CacheHitEvent`、`ErrorEvent`、`ErrorCode`、`RuntimeStatusEvent`、`SessionMeta`
  - `window.electronAPI.ping(): Promise<'pong'>`

- [ ] **Step 1: 写失败的测试**

`tests/electron/channels.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { CH } from '../../electron/shared/channels'

describe('CH', () => {
  it('每个频道名都唯一（避免复制粘贴时写重导致事件串台）', () => {
    const names = Object.values(CH)
    expect(new Set(names).size).toBe(names.length)
  })

  it('频道名统一带 agent: 前缀，避免和 Electron 内置事件冲突', () => {
    for (const name of Object.values(CH)) {
      expect(name.startsWith('agent:')).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/channels.test.ts`
Expected: FAIL —— 找不到模块 `electron/shared/channels`

- [ ] **Step 3: 写 channels.ts**

```ts
// IPC 频道名 + 事件负载类型。Main 和 Renderer 共用这一份定义，
// 改频道名时两边一起编译报错，比字符串字面量分散在各处安全。
import type { Message } from '../../src/types'

export const CH = {
  // Renderer → Main（invoke，有返回值）
  ping: 'agent:ping',
  listSessions: 'agent:list-sessions',
  createSession: 'agent:create-session',
  deleteSession: 'agent:delete-session',
  loadSession: 'agent:load-session',
  sendMessage: 'agent:send-message',
  getSettings: 'agent:get-settings',
  saveSettings: 'agent:save-settings',
  // Main → Renderer（send，单向推送）
  messageChunk: 'agent:message-chunk',
  toolCall: 'agent:tool-call',
  messageComplete: 'agent:message-complete',
  verdict: 'agent:verdict',
  cacheHit: 'agent:cache-hit',
  error: 'agent:error',
  runtimeStatus: 'agent:runtime-status',
} as const

export interface MessageChunkEvent {
  sessionId: string
  text: string // 增量 delta，不是全量
}

export interface ToolCallEvent {
  sessionId: string
  turn: number
  toolName: string
  args: Record<string, unknown>
  output: string // runTool 返回的 JSON 字符串；工具失败时形如 {"error":"..."}
}

export interface MessageCompleteEvent {
  sessionId: string
  text: string // 完整答案，前端用它替换累积的 delta，保证最终一致
}

export interface VerdictEvent {
  sessionId: string
  grounded: boolean
  issues: string[]
}

export interface CacheHitEvent {
  sessionId: string
}

// 没有 TOOL_ERROR：runTool 把工具异常包成 JSON 返回给模型，不会中断循环，
// 因此工具失败以 ToolCallEvent.output 的形式展示，不走这里。
export type ErrorCode = 'API_KEY_MISSING' | 'MODEL_ERROR' | 'MAX_TURNS' | 'BUSY' | 'UNKNOWN'

export interface ErrorEvent {
  sessionId: string
  code: ErrorCode
  message: string
}

export interface RuntimeStatusEvent {
  phase: 'embedding' | 'indexing' | 'mcp' | 'ready' | 'failed'
  detail: string
}

export interface SessionMeta {
  id: string
  title: string
  updatedAt: number
}

export type { Message }
```

> **Task 8.5 会往这份契约里追加审批相关的频道和类型**（`approvalRequest` / `approvalResponse`
> 与 `ApprovalRequestEvent` / `ApprovalDecision`）。本任务先不写它们——等 8.5 需要时再加，
> 保持每个任务的改动可独立评审。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/channels.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: preload 暴露 ping**

`electron/main/preload.ts` 整体替换：

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/channels'

// contextBridge 只能传可结构化克隆的值，函数不能直接过桥，
// 所以事件订阅要在这一层包成「注册回调 + 返回取消函数」的形式。
const api = {
  ping: (): Promise<'pong'> => ipcRenderer.invoke(CH.ping),
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
```

- [ ] **Step 6: 主进程加临时 ping handler**

在 `electron/main/index.ts` 的 import 区加：

```ts
import { ipcMain } from 'electron'
import { CH } from '../shared/channels'
```

在 `app.whenReady().then(...)` 回调里、`createWindow()` 之前加：

```ts
ipcMain.handle(CH.ping, () => 'pong')
```

- [ ] **Step 7: Renderer 调 ping**

`electron/renderer/src/App.tsx`：

```tsx
import { useEffect, useState } from 'react'

export function App() {
  const [pong, setPong] = useState<string>('...')
  useEffect(() => {
    // @ts-expect-error Task 3 之后会给 window.electronAPI 补类型声明
    window.electronAPI.ping().then(setPong)
  }, [])
  return (
    <div>
      <h1>Smallest Agent</h1>
      <p>IPC: {pong}</p>
    </div>
  )
}
```

- [ ] **Step 8: 手动验证双向通信**

Run: `pnpm dev:electron`
Expected: 窗口显示「IPC: pong」。若显示 `...` 或控制台报 `electronAPI is undefined`，说明 preload 路径不对——检查 `out/preload/` 下的实际文件名与 `index.ts` 里的 `join(here, '../preload/preload.cjs')` 是否一致。

- [ ] **Step 9: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 10: Commit**

```bash
git add electron/shared/channels.ts electron/main/preload.ts electron/main/index.ts electron/renderer/src/App.tsx tests/electron/channels.test.ts
git commit -m "feat(electron): add IPC channel contract and verify contextBridge round-trip"
```

---

### Task 3: 用户设置 → env 合并

**Files:**
- Create: `electron/main/config-env.ts`
- Test: `tests/electron/config-env.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `interface DesktopSettings`（全部字段可选的字符串）
  - `interface UserPaths { sessionsDir: string; cacheDir: string }`
  - `buildEnv(base: NodeJS.ProcessEnv, settings: DesktopSettings, paths: UserPaths): NodeJS.ProcessEnv`
  - `SETTING_KEYS: readonly (keyof DesktopSettings)[]`

- [ ] **Step 1: 写失败的测试**

`tests/electron/config-env.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildEnv } from '../../electron/main/config-env'
import { loadConfig } from '../../src/config'

const paths = { sessionsDir: '/data/sessions', cacheDir: '/data/cache' }

describe('buildEnv', () => {
  it('用户设置覆盖 process.env', () => {
    const env = buildEnv({ DEEPSEEK_MODEL: 'from-env' }, { DEEPSEEK_MODEL: 'from-settings' }, paths)
    expect(env.DEEPSEEK_MODEL).toBe('from-settings')
  })

  it('保留未被设置覆盖的 base 变量（PATH 之类子进程要用）', () => {
    const env = buildEnv({ PATH: '/usr/bin' }, {}, paths)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('忽略空字符串设置项，避免把 NOTES_DIR 覆盖成空值', () => {
    const env = buildEnv({ NOTES_DIR: '/real/notes' }, { NOTES_DIR: '' }, paths)
    expect(env.NOTES_DIR).toBe('/real/notes')
  })

  it('目录由 paths 强制指定，用户设置改不了', () => {
    const env = buildEnv({}, { SESSIONS_DIR: '/hacked' } as never, paths)
    expect(env.SESSIONS_DIR).toBe('/data/sessions')
    expect(env.LLM_CACHE_DIR).toBe('/data/cache')
  })

  it('产物能直接喂给 loadConfig（这是它唯一的用途）', () => {
    const env = buildEnv({}, { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-chat' }, paths)
    const config = loadConfig(env)
    expect(config.apiKey).toBe('k')
    expect(config.sessionsDir).toBe('/data/sessions')
    expect(config.cacheDir).toBe('/data/cache')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/config-env.test.ts`
Expected: FAIL —— 找不到模块 `electron/main/config-env`

- [ ] **Step 3: 实现**

`electron/main/config-env.ts`：

```ts
// 桌面端的设置面板不需要改 src/config.ts —— loadConfig(env) 本来就接受 env 参数，
// 所以这里只负责把「用户在 UI 里填的东西」拼成 env 形状交给它。
// 这是「零修改复用」的关键接缝之一。

export interface DesktopSettings {
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  DEEPSEEK_MODEL?: string
  FALLBACK_MODEL?: string
  NOTES_DIR?: string
  EMBEDDING_MODEL?: string
  HF_ENDPOINT?: string
  STREAM?: string
  LLM_CACHE?: string
  MAX_RETRIES?: string
  MAX_TURNS?: string
  MAX_CONTEXT_TOKENS?: string
  KEEP_RECENT?: string
}

// 设置面板要渲染哪些字段，由这份清单驱动（Task 15 用）
export const SETTING_KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'FALLBACK_MODEL',
  'NOTES_DIR',
  'EMBEDDING_MODEL',
  'HF_ENDPOINT',
  'STREAM',
  'LLM_CACHE',
  'MAX_RETRIES',
  'MAX_TURNS',
  'MAX_CONTEXT_TOKENS',
  'KEEP_RECENT',
] as const satisfies readonly (keyof DesktopSettings)[]

// 目录不走用户设置：打包后应用目录只读，必须落在 userData 下。
export interface UserPaths {
  sessionsDir: string
  cacheDir: string
}

export function buildEnv(
  base: NodeJS.ProcessEnv,
  settings: DesktopSettings,
  paths: UserPaths,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of SETTING_KEYS) {
    const value = settings[key]
    // 空串/undefined 一律跳过：否则会把 loadConfig 里的默认值覆盖成空，
    // 例如 NOTES_DIR='' 会让 RAG 去读根目录。
    if (value === undefined || value === '') continue
    env[key] = value
  }
  // 放在最后写，确保用户设置里就算混进了同名 key 也覆盖不掉
  env.SESSIONS_DIR = paths.sessionsDir
  env.LLM_CACHE_DIR = paths.cacheDir
  return env
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/config-env.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/main/config-env.ts tests/electron/config-env.test.ts
git commit -m "feat(electron): merge desktop settings into env for loadConfig"
```

---

### Task 4: MCP server 启动参数（开发 / 生产两套）

**Files:**
- Create: `electron/main/mcp-paths.ts`
- Test: `tests/electron/mcp-paths.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `interface McpServerSpec { command: string; args: string[]; env?: Record<string, string> }`
  - `interface McpPathsInput { isDev: boolean; execPath: string; resourcesPath: string; projectRoot: string; notesDir: string }`
  - `ownServerSpec(input: McpPathsInput): McpServerSpec`
  - `fsServerSpec(input: McpPathsInput): McpServerSpec`

- [ ] **Step 1: 写失败的测试**

`tests/electron/mcp-paths.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { ownServerSpec, fsServerSpec } from '../../electron/main/mcp-paths'

const dev = {
  isDev: true,
  execPath: '/Applications/App.app/Contents/MacOS/App',
  resourcesPath: '/Applications/App.app/Contents/Resources',
  projectRoot: '/repo',
  notesDir: '/repo/notes',
}
const prod = { ...dev, isDev: false }

describe('ownServerSpec', () => {
  it('开发环境走 npx tsx 跑未编译的 TS', () => {
    const spec = ownServerSpec(dev)
    expect(spec.command).toBe('npx')
    expect(spec.args).toEqual(['tsx', '/repo/mcp-server.ts'])
  })

  it('生产环境用 Electron 自带的 Node 跑编译产物', () => {
    const spec = ownServerSpec(prod)
    expect(spec.command).toBe(prod.execPath)
    expect(spec.args).toEqual(['/Applications/App.app/Contents/Resources/mcp-server.js'])
  })

  it('生产环境必须带 ELECTRON_RUN_AS_NODE，否则子进程会当成 Electron 应用再启一个窗口', () => {
    expect(ownServerSpec(prod).env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('开发环境不需要那个变量', () => {
    expect(ownServerSpec(dev).env).toBeUndefined()
  })
})

describe('fsServerSpec', () => {
  it('两种环境都走 npx（官方 server 不打包，失败则降级跳过）', () => {
    for (const input of [dev, prod]) {
      const spec = fsServerSpec(input)
      expect(spec.command).toBe('npx')
      expect(spec.args).toEqual([
        '-y',
        '@modelcontextprotocol/server-filesystem',
        input.notesDir,
      ])
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/mcp-paths.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

`electron/main/mcp-paths.ts`：

```ts
// cli.ts 用 `npx tsx mcp-server.ts` 启动自建 server，打包后这条命令必然失败：
// 用户机器不一定有 npx，tsx 是 devDependency 不进包，mcp-server.ts 也没编译。
// 生产环境改用 Electron 自带的 Node 跑编译产物 —— process.execPath 就是 Electron 二进制，
// 设 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式执行脚本，不再开窗口。
import { join } from 'node:path'

export interface McpServerSpec {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpPathsInput {
  isDev: boolean
  execPath: string // process.execPath
  resourcesPath: string // process.resourcesPath（生产）
  projectRoot: string // 仓库根目录（开发）
  notesDir: string
}

export function ownServerSpec(input: McpPathsInput): McpServerSpec {
  if (input.isDev) {
    return { command: 'npx', args: ['tsx', join(input.projectRoot, 'mcp-server.ts')] }
  }
  return {
    command: input.execPath,
    args: [join(input.resourcesPath, 'mcp-server.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

// 官方 filesystem server 依赖 npx 联网拉包，打包环境不可靠 ——
// 所以它是可选的：连不上就跳过，UI 标注「文件系统工具不可用」，不阻塞启动。
export function fsServerSpec(input: McpPathsInput): McpServerSpec {
  return {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', input.notesDir],
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/mcp-paths.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/main/mcp-paths.ts tests/electron/mcp-paths.test.ts
git commit -m "feat(electron): resolve MCP server launch specs for dev and packaged builds"
```

---

### Task 5: 带 env 的 MCP 连接器

**Files:**
- Create: `electron/main/mcp-connect.ts`
- Test: `tests/electron/mcp-connect.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `McpServerSpec`；`src/mcp/client.ts` 的 `McpConnection` 类型
- Produces:
  - `transportOptions(spec: McpServerSpec, baseEnv: NodeJS.ProcessEnv): { command: string; args: string[]; env: Record<string, string> }`
  - `connectMcpWithEnv(spec: { command: string; args: string[] }): Promise<McpConnection>`

**背景**：`connectMcp` 的签名是 `{ command, args }`，没有 env 字段；MCP SDK 的 `StdioClientTransport` 在未指定 env 时只透传一份内置安全名单（PATH/HOME 等），`ELECTRON_RUN_AS_NODE` 不在名单里。而 `loadMcpToolsFromServers(servers, connect = connectMcp)` 的第二个参数允许注入自定义连接器——用它就能绕开，`src/` 一行不改。

- [ ] **Step 1: 写失败的测试**

`tests/electron/mcp-connect.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { transportOptions } from '../../electron/main/mcp-connect'

describe('transportOptions', () => {
  it('把 spec.env 合并进去（ELECTRON_RUN_AS_NODE 必须真的传给子进程）', () => {
    const opts = transportOptions(
      { command: '/bin/electron', args: ['server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      { PATH: '/usr/bin' },
    )
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('保留 base env（子进程要靠 PATH 找到 npx）', () => {
    const opts = transportOptions({ command: 'npx', args: ['tsx'] }, { PATH: '/usr/bin' })
    expect(opts.env.PATH).toBe('/usr/bin')
  })

  it('过滤掉 undefined 值，因为 spawn 的 env 只接受字符串', () => {
    const opts = transportOptions({ command: 'npx', args: [] }, { A: 'a', B: undefined })
    expect(opts.env).toEqual({ A: 'a' })
    expect('B' in opts.env).toBe(false)
  })

  it('原样透传 command 和 args', () => {
    const opts = transportOptions({ command: 'npx', args: ['-y', 'pkg', '/dir'] }, {})
    expect(opts.command).toBe('npx')
    expect(opts.args).toEqual(['-y', 'pkg', '/dir'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/mcp-connect.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

`electron/main/mcp-connect.ts`：

```ts
// connectMcp（src/mcp/client.ts）只传 command + args，没有 env 字段，
// 而生产环境启动自建 MCP server 必须带上 ELECTRON_RUN_AS_NODE=1。
// loadMcpToolsFromServers 的第二个参数（原本是留给测试的注入点）正好能用来换掉连接器，
// 所以这里复刻一份带 env 的版本 —— 代价是 6 行重复，换来 src/ 一行不改。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpConnection } from '../../src/mcp/client'
import type { McpServerSpec } from './mcp-paths'

// 抽成纯函数是为了能单测 env 合并逻辑 —— 真正 new Transport 的那步没法在单测里跑。
export function transportOptions(
  spec: McpServerSpec,
  baseEnv: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, spec.env ?? {})
  return { command: spec.command, args: spec.args, env }
}

export async function connectMcpWithEnv(spec: McpServerSpec): Promise<McpConnection> {
  const transport = new StdioClientTransport(transportOptions(spec, process.env))
  const client = new Client({ name: 'smallest-agent-desktop', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/mcp-connect.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/main/mcp-connect.ts tests/electron/mcp-connect.test.ts
git commit -m "feat(electron): add env-aware MCP connector via existing injection seam"
```

---

### Task 6: App 级装配（agent-runtime）

**Files:**
- Create: `electron/main/agent-runtime.ts`
- Test: `tests/electron/agent-runtime.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `McpServerSpec`、Task 5 的 `connectMcpWithEnv`、Task 2 的 `RuntimeStatusEvent`
- Produces:
  - `interface AgentRuntime { registry: ToolRegistry; fsToolsAvailable: boolean; close(): Promise<void> }`
  - `interface RuntimeDeps`（可注入的四个函数，测试塞假实现）
  - `createRuntime(config: Config, specs: { own: McpServerSpec; fs: McpServerSpec }, onStatus: (e: RuntimeStatusEvent) => void, deps?: Partial<RuntimeDeps>): Promise<AgentRuntime>`

**背景**：`loadMcpToolsFromServers` 对传入的数组是「全成功或全失败」，没法让其中一个可选。所以必需的自建 server 调一次，可选的 fs server 单独调一次并包在 try 里，最后合并 registry。

- [ ] **Step 1: 写失败的测试**

`tests/electron/agent-runtime.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../electron/main/agent-runtime'
import { loadConfig } from '../../src/config'
import type { RuntimeStatusEvent } from '../../electron/shared/channels'
import type { Tool, ToolRegistry } from '../../src/types'

const config = loadConfig({ DEEPSEEK_API_KEY: 'k', NOTES_DIR: '/notes' })
const specs = {
  own: { command: 'own', args: [] },
  fs: { command: 'fs', args: [] },
}

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  parameters: {},
  run: async () => name,
})

// 默认的假依赖：不碰网络、不起子进程
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    makeEmbedder: async () => async (texts: string[]) => texts.map(() => [1, 0]),
    buildNotesIndex: async () => ({ size: 3, search: () => [] }) as never,
    makeSearchNotesTool: () => fakeTool('search_notes'),
    loadMcpToolsFromServers: async (servers: { command: string }[]) => {
      const name = servers[0].command === 'own' ? 'get_weather' : 'read_file'
      return { tools: { [name]: fakeTool(name) } as ToolRegistry, close: async () => {} }
    },
    ...overrides,
  }
}

describe('createRuntime', () => {
  it('按 embedding → indexing → mcp → ready 的顺序播报进度', async () => {
    const phases: RuntimeStatusEvent['phase'][] = []
    await createRuntime(config, specs, (e) => phases.push(e.phase), makeDeps())
    expect(phases).toEqual(['embedding', 'indexing', 'mcp', 'ready'])
  })

  it('合并本地 search_notes 和两个 MCP server 的工具', async () => {
    const rt = await createRuntime(config, specs, () => {}, makeDeps())
    expect(Object.keys(rt.registry).sort()).toEqual(['get_weather', 'read_file', 'search_notes'])
  })

  it('fs server 连不上时降级：不抛错，其余工具照常可用', async () => {
    const deps = makeDeps({
      loadMcpToolsFromServers: async (servers: { command: string }[]) => {
        if (servers[0].command === 'fs') throw new Error('npx not found')
        return { tools: { get_weather: fakeTool('get_weather') }, close: async () => {} }
      },
    })
    const rt = await createRuntime(config, specs, () => {}, deps)
    expect(rt.fsToolsAvailable).toBe(false)
    expect(Object.keys(rt.registry).sort()).toEqual(['get_weather', 'search_notes'])
  })

  it('fs server 正常时标记为可用', async () => {
    const rt = await createRuntime(config, specs, () => {}, makeDeps())
    expect(rt.fsToolsAvailable).toBe(true)
  })

  it('自建 server 连不上是致命错误：抛出并播报 failed', async () => {
    const phases: RuntimeStatusEvent['phase'][] = []
    const deps = makeDeps({
      loadMcpToolsFromServers: async (servers: { command: string }[]) => {
        if (servers[0].command === 'own') throw new Error('boom')
        return { tools: {}, close: async () => {} }
      },
    })
    await expect(
      createRuntime(config, specs, (e) => phases.push(e.phase), deps),
    ).rejects.toThrow('boom')
    expect(phases.at(-1)).toBe('failed')
  })

  it('close 会关掉所有已建立的 MCP 连接', async () => {
    const closed: string[] = []
    const deps = makeDeps({
      loadMcpToolsFromServers: async (servers: { command: string }[]) => ({
        tools: {},
        close: async () => {
          closed.push(servers[0].command)
        },
      }),
    })
    const rt = await createRuntime(config, specs, () => {}, deps)
    await rt.close()
    expect(closed.sort()).toEqual(['fs', 'own'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/agent-runtime.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

`electron/main/agent-runtime.ts`：

```ts
// App 级装配：把「贵」的资源建好长驻。
// cli.ts 是「装配 → 跑一次 → 退出」，桌面端长驻，所以装配线要拆两段：
//   这里（启动一次）：embedding 模型、笔记索引、MCP 子进程
//   agent-runner（每条消息一次）：callModel 装饰链 —— 因为流式回调要绑当前 sessionId
import { makeEmbedder as realMakeEmbedder } from '../../src/rag/embed'
import { buildNotesIndex as realBuildNotesIndex } from '../../src/rag/index'
import { makeSearchNotesTool as realMakeSearchNotesTool } from '../../src/tools/searchNotes'
import { loadMcpToolsFromServers as realLoadMcpToolsFromServers } from '../../src/mcp/client'
import { connectMcpWithEnv } from './mcp-connect'
import type { McpServerSpec } from './mcp-paths'
import type { RuntimeStatusEvent } from '../shared/channels'
import type { Config, ToolRegistry } from '../../src/types'

export interface AgentRuntime {
  registry: ToolRegistry
  fsToolsAvailable: boolean
  close(): Promise<void>
}

// 全部做成可注入的：测试里塞假实现，就不用真的下载模型 / 起子进程。
export interface RuntimeDeps {
  makeEmbedder: typeof realMakeEmbedder
  buildNotesIndex: typeof realBuildNotesIndex
  makeSearchNotesTool: typeof realMakeSearchNotesTool
  loadMcpToolsFromServers: typeof realLoadMcpToolsFromServers
}

const defaultDeps: RuntimeDeps = {
  makeEmbedder: realMakeEmbedder,
  buildNotesIndex: realBuildNotesIndex,
  makeSearchNotesTool: realMakeSearchNotesTool,
  loadMcpToolsFromServers: realLoadMcpToolsFromServers,
}

export async function createRuntime(
  config: Config,
  specs: { own: McpServerSpec; fs: McpServerSpec },
  onStatus: (event: RuntimeStatusEvent) => void,
  deps: Partial<RuntimeDeps> = {},
): Promise<AgentRuntime> {
  const d = { ...defaultDeps, ...deps }
  const closers: (() => Promise<void>)[] = []

  try {
    onStatus({ phase: 'embedding', detail: '正在加载 embedding 模型…' })
    const embed = await d.makeEmbedder(config)

    onStatus({ phase: 'indexing', detail: '正在索引笔记…' })
    const store = await d.buildNotesIndex({ notesDir: config.notesDir, embed })

    onStatus({ phase: 'mcp', detail: '正在连接 MCP 工具…' })
    // 自建 server 是必需的（get_weather + Skills 都在里面），失败即致命
    const own = await d.loadMcpToolsFromServers([specs.own], connectMcpWithEnv)
    closers.push(own.close)

    // fs server 依赖 npx 联网拉包，打包环境不可靠 —— 失败就跳过，不阻塞启动
    let fsTools: ToolRegistry = {}
    let fsToolsAvailable = false
    try {
      const fs = await d.loadMcpToolsFromServers([specs.fs], connectMcpWithEnv)
      closers.push(fs.close)
      fsTools = fs.tools
      fsToolsAvailable = true
    } catch {
      fsToolsAvailable = false
    }

    const searchTool = d.makeSearchNotesTool({ store, embed })
    const registry: ToolRegistry = {
      ...own.tools,
      ...fsTools,
      [searchTool.name]: searchTool,
    }

    onStatus({ phase: 'ready', detail: `就绪（${Object.keys(registry).length} 个工具）` })

    return {
      registry,
      fsToolsAvailable,
      close: async () => {
        for (const close of closers) await close()
      },
    }
  } catch (err) {
    // 已经建好的连接要关掉，否则子进程会挂着不退出
    for (const close of closers) await close().catch(() => {})
    onStatus({
      phase: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/agent-runtime.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/main/agent-runtime.ts tests/electron/agent-runtime.test.ts
git commit -m "feat(electron): app-level runtime assembly with optional fs MCP degradation"
```

---

### Task 7: 错误码映射

**Files:**
- Create: `electron/main/errors.ts`
- Test: `tests/electron/errors.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ErrorEvent` / `ErrorCode`
- Produces: `toErrorEvent(sessionId: string, err: unknown): ErrorEvent`

- [ ] **Step 1: 写失败的测试**

`tests/electron/errors.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { toErrorEvent } from '../../electron/main/errors'

describe('toErrorEvent', () => {
  it('缺 API key（loadConfig 抛的原话）', () => {
    const e = toErrorEvent('s1', new Error('Missing DEEPSEEK_API_KEY（把 .env.example 复制成 .env 并填好）'))
    expect(e.code).toBe('API_KEY_MISSING')
    expect(e.sessionId).toBe('s1')
  })

  it('转满上限（agent.ts 抛的原话）', () => {
    const e = toErrorEvent('s1', new Error('Agent exceeded maxTurns (10) without finishing'))
    expect(e.code).toBe('MAX_TURNS')
  })

  it('HTTP 状态码类错误归为模型调用失败', () => {
    expect(toErrorEvent('s1', new Error('429 Too Many Requests')).code).toBe('MODEL_ERROR')
    expect(toErrorEvent('s1', new Error('fetch failed')).code).toBe('MODEL_ERROR')
  })

  it('认不出来的归 UNKNOWN，但消息原样保留', () => {
    const e = toErrorEvent('s1', new Error('something weird'))
    expect(e.code).toBe('UNKNOWN')
    expect(e.message).toBe('something weird')
  })

  it('非 Error 抛出物也能处理', () => {
    expect(toErrorEvent('s1', 'plain string').message).toBe('plain string')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/errors.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

`electron/main/errors.ts`：

```ts
// 把 Main 进程里抛出的各种异常翻译成前端能展示的错误码。
// 注意这里没有 TOOL_ERROR —— runTool 把工具异常包成 JSON 返回给模型
// （src/tools/index.ts），工具失败不会抛到这里，而是作为工具卡片的内容展示。
import type { ErrorCode, ErrorEvent } from '../shared/channels'

// 按「消息里出现什么关键字」判断错误类型。顺序有意义：先匹配具体的，再兜底。
const RULES: { code: ErrorCode; test: RegExp }[] = [
  { code: 'API_KEY_MISSING', test: /DEEPSEEK_API_KEY/i },
  { code: 'MAX_TURNS', test: /exceeded maxTurns/i },
  { code: 'MODEL_ERROR', test: /\b(4\d{2}|5\d{2})\b|fetch failed|timeout|ECONNREFUSED|ENOTFOUND/i },
]

export function toErrorEvent(sessionId: string, err: unknown): ErrorEvent {
  const message = err instanceof Error ? err.message : String(err)
  const rule = RULES.find((r) => r.test.test(message))
  return { sessionId, code: rule?.code ?? 'UNKNOWN', message }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/errors.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/main/errors.ts tests/electron/errors.test.ts
git commit -m "feat(electron): map runtime exceptions to user-facing error codes"
```

---

### Task 8: 请求级装配 + 串行锁（agent-runner）

**Files:**
- Create: `electron/main/call-model.ts`
- Create: `electron/main/agent-runner.ts`
- Test: `tests/electron/agent-runner.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `AgentRuntime`、Task 7 的 `toErrorEvent`、Task 2 的事件类型
- Produces:
  - `buildCallModel(config: Config, registry: ToolRegistry, onText: (d: string) => void, onCacheHit: () => void): CallModel`
  - `interface AgentEmitter { chunk; toolCall; complete; verdict; cacheHit; error }`
  - `interface RunnerDeps { loadConfig; makeSessionStore; buildCallModel; makeSummarize; verify; runAgent; registry; emit }`
  - `createAgentRunner(deps: RunnerDeps): { run(sessionId: string, input: string): Promise<void>; isBusy(): boolean }`

- [ ] **Step 1: 先写 call-model.ts（装饰链，和 cli.ts 同一套顺序）**

`electron/main/call-model.ts`：

```ts
// 请求级装配的一半：把 callModel 逐层包上 retry / cache / fallback。
// 顺序和 cli.ts 完全一致 —— withRetry 在最内层（先重试），withCache 包住它
// （命中缓存就完全不进重试逻辑），withFallback 在最外层（主模型整体失败才切备用）。
//
// 为什么这层必须是「请求级」而不是启动时建一次：makeCallModel 把 onText 闭包进去了，
// 全局只建一个的话，所有会话的 token 流会涌向同一个回调，没法按 sessionId 路由。
import { makeCallModel } from '../../src/llm'
import { withRetry, withFallback } from '../../src/resilience'
import { createDiskCache, withCache } from '../../src/cache'
import type { CallModel, Config, ToolRegistry } from '../../src/types'

export function buildCallModel(
  config: Config,
  registry: ToolRegistry,
  onText: (delta: string) => void,
  onCacheHit: () => void,
): CallModel {
  const cache = config.cacheEnabled ? createDiskCache(config.cacheDir) : undefined

  const build = (model: string): CallModel => {
    let cm: CallModel = withRetry(
      makeCallModel({ ...config, model }, registry, config.stream ? onText : undefined),
      { retries: config.maxRetries },
    )
    if (cache) cm = withCache(cm, cache, model, onCacheHit)
    return cm
  }

  const primary = build(config.model)
  // 主备相同就不必套 withFallback，省一层 try/catch
  return config.fallbackModel === config.model
    ? primary
    : withFallback(primary, build(config.fallbackModel), () => {})
}
```

- [ ] **Step 2: 写失败的测试**

`tests/electron/agent-runner.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createAgentRunner, type RunnerDeps } from '../../electron/main/agent-runner'
import { loadConfig } from '../../src/config'
import type { Message } from '../../src/types'

const config = loadConfig({ DEEPSEEK_API_KEY: 'k' })

// 收集所有发出的事件，断言用
function makeEmitter() {
  const events: { type: string; payload: unknown }[] = []
  const record = (type: string) => (payload: unknown) => events.push({ type, payload })
  return {
    events,
    emit: {
      chunk: record('chunk'),
      toolCall: record('toolCall'),
      complete: record('complete'),
      verdict: record('verdict'),
      cacheHit: record('cacheHit'),
      error: record('error'),
    },
  }
}

function makeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const { emit } = makeEmitter()
  const saved: { id: string; messages: Message[] }[] = []
  return {
    loadConfig: () => config,
    makeSessionStore: () => ({
      load: async () => [],
      save: async (id, messages) => {
        saved.push({ id, messages })
      },
    }),
    buildCallModel: () => async () => ({ text: '', toolCalls: [] }),
    makeSummarize: () => async () => 'summary',
    verify: async () => ({ grounded: true, issues: [] }),
    runAgent: async (input, agentDeps) => {
      agentDeps.onTurn?.({
        turn: 1,
        result: { text: '', toolCalls: [] },
        toolResults: [{ name: 'get_weather', args: { city: '北京' }, output: '{"t":25}' }],
      })
      await agentDeps.onComplete?.([
        { role: 'system', content: 'sys' },
        { role: 'user', content: input },
        { role: 'assistant', content: '答案' },
      ])
      return '答案'
    },
    registry: {},
    emit,
    ...overrides,
  }
}

describe('createAgentRunner', () => {
  it('跑完发出 complete 事件，带完整答案', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(makeDeps({ emit }))
    await runner.run('s1', '天气')
    expect(events.filter((e) => e.type === 'complete')).toEqual([
      { type: 'complete', payload: { sessionId: 's1', text: '答案' } },
    ])
  })

  it('每个工具结果发一个 toolCall 事件', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(makeDeps({ emit }))
    await runner.run('s1', '天气')
    const calls = events.filter((e) => e.type === 'toolCall')
    expect(calls).toHaveLength(1)
    expect(calls[0].payload).toMatchObject({ sessionId: 's1', turn: 1, toolName: 'get_weather' })
  })

  it('有工具证据时做 LLM-as-Judge 核查并发 verdict', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(makeDeps({ emit }))
    await runner.run('s1', '天气')
    expect(events.some((e) => e.type === 'verdict')).toBe(true)
  })

  it('没有工具证据时不做核查（纯聊天没必要花这次调用）', async () => {
    const { events, emit } = makeEmitter()
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async (_input, agentDeps) => {
          agentDeps.onTurn?.({ turn: 1, result: { text: 'hi', toolCalls: [] }, toolResults: [] })
          return 'hi'
        },
      }),
    )
    await runner.run('s1', '你好')
    expect(events.some((e) => e.type === 'verdict')).toBe(false)
  })

  it('存会话时过滤掉 system 消息（system prompt 由 config 决定，不进历史）', async () => {
    const saved: Message[][] = []
    const runner = createAgentRunner(
      makeDeps({
        makeSessionStore: () => ({
          load: async () => [],
          save: async (_id, messages) => {
            saved.push(messages)
          },
        }),
      }),
    )
    await runner.run('s1', '天气')
    expect(saved[0].some((m) => m.role === 'system')).toBe(false)
    expect(saved[0]).toHaveLength(2)
  })

  it('串行锁：已有任务在跑时再 run，发 BUSY 错误且不启动第二次', async () => {
    const { events, emit } = makeEmitter()
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async () => {
          started++
          await gate
          return 'done'
        },
      }),
    )
    const first = runner.run('s1', 'a')
    await runner.run('s2', 'b') // 第二次应立刻被拒
    expect(started).toBe(1)
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({
      sessionId: 's2',
      code: 'BUSY',
    })
    release()
    await first
  })

  it('runAgent 抛错时发映射后的错误码，并释放锁', async () => {
    const { events, emit } = makeEmitter()
    let calls = 0
    const runner = createAgentRunner(
      makeDeps({
        emit,
        runAgent: async () => {
          calls++
          if (calls === 1) throw new Error('Agent exceeded maxTurns (10) without finishing')
          return 'ok'
        },
      }),
    )
    await runner.run('s1', 'a')
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({ code: 'MAX_TURNS' })
    expect(runner.isBusy()).toBe(false)
    await runner.run('s1', 'b') // 锁已释放，能再跑
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/agent-runner.test.ts`
Expected: FAIL —— 找不到模块 `electron/main/agent-runner`

- [ ] **Step 4: 实现**

`electron/main/agent-runner.ts`：

```ts
// 请求级装配 + 串行锁。每条消息走一次这里。
// 串行的理由：会话文件是「读-改-写」，并发会互相覆盖；个人使用也没有并发收益。
import { runAgent as realRunAgent, type TurnInfo } from '../../src/agent'
import { makeCallModel } from '../../src/llm'
import { createJsonSessionStore } from '../../src/memory/store'
import { makeSummarizer } from '../../src/memory/summarize'
import { compactMessages, type Summarize } from '../../src/memory/compact'
import { makeVerifier, type Verdict, type VerifyInput } from '../../src/verify'
import { loadConfig as realLoadConfig } from '../../src/config'
import { buildCallModel as realBuildCallModel } from './call-model'
import { toErrorEvent } from './errors'
import type { SessionStore } from '../../src/memory/store'
import type { CallModel, Config, Message, ToolRegistry } from '../../src/types'
import type {
  CacheHitEvent,
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  ToolCallEvent,
  VerdictEvent,
} from '../shared/channels'

export interface AgentEmitter {
  chunk: (e: MessageChunkEvent) => void
  toolCall: (e: ToolCallEvent) => void
  complete: (e: MessageCompleteEvent) => void
  verdict: (e: VerdictEvent) => void
  cacheHit: (e: CacheHitEvent) => void
  error: (e: ErrorEvent) => void
}

export interface RunnerDeps {
  loadConfig: () => Config
  makeSessionStore: (dir: string) => SessionStore
  buildCallModel: (
    config: Config,
    registry: ToolRegistry,
    onText: (d: string) => void,
    onCacheHit: () => void,
  ) => CallModel
  makeSummarize: (config: Config) => Summarize
  verify: (config: Config, input: VerifyInput) => Promise<Verdict>
  runAgent: typeof realRunAgent
  registry: ToolRegistry
  emit: AgentEmitter
}

export interface AgentRunner {
  run(sessionId: string, input: string): Promise<void>
  isBusy(): boolean
}

export function makeDefaultRunnerDeps(
  registry: ToolRegistry,
  emit: AgentEmitter,
  loadConfig: () => Config = realLoadConfig,
): RunnerDeps {
  return {
    loadConfig,
    makeSessionStore: createJsonSessionStore,
    buildCallModel: realBuildCallModel,
    makeSummarize: (config) => makeSummarizer(makeCallModel(config, {})),
    verify: (config, input) => makeVerifier(makeCallModel(config, {}))(input),
    runAgent: realRunAgent,
    registry,
    emit,
  }
}

export function createAgentRunner(deps: RunnerDeps): AgentRunner {
  let busy = false

  return {
    isBusy: () => busy,

    async run(sessionId, input) {
      if (busy) {
        deps.emit.error({ sessionId, code: 'BUSY', message: '上一个问题还在处理中，请稍候' })
        return
      }
      busy = true
      try {
        const config = deps.loadConfig()
        const sessions = deps.makeSessionStore(config.sessionsDir)
        const history = await sessions.load(sessionId)

        // 流式回调绑定本次请求的 sessionId —— 这就是 callModel 必须请求级重建的原因
        const callModel = deps.buildCallModel(
          config,
          deps.registry,
          (text) => deps.emit.chunk({ sessionId, text }),
          () => deps.emit.cacheHit({ sessionId }),
        )

        const summarize = deps.makeSummarize(config)
        const evidence: string[] = []

        const answer = await deps.runAgent(input, {
          callModel,
          tools: deps.registry,
          config,
          history,
          compact: (messages: Message[]) =>
            compactMessages(messages, {
              maxTokens: config.maxContextTokens,
              keepRecent: config.keepRecent,
              summarize,
            }),
          // system prompt 由 config 决定，不需要进历史文件
          onComplete: (messages: Message[]) =>
            sessions.save(sessionId, messages.filter((m) => m.role !== 'system')),
          onTurn: (info: TurnInfo) => {
            for (const t of info.toolResults) {
              evidence.push(`${t.name}: ${t.output}`)
              deps.emit.toolCall({
                sessionId,
                turn: info.turn,
                toolName: t.name,
                args: t.args,
                output: t.output,
              })
            }
          },
        })

        deps.emit.complete({ sessionId, text: answer })

        // 只在真的调过工具时核查：纯聊天没有证据可比对，白花一次模型调用
        if (evidence.length > 0) {
          const verdict = await deps.verify(config, { question: input, answer, evidence })
          deps.emit.verdict({ sessionId, ...verdict })
        }
      } catch (err) {
        deps.emit.error(toErrorEvent(sessionId, err))
      } finally {
        busy = false
      }
    },
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/agent-runner.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 6: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add electron/main/call-model.ts electron/main/agent-runner.ts tests/electron/agent-runner.test.ts
git commit -m "feat(electron): per-request agent runner with serial lock and event emission"
```

---

### Task 9: 接线 —— 桌面端第一次真的跑通 agent

**Files:**
- Create: `electron/main/settings-store.ts`
- Create: `electron/main/ipc-handlers.ts`
- Modify: `electron/main/index.ts`
- Modify: `electron/main/preload.ts`
- Modify: `electron/renderer/src/App.tsx`（临时的单会话输入框）

**Interfaces:**
- Consumes: Task 3–8 的全部模块
- Produces:
  - `window.electronAPI.sendMessage(sessionId, message)` 真的能驱动 agent
  - `window.electronAPI.onMessageChunk / onToolCall / onMessageComplete / onError / onRuntimeStatus` 可订阅
  - 本任务固定用 `sessionId = 'default'`，多会话在 Task 10–13 加

**验收基准**：桌面端能复现 `pnpm dev "列出我 notes 目录里有哪些文件"` 的完整效果。

- [ ] **Step 1: 写 settings-store.ts**

```ts
// electron-store 把设置持久化到 userData。
// API Key 存明文 —— 个人本地工具，不引 keytar 以免增加跨平台打包复杂度（README 里注明）。
import Store from 'electron-store'
import type { DesktopSettings } from './config-env'

const store = new Store<{ settings: DesktopSettings }>({ defaults: { settings: {} } })

export function getSettings(): DesktopSettings {
  return store.get('settings')
}

export function saveSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const next = { ...store.get('settings'), ...patch }
  store.set('settings', next)
  return next
}
```

- [ ] **Step 2: 写 ipc-handlers.ts**

```ts
// 唯一允许 import electron 的两个文件之一（另一个是 index.ts）。
// 这里只做「接线」：把纯模块拼起来挂到 ipcMain 上，不放业务逻辑 ——
// 业务逻辑都在能被 vitest 直接测的纯模块里。
import { ipcMain, type BrowserWindow } from 'electron'
import { CH } from '../shared/channels'
import { buildEnv } from './config-env'
import { getSettings, saveSettings } from './settings-store'
import { createAgentRunner, makeDefaultRunnerDeps, type AgentEmitter } from './agent-runner'
import { loadConfig } from '../../src/config'
import type { AgentRuntime } from './agent-runtime'
import type { UserPaths } from './config-env'

export function setupIpcHandlers(
  win: BrowserWindow,
  runtime: AgentRuntime,
  paths: UserPaths,
): void {
  const send = (channel: string) => (payload: unknown) => {
    // 窗口可能已被关闭，发送前检查，避免 "Object has been destroyed"
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const emit: AgentEmitter = {
    chunk: send(CH.messageChunk),
    toolCall: send(CH.toolCall),
    complete: send(CH.messageComplete),
    verdict: send(CH.verdict),
    cacheHit: send(CH.cacheHit),
    error: send(CH.error),
  }

  const readConfig = () => loadConfig(buildEnv(process.env, getSettings(), paths))
  const runner = createAgentRunner(makeDefaultRunnerDeps(runtime.registry, emit, readConfig))

  ipcMain.handle(CH.sendMessage, (_e, sessionId: string, message: string) =>
    runner.run(sessionId, message),
  )
  ipcMain.handle(CH.getSettings, () => getSettings())
  ipcMain.handle(CH.saveSettings, (_e, patch) => saveSettings(patch))
}
```

- [ ] **Step 3: preload 补全 API**

`electron/main/preload.ts` 整体替换：

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '../shared/channels'
import type {
  DesktopSettingsLike,
  ErrorEvent,
  MessageChunkEvent,
  MessageCompleteEvent,
  RuntimeStatusEvent,
  ToolCallEvent,
  VerdictEvent,
  CacheHitEvent,
} from '../shared/channels'

// 事件订阅统一包成「注册回调 → 返回取消函数」，React 的 useEffect 直接 return 它就能清理。
function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, data: T) => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ping: (): Promise<'pong'> => ipcRenderer.invoke(CH.ping),
  sendMessage: (sessionId: string, message: string): Promise<void> =>
    ipcRenderer.invoke(CH.sendMessage, sessionId, message),
  getSettings: (): Promise<Record<string, string>> => ipcRenderer.invoke(CH.getSettings),
  saveSettings: (patch: Record<string, string>): Promise<Record<string, string>> =>
    ipcRenderer.invoke(CH.saveSettings, patch),

  onMessageChunk: (cb: (d: MessageChunkEvent) => void) => subscribe(CH.messageChunk, cb),
  onToolCall: (cb: (d: ToolCallEvent) => void) => subscribe(CH.toolCall, cb),
  onMessageComplete: (cb: (d: MessageCompleteEvent) => void) => subscribe(CH.messageComplete, cb),
  onVerdict: (cb: (d: VerdictEvent) => void) => subscribe(CH.verdict, cb),
  onCacheHit: (cb: (d: CacheHitEvent) => void) => subscribe(CH.cacheHit, cb),
  onError: (cb: (d: ErrorEvent) => void) => subscribe(CH.error, cb),
  onRuntimeStatus: (cb: (d: RuntimeStatusEvent) => void) => subscribe(CH.runtimeStatus, cb),
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
```

> 注：`DesktopSettingsLike` 若不需要就从 import 里删掉，别留未使用的导入（`strict` 下不报错但会被 lint 挑出来）。

- [ ] **Step 4: 给 Renderer 补 window 类型声明**

`electron/renderer/src/env.d.ts`：

```ts
import type { ElectronAPI } from '../../main/preload'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
```

- [ ] **Step 5: index.ts 做启动装配**

在 `electron/main/index.ts` 里，把 `app.whenReady()` 部分改成：

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CH } from '../shared/channels'
import { buildEnv } from './config-env'
import { getSettings } from './settings-store'
import { ownServerSpec, fsServerSpec } from './mcp-paths'
import { createRuntime } from './agent-runtime'
import { setupIpcHandlers } from './ipc-handlers'
import { loadConfig } from '../../src/config'

const here = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

app.whenReady().then(async () => {
  ipcMain.handle(CH.ping, () => 'pong')

  const win = createWindow()

  const paths = {
    sessionsDir: join(app.getPath('userData'), 'sessions'),
    cacheDir: join(app.getPath('userData'), 'llm-cache'),
  }
  const config = loadConfig(buildEnv(process.env, getSettings(), paths))

  const pathsInput = {
    isDev,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    projectRoot: join(here, '../..'), // out/main → 仓库根
    notesDir: config.notesDir,
  }

  const runtime = await createRuntime(
    config,
    { own: ownServerSpec(pathsInput), fs: fsServerSpec(pathsInput) },
    (status) => {
      if (!win.isDestroyed()) win.webContents.send(CH.runtimeStatus, status)
    },
  )

  setupIpcHandlers(win, runtime, paths)

  // MCP 是子进程，不关掉的话应用退出后它们会挂着
  app.on('before-quit', () => {
    void runtime.close()
  })
})
```

> `projectRoot` 的相对层数取决于实际产物位置。跑起来后如果开发模式下 MCP server 起不来，
> 先 `console.log(pathsInput.projectRoot)` 确认它指向仓库根（能看到 `mcp-server.ts`）。

- [ ] **Step 6: Renderer 临时界面**

`electron/renderer/src/App.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'

export function App() {
  const [status, setStatus] = useState('启动中…')
  const [log, setLog] = useState<string[]>([])
  const [text, setText] = useState('')
  const answer = useRef('')

  useEffect(() => {
    const offStatus = window.electronAPI.onRuntimeStatus((s) => setStatus(s.detail))
    const offChunk = window.electronAPI.onMessageChunk((c) => {
      answer.current += c.text
      setLog((l) => [...l.slice(0, -1), `🤖 ${answer.current}`])
    })
    const offTool = window.electronAPI.onToolCall((t) =>
      setLog((l) => [...l, `🔧 ${t.toolName}(${JSON.stringify(t.args)}) → ${t.output.slice(0, 120)}`]),
    )
    const offDone = window.electronAPI.onMessageComplete((m) => {
      answer.current = ''
      setLog((l) => [...l, `✅ ${m.text}`])
    })
    const offErr = window.electronAPI.onError((e) => setLog((l) => [...l, `❌ [${e.code}] ${e.message}`]))
    return () => {
      offStatus(); offChunk(); offTool(); offDone(); offErr()
    }
  }, [])

  const send = () => {
    setLog((l) => [...l, `👤 ${text}`, '🤖 '])
    answer.current = ''
    void window.electronAPI.sendMessage('default', text)
    setText('')
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui' }}>
      <p>状态：{status}</p>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{log.join('\n')}</pre>
      <input value={text} onChange={(e) => setText(e.target.value)} style={{ width: '70%' }} />
      <button onClick={send}>发送</button>
    </div>
  )
}
```

- [ ] **Step 7: 配 API Key 并手动验收**

先确保仓库根的 `.env` 里有 `DEEPSEEK_API_KEY`（开发模式下 `process.env` 不会自动读 `.env`——
Electron 主进程没有 `import 'dotenv/config'`）。两个办法二选一：

- 临时用环境变量启动：`DEEPSEEK_API_KEY=sk-xxx pnpm dev:electron`
- 或在 `electron/main/index.ts` 顶部加一行 `import 'dotenv/config'`（dotenv 已是现有依赖，推荐）

Run: `pnpm dev:electron`，在输入框里问「列出我 notes 目录里有哪些文件」

Expected:
1. 状态依次显示「正在加载 embedding 模型…」→「正在索引笔记…」→「正在连接 MCP 工具…」→「就绪（N 个工具）」
2. 消息区出现 `🔧 list_directory(...)` 的工具调用行
3. 答案逐字出现（流式）
4. 最后一行 `✅` 是完整答案

若 fs server 没起来（工具里没有 `list_directory`），改问「北京天气怎么样」验证自建 MCP server 的 `get_weather`。

- [ ] **Step 8: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 9: Commit**

```bash
git add electron/main/settings-store.ts electron/main/ipc-handlers.ts electron/main/index.ts electron/main/preload.ts electron/renderer/src/App.tsx electron/renderer/src/env.d.ts
git commit -m "feat(electron): wire runtime, IPC and renderer so the desktop app runs the agent"
```

---

### Task 10: 会话管理模块

**Files:**
- Create: `electron/main/sessions.ts`
- Test: `tests/electron/sessions.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SessionMeta`；`src/types.ts` 的 `Message`
- Produces:
  - `sessionTitle(messages: Message[]): string`
  - `newSessionId(seed: number): string`
  - `listSessions(dir: string): Promise<SessionMeta[]>`
  - `deleteSession(dir: string, id: string): Promise<void>`

**背景**：`SessionStore` 接口只有 `load`/`save`，没有 `list`。列表能力属于 Electron 层的新代码。`store.ts` 里的 `safeId` 没有导出，删除时要自己做同样的路径穿越防护。

- [ ] **Step 1: 写失败的测试**

`tests/electron/sessions.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions, deleteSession, sessionTitle, newSessionId } from '../../electron/main/sessions'
import type { Message } from '../../src/types'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sessions-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const write = (id: string, messages: Message[]) =>
  writeFile(join(dir, `${id}.json`), JSON.stringify(messages), 'utf8')

describe('sessionTitle', () => {
  it('取第一条 user 消息作标题', () => {
    expect(sessionTitle([
      { role: 'assistant', content: '你好' },
      { role: 'user', content: '北京天气怎么样' },
    ])).toBe('北京天气怎么样')
  })

  it('超长标题截断到 30 字符', () => {
    const long = 'x'.repeat(50)
    expect(sessionTitle([{ role: 'user', content: long }])).toHaveLength(30)
  })

  it('没有 user 消息时给默认名', () => {
    expect(sessionTitle([])).toBe('新会话')
  })

  it('折叠换行，避免标题把列表撑开', () => {
    expect(sessionTitle([{ role: 'user', content: '第一行\n第二行' }])).toBe('第一行 第二行')
  })
})

describe('newSessionId', () => {
  it('只含文件名安全字符（store.ts 的 safeId 会把其他字符换成下划线）', () => {
    expect(newSessionId(1739000000000)).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('不同时间戳产生不同 id', () => {
    expect(newSessionId(1)).not.toBe(newSessionId(2))
  })
})

describe('listSessions', () => {
  it('目录不存在时返回空数组，不抛错（首次启动就是这种情况）', async () => {
    expect(await listSessions(join(dir, 'nope'))).toEqual([])
  })

  it('列出会话并带上标题', async () => {
    await write('s1', [{ role: 'user', content: '问题一' }])
    const list = await listSessions(dir)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 's1', title: '问题一' })
  })

  it('忽略非 .json 文件', async () => {
    await write('s1', [{ role: 'user', content: 'q' }])
    await writeFile(join(dir, 'notes.md'), 'x', 'utf8')
    expect(await listSessions(dir)).toHaveLength(1)
  })

  it('跳过内容损坏的会话文件而不是整个列表报错', async () => {
    await write('good', [{ role: 'user', content: 'q' }])
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
    const list = await listSessions(dir)
    expect(list.map((s) => s.id)).toEqual(['good'])
  })

  it('按最近更新排序，最新的在前', async () => {
    await write('old', [{ role: 'user', content: 'a' }])
    await new Promise((r) => setTimeout(r, 10))
    await write('new', [{ role: 'user', content: 'b' }])
    const list = await listSessions(dir)
    expect(list[0].id).toBe('new')
  })
})

describe('deleteSession', () => {
  it('删掉对应文件', async () => {
    await write('s1', [{ role: 'user', content: 'q' }])
    await deleteSession(dir, 's1')
    expect(existsSync(join(dir, 's1.json'))).toBe(false)
  })

  it('删不存在的会话不报错（前端重复点删除时不该崩）', async () => {
    await expect(deleteSession(dir, 'ghost')).resolves.toBeUndefined()
  })

  it('防路径穿越：id 里的 ../ 不能跳出目录', async () => {
    await writeFile(join(dir, 'outside.json'), '[]', 'utf8')
    await deleteSession(dir, '../outside')
    expect(existsSync(join(dir, 'outside.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/sessions.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

`electron/main/sessions.ts`：

```ts
// SessionStore（src/memory/store.ts）只有 load/save，没有 list ——
// 会话列表是桌面端才需要的能力，所以放在 Electron 层，src/ 不动。
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '../../src/types'
import type { SessionMeta } from '../shared/channels'

const TITLE_MAX = 30

// 和 store.ts 里的 safeId 同样的规则（那个函数没导出，这里复刻一份）：
// 把非安全字符换成下划线，防止 "../../etc/passwd" 这类 id 跳出目录。
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function sessionTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return '新会话'
  // 折叠所有空白（含换行），否则多行输入会把侧边栏撑变形
  const flat = first.content.replace(/\s+/g, ' ').trim()
  return flat.slice(0, TITLE_MAX) || '新会话'
}

export function newSessionId(seed: number): string {
  return `s${seed.toString(36)}`
}

export async function listSessions(dir: string): Promise<SessionMeta[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    // 目录不存在 = 还没有任何会话（首次启动），返回空列表而不是报错
    return []
  }

  const metas: SessionMeta[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const path = join(dir, file)
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const messages = JSON.parse(raw) as Message[]
      metas.push({
        id: file.slice(0, -'.json'.length),
        title: sessionTitle(messages),
        updatedAt: info.mtimeMs,
      })
    } catch {
      // 单个文件坏了就跳过它，不要让整个列表打不开
      continue
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteSession(dir: string, id: string): Promise<void> {
  try {
    await unlink(join(dir, `${safeId(id)}.json`))
  } catch {
    // 文件本来就不在（重复点删除）—— 结果一致，不必报错
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/sessions.test.ts`
Expected: PASS（13 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/main/sessions.ts tests/electron/sessions.test.ts
git commit -m "feat(electron): session listing, titling and deletion"
```

---

### Task 8.5: 写操作审批闸口（Approval Card 的后端）

**背景**：fs MCP server 对 notes 目录有写/删权限（`write_file`、`edit_file`、`create_directory`、
`move_file`）。现在模型想改文件就直接改了，用户事后才知道。参照 beautifului.dev 的
Approval Card 模式：有后果的动作执行前必须显式确认。

**关键约束下的插入点**：`src/` 不能改，而 `runAgent` 直接调 `runTool(tools, name, args)`，
`runTool` 又只是查 `registry[name].run(args)`。所以闸口做成**注册表装饰器**——
把写类工具的 `run` 换成「先请求审批，批了才调原 run」。这样闸口天然落在
agent 循环内部、工具执行之前，`src/` 一行不动。

**Files:**
- Create: `electron/main/approval.ts`
- Modify: `electron/shared/channels.ts`（加两个频道 + 两个类型）
- Test: `tests/electron/approval.test.ts`

**Interfaces:**
- Consumes: `ToolRegistry` / `Tool`（`src/types.ts`）
- Produces:
  - `WRITE_TOOLS: ReadonlySet<string>`
  - `interface ApprovalRequestEvent { sessionId: string; requestId: string; toolName: string; args: Record<string, unknown> }`
  - `type ApprovalDecision = 'allow' | 'deny'`
  - `interface ApprovalGate { requestApproval(e: ApprovalRequestEvent): Promise<ApprovalDecision>; resolve(requestId: string, decision: ApprovalDecision): void; pending(): string[] }`
  - `createApprovalGate(): ApprovalGate`
  - `guardRegistry(registry: ToolRegistry, sessionId: string, gate: ApprovalGate, emit: (e: ApprovalRequestEvent) => void): ToolRegistry`

- [ ] **Step 1: 往 channels.ts 追加契约**

在 `electron/shared/channels.ts` 的 `CH` 对象里加两项：

```ts
  // 审批：Main → Renderer 发请求，Renderer → Main 回决定
  approvalRequest: 'agent:approval-request',
  approvalResponse: 'agent:approval-response',
```

并在文件末尾（`export type { Message }` 之前）加类型：

```ts
// 写类工具执行前的审批请求。requestId 用来把 Renderer 的回答对上是哪一次请求 ——
// 一轮里可能有多个写操作排队等审批。
export interface ApprovalRequestEvent {
  sessionId: string
  requestId: string
  toolName: string
  args: Record<string, unknown>
}

export type ApprovalDecision = 'allow' | 'deny'
```

- [ ] **Step 2: 写失败的测试**

`tests/electron/approval.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { createApprovalGate, guardRegistry, WRITE_TOOLS } from '../../electron/main/approval'
import type { ApprovalRequestEvent } from '../../electron/shared/channels'
import type { Tool, ToolRegistry } from '../../src/types'

// 记录 run 是否真的被调到了 —— 审批的全部意义就是「拒绝时不执行」
function fakeTool(name: string, calls: string[]): Tool {
  return {
    name,
    description: name,
    parameters: {},
    run: async () => {
      calls.push(name)
      return `${name} done`
    },
  }
}

function setup() {
  const calls: string[] = []
  const requests: ApprovalRequestEvent[] = []
  const registry: ToolRegistry = {
    write_file: fakeTool('write_file', calls),
    read_file: fakeTool('read_file', calls),
    search_notes: fakeTool('search_notes', calls),
  }
  const gate = createApprovalGate()
  const guarded = guardRegistry(registry, 's1', gate, (e) => requests.push(e))
  return { calls, requests, gate, guarded }
}

describe('WRITE_TOOLS', () => {
  it('覆盖 fs server 的四个写操作', () => {
    for (const name of ['write_file', 'edit_file', 'create_directory', 'move_file']) {
      expect(WRITE_TOOLS.has(name)).toBe(true)
    }
  })

  it('不含只读工具（否则每次检索都要点一次确认，没人受得了）', () => {
    for (const name of ['read_file', 'list_directory', 'search_notes', 'get_weather']) {
      expect(WRITE_TOOLS.has(name)).toBe(false)
    }
  })
})

describe('guardRegistry', () => {
  it('只读工具直接执行，不发审批请求', async () => {
    const { calls, requests, guarded } = setup()
    await guarded.read_file.run({})
    await guarded.search_notes.run({})
    expect(calls).toEqual(['read_file', 'search_notes'])
    expect(requests).toEqual([])
  })

  it('保留原工具的 name/description/parameters（模型看到的定义不能变）', () => {
    const { guarded } = setup()
    expect(guarded.write_file.name).toBe('write_file')
    expect(guarded.write_file.description).toBe('write_file')
  })

  it('写工具先发审批请求，带 sessionId / toolName / args', async () => {
    const { requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    // 等一个微任务，让 run 内部走到发请求那步
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      sessionId: 's1',
      toolName: 'write_file',
      args: { path: 'a.md' },
    })
    gate.resolve(requests[0].requestId, 'allow')
    await pending
  })

  it('批准后执行原 run 并返回它的结果', async () => {
    const { calls, requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    gate.resolve(requests[0].requestId, 'allow')
    expect(await pending).toBe('write_file done')
    expect(calls).toEqual(['write_file'])
  })

  it('拒绝后绝不执行原 run，返回一个模型能读懂的拒绝说明', async () => {
    const { calls, requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    gate.resolve(requests[0].requestId, 'deny')
    const result = await pending
    // runTool 会把返回值 JSON.stringify 后喂回模型，所以这里返回结构化拒绝而不是抛错 ——
    // 抛错会被 runTool 包成 {"error":...}，模型可能理解成「工具坏了」而反复重试。
    expect(JSON.stringify(result)).toMatch(/denied|拒绝/)
    expect(calls).toEqual([])
  })

  it('每次请求的 requestId 都不同（一轮里可能多个写操作排队）', async () => {
    const { requests, gate, guarded } = setup()
    const a = guarded.write_file.run({ path: 'a.md' })
    const b = guarded.write_file.run({ path: 'b.md' })
    await Promise.resolve()
    expect(requests).toHaveLength(2)
    expect(requests[0].requestId).not.toBe(requests[1].requestId)
    gate.resolve(requests[0].requestId, 'allow')
    gate.resolve(requests[1].requestId, 'deny')
    await Promise.all([a, b])
  })

  it('pending() 报告还在等审批的请求，resolve 后清掉', async () => {
    const { requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    expect(gate.pending()).toHaveLength(1)
    gate.resolve(requests[0].requestId, 'allow')
    await pending
    expect(gate.pending()).toEqual([])
  })

  it('resolve 一个不存在的 requestId 不抛错（用户在超时后又点了按钮）', () => {
    const { gate } = setup()
    expect(() => gate.resolve('ghost', 'allow')).not.toThrow()
  })

  it('同一个 requestId 重复 resolve 只生效第一次', async () => {
    const { calls, requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    gate.resolve(requests[0].requestId, 'allow')
    gate.resolve(requests[0].requestId, 'deny') // 迟到的第二次，应被忽略
    await pending
    expect(calls).toEqual(['write_file'])
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/approval.test.ts`
Expected: FAIL —— 找不到模块 `electron/main/approval`

- [ ] **Step 4: 实现**

`electron/main/approval.ts`：

```ts
// 写操作审批闸口。参照 beautifului.dev 的 Approval Card 模式：
// 有后果的动作执行前必须显式确认。
//
// 为什么做成「注册表装饰器」而不是改 agent 循环：src/ 不能改，而 runAgent 直接调
// runTool(tools, name, args) → registry[name].run(args)。把写工具的 run 换掉，
// 闸口就自动落在 agent 循环内部、工具执行之前，src/ 一行不动。
import { randomUUID } from 'node:crypto'
import type { Tool, ToolRegistry } from '../../src/types'
import type { ApprovalDecision, ApprovalRequestEvent } from '../shared/channels'

// 只 gate 真正改动磁盘的工具。只读工具（read_file / list_directory / search_notes …）
// 必须放行，否则每次检索都要点确认，实际没人用得下去。
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
])

export interface ApprovalGate {
  requestApproval(event: ApprovalRequestEvent): Promise<ApprovalDecision>
  resolve(requestId: string, decision: ApprovalDecision): void
  pending(): string[]
}

export function createApprovalGate(): ApprovalGate {
  const waiting = new Map<string, (d: ApprovalDecision) => void>()

  return {
    requestApproval(event) {
      return new Promise<ApprovalDecision>((resolve) => {
        waiting.set(event.requestId, resolve)
      })
    },
    resolve(requestId, decision) {
      const resolver = waiting.get(requestId)
      // 不存在 = 已经 resolve 过或本来就没这个请求（用户重复点按钮），静默忽略
      if (!resolver) return
      waiting.delete(requestId) // 先删再 resolve，保证只生效一次
      resolver(decision)
    },
    pending() {
      return [...waiting.keys()]
    },
  }
}

export function guardRegistry(
  registry: ToolRegistry,
  sessionId: string,
  gate: ApprovalGate,
  emit: (event: ApprovalRequestEvent) => void,
): ToolRegistry {
  const guarded: ToolRegistry = {}

  for (const [name, tool] of Object.entries(registry)) {
    if (!WRITE_TOOLS.has(name)) {
      guarded[name] = tool
      continue
    }

    // 只换 run，name/description/parameters 原样保留 —— 模型看到的工具定义不能变，
    // 否则它对参数的理解会跟着变。
    const wrapped: Tool = {
      ...tool,
      run: async (args: Record<string, unknown>) => {
        const requestId = randomUUID()
        const event: ApprovalRequestEvent = { sessionId, requestId, toolName: name, args }
        const decision = gate.requestApproval(event)
        emit(event) // 先挂上等待再发事件，避免 Renderer 秒回时 resolver 还没注册
        if ((await decision) === 'deny') {
          // 返回结构化拒绝而不是抛错：runTool 会把抛错包成 {"error":...}，
          // 模型容易理解成「工具坏了」而反复重试；明确告诉它是用户拒绝，它才会换路子。
          return { denied: true, reason: `用户拒绝了 ${name} 操作`, toolName: name }
        }
        return tool.run(args)
      },
    }
    guarded[name] = wrapped
  }

  return guarded
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/approval.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 6: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add electron/main/approval.ts electron/shared/channels.ts tests/electron/approval.test.ts
git commit -m "feat(electron): approval gate for write tools via registry decorator"
```

> **接线留给 Task 13**：`guardRegistry` 需要 sessionId，而 sessionId 是请求级的，
> 所以包装要发生在 `agent-runner` 里每次 `run()` 时（用当前 sessionId 包一次），
> 不是启动时包一次。`ipc-handlers` 还要加 `CH.approvalResponse` 的 handler 调 `gate.resolve`。
> 本任务只做纯逻辑 + 单测，不碰 electron。

---
### Task 11: 前端事件累积 reducer

**Files:**
- Create: `electron/renderer/src/chat-reducer.ts`
- Test: `tests/electron/chat-reducer.test.ts`

**Interfaces:**
- Consumes: Task 2 的事件类型
- Produces:
  - `interface ChatMessage { role: 'user' | 'assistant'; content: string; tools: ToolCallEvent[]; verdict?: VerdictEvent; cacheHit?: boolean; streaming: boolean }`
  - `interface SessionChat { messages: ChatMessage[]; running: boolean; error?: { code: ErrorCode; message: string } }`
  - `type ChatState = Record<string, SessionChat>`
  - `type ChatAction`（`user-sent` / `chunk` / `tool-call` / `complete` / `verdict` / `cache-hit` / `error` / `loaded`）
  - `chatReducer(state: ChatState, action: ChatAction): ChatState`
  - `emptySession(): SessionChat`

**背景**：状态按 sessionId 分桶。因为 agent 是串行的，用户在等待时切到别的会话，回来后仍要看到完整消息——所以事件不能只更新「当前会话」。

- [ ] **Step 1: 写失败的测试**

`tests/electron/chat-reducer.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { chatReducer, type ChatState } from '../../electron/renderer/src/chat-reducer'

const empty: ChatState = {}

// 连续 apply 一串 action，省得每个用例都嵌套调用
const apply = (state: ChatState, ...actions: Parameters<typeof chatReducer>[1][]) =>
  actions.reduce(chatReducer, state)

describe('chatReducer', () => {
  it('user-sent 追加用户消息并标记运行中', () => {
    const s = chatReducer(empty, { type: 'user-sent', sessionId: 's1', text: '你好' })
    expect(s.s1.messages).toEqual([
      { role: 'user', content: '你好', tools: [], streaming: false },
    ])
    expect(s.s1.running).toBe(true)
  })

  it('第一个 chunk 创建 assistant 消息，后续 chunk 累加', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'chunk', event: { sessionId: 's1', text: '北京' } },
      { type: 'chunk', event: { sessionId: 's1', text: '今天晴' } },
    )
    const last = s.s1.messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('北京今天晴')
    expect(last.streaming).toBe(true)
  })

  it('complete 用完整文本替换累积的 delta，保证最终一致', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'chunk', event: { sessionId: 's1', text: '部分' } },
      { type: 'complete', event: { sessionId: 's1', text: '完整答案' } },
    )
    const last = s.s1.messages.at(-1)!
    expect(last.content).toBe('完整答案')
    expect(last.streaming).toBe(false)
    expect(s.s1.running).toBe(false)
  })

  it('缓存命中时没有 chunk，complete 也要能建出 assistant 消息', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'cache-hit', event: { sessionId: 's1' } },
      { type: 'complete', event: { sessionId: 's1', text: '秒回' } },
    )
    expect(s.s1.messages.at(-1)).toMatchObject({ role: 'assistant', content: '秒回', cacheHit: true })
  })

  it('tool-call 挂到当前 assistant 消息上', () => {
    const tool = { sessionId: 's1', turn: 1, toolName: 'get_weather', args: {}, output: '{}' }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'tool-call', event: tool },
    )
    expect(s.s1.messages.at(-1)!.tools).toEqual([tool])
  })

  it('verdict 挂到最后一条 assistant 消息上', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'complete', event: { sessionId: 's1', text: 'a' } },
      { type: 'verdict', event: { sessionId: 's1', grounded: false, issues: ['没依据'] } },
    )
    expect(s.s1.messages.at(-1)!.verdict).toMatchObject({ grounded: false, issues: ['没依据'] })
  })

  it('事件按 sessionId 分桶，不会串到别的会话', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'a' },
      { type: 'user-sent', sessionId: 's2', text: 'b' },
      { type: 'chunk', event: { sessionId: 's1', text: 'X' } },
    )
    expect(s.s1.messages.at(-1)!.content).toBe('X')
    expect(s.s2.messages).toHaveLength(1)
    expect(s.s2.messages[0].role).toBe('user')
  })

  it('error 记录错误并结束运行状态', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'error', event: { sessionId: 's1', code: 'MODEL_ERROR', message: '挂了' } },
    )
    expect(s.s1.running).toBe(false)
    expect(s.s1.error).toEqual({ code: 'MODEL_ERROR', message: '挂了' })
  })

  it('BUSY 错误不清掉正在跑的那个会话的运行状态', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'error', event: { sessionId: 's2', code: 'BUSY', message: '忙' } },
    )
    expect(s.s1.running).toBe(true)
    expect(s.s2.error?.code).toBe('BUSY')
  })

  it('loaded 用磁盘历史替换该会话的消息（切换会话时用）', () => {
    const s = chatReducer(empty, {
      type: 'loaded',
      sessionId: 's1',
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧答案' },
      ],
    })
    expect(s.s1.messages.map((m) => m.content)).toEqual(['旧问题', '旧答案'])
    expect(s.s1.running).toBe(false)
  })

  it('loaded 丢掉 tool 角色的消息（工具细节不在历史里回放）', () => {
    const s = chatReducer(empty, {
      type: 'loaded',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'tool', content: '{}', name: 'get_weather', toolCallId: '1' },
        { role: 'assistant', content: 'a' },
      ],
    })
    expect(s.s1.messages).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/chat-reducer.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

`electron/renderer/src/chat-reducer.ts`：

```ts
// 前端把 IPC 事件流累积成可渲染的消息列表。做成纯 reducer 是为了能直接单测 ——
// 流式累加 / 缓存命中没有 chunk / 事件分桶 这几处最容易写错，值得测。
import type {
  ErrorCode,
  MessageChunkEvent,
  MessageCompleteEvent,
  ToolCallEvent,
  VerdictEvent,
  CacheHitEvent,
  ErrorEvent,
  Message,
} from '../../shared/channels'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  tools: ToolCallEvent[]
  verdict?: { grounded: boolean; issues: string[] }
  cacheHit?: boolean
  streaming: boolean
}

export interface SessionChat {
  messages: ChatMessage[]
  running: boolean
  error?: { code: ErrorCode; message: string }
}

export type ChatState = Record<string, SessionChat>

export type ChatAction =
  | { type: 'user-sent'; sessionId: string; text: string }
  | { type: 'loaded'; sessionId: string; messages: Message[] }
  | { type: 'chunk'; event: MessageChunkEvent }
  | { type: 'tool-call'; event: ToolCallEvent }
  | { type: 'complete'; event: MessageCompleteEvent }
  | { type: 'verdict'; event: VerdictEvent }
  | { type: 'cache-hit'; event: CacheHitEvent }
  | { type: 'error'; event: ErrorEvent }

export function emptySession(): SessionChat {
  return { messages: [], running: false }
}

// 取出（必要时先创建）最后一条 assistant 消息。
// 缓存命中时不会有 chunk 事件，complete 直接到达，所以这个「按需创建」很关键。
function withAssistant(chat: SessionChat, mutate: (m: ChatMessage) => ChatMessage): SessionChat {
  const last = chat.messages.at(-1)
  if (last?.role === 'assistant') {
    return { ...chat, messages: [...chat.messages.slice(0, -1), mutate(last)] }
  }
  const fresh: ChatMessage = { role: 'assistant', content: '', tools: [], streaming: true }
  return { ...chat, messages: [...chat.messages, mutate(fresh)] }
}

// 只改一个会话桶，其余原样返回 —— React 靠引用变化决定重渲染
function update(state: ChatState, sessionId: string, fn: (chat: SessionChat) => SessionChat): ChatState {
  return { ...state, [sessionId]: fn(state[sessionId] ?? emptySession()) }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'user-sent':
      return update(state, action.sessionId, (chat) => ({
        ...chat,
        error: undefined,
        running: true,
        messages: [
          ...chat.messages,
          { role: 'user', content: action.text, tools: [], streaming: false },
        ],
      }))

    case 'loaded':
      return update(state, action.sessionId, () => ({
        running: false,
        messages: action.messages
          // tool 消息是喂给模型的中间结果，不在历史回放里展示
          .filter((m): m is Message & { role: 'user' | 'assistant' } =>
            m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content, tools: [], streaming: false })),
      }))

    case 'chunk':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, content: m.content + action.event.text, streaming: true })),
      )

    case 'tool-call':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, tools: [...m.tools, action.event] })),
      )

    case 'complete':
      return update(state, action.event.sessionId, (chat) => ({
        // 用完整答案替换累积的 delta：流式可能丢字，以最终文本为准
        ...withAssistant(chat, (m) => ({ ...m, content: action.event.text, streaming: false })),
        running: false,
      }))

    case 'verdict':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({
          ...m,
          verdict: { grounded: action.event.grounded, issues: action.event.issues },
        })),
      )

    case 'cache-hit':
      return update(state, action.event.sessionId, (chat) =>
        withAssistant(chat, (m) => ({ ...m, cacheHit: true })),
      )

    case 'error':
      return update(state, action.event.sessionId, (chat) => ({
        ...chat,
        // BUSY 是「这次没受理」，不是「正在跑的那个失败了」，
        // 而且它落在被拒的那个 session 桶里，不影响真正在跑的会话
        running: false,
        error: { code: action.event.code, message: action.event.message },
      }))
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/electron/chat-reducer.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/chat-reducer.ts tests/electron/chat-reducer.test.ts
git commit -m "feat(electron): pure chat reducer accumulating IPC events per session"
```

---

### Task 12: 聊天 UI 组件 + 深色主题

**Files:**
- Create: `electron/renderer/src/components/ToolCallIndicator.tsx`
- Create: `electron/renderer/src/components/ToolCallGroup.tsx`
- Create: `electron/renderer/src/components/SourceList.tsx`
- Create: `electron/renderer/src/components/ApprovalCard.tsx`
- Create: `electron/renderer/src/components/MessageBubble.tsx`
- Create: `electron/renderer/src/components/ChatWindow.tsx`
- Create: `electron/renderer/src/components/SessionList.tsx`
- Create: `electron/renderer/src/sources.ts`（从 search_notes 输出解析来源，纯函数）
- Test: `tests/electron/components.test.tsx`
- Test: `tests/electron/sources.test.ts`

> `electron/renderer/src/styles.css` 和 `main.tsx` 的样式引入**已经在引入 Tailwind 时完成**，
> 本任务不再创建它们，只确认内容（见 Step 7）。

**Interfaces:**
- Consumes: Task 11 的 `ChatMessage` / `SessionChat`；Task 2 的 `SessionMeta`；
  Task 8.5 的 `ApprovalRequestEvent` / `ApprovalDecision`
- Produces:
  - `<ToolCallIndicator event={ToolCallEvent} />`
  - `<ToolCallGroup events={ToolCallEvent[]} elapsedMs={number | undefined} />`
  - `<SourceList hits={SourceHit[]} />`
  - `<ApprovalCard request={ApprovalRequestEvent} onDecide={(d: ApprovalDecision) => void} />`
  - `<MessageBubble message={ChatMessage} />`
  - `<ChatWindow chat={SessionChat} onSend={(text: string) => void} onDecide={...} />`
  - `<SessionList sessions={SessionMeta[]} currentId={string | null} onSelect onCreate onDelete />`
  - `parseSources(toolEvents: ToolCallEvent[]): SourceHit[]`，`interface SourceHit { source: string; score: number; chars: number }`

**采纳的 agent 交互模式**（参照 beautifului.dev，用户已确认全要）：
1. **工具调用聚合 + 耗时** —— 同一 `turn` 的工具调用压成一行 chip「本轮 N 次工具调用 · X.Xs」，
   点开才展开单个 `ToolCallIndicator`。用 `ToolCallEvent.turn` 分组。
2. **来源标注 + Context Cards** —— 答案末尾列出 `search_notes` 命中的文件名 + 相似度 + 字符数，
   折叠成「N 个来源」。数据从工具输出 JSON 里解析（`sources.ts`）。
3. **核查结果做成 grounding 徽章** —— `ChatMessage.verdict` 渲染成显眼状态条，
   不支撑时列出具体存疑说法。
4. **写操作 Approval Card** —— 渲染 Task 8.5 发来的 `ApprovalRequestEvent`，
   显示工具名 + 参数 + 允许/拒绝按钮。

贯穿原则：**先给一行带计数或耗时的摘要，推理和证据放在一次点击之外，有后果的动作显式确认。**

- [ ] **Step 1: 写失败的测试**

`tests/electron/components.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ToolCallIndicator } from '../../electron/renderer/src/components/ToolCallIndicator'
import { MessageBubble } from '../../electron/renderer/src/components/MessageBubble'
import { ChatWindow } from '../../electron/renderer/src/components/ChatWindow'
import { SessionList } from '../../electron/renderer/src/components/SessionList'
import type { ChatMessage } from '../../electron/renderer/src/chat-reducer'

afterEach(cleanup)

const toolEvent = {
  sessionId: 's1',
  turn: 1,
  toolName: 'get_weather',
  args: { city: '北京' },
  output: '{"temp":25}',
}

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'assistant',
  content: '答案',
  tools: [],
  streaming: false,
  ...over,
})

describe('ToolCallIndicator', () => {
  it('显示工具名', () => {
    render(<ToolCallIndicator event={toolEvent} />)
    expect(screen.getByText(/get_weather/)).toBeTruthy()
  })

  it('默认折叠，详情不渲染', () => {
    render(<ToolCallIndicator event={toolEvent} />)
    expect(screen.queryByText(/"temp"/)).toBeNull()
  })

  it('点击后展开显示参数和结果', () => {
    render(<ToolCallIndicator event={toolEvent} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/"temp"/)).toBeTruthy()
    expect(screen.getByText(/北京/)).toBeTruthy()
  })

  it('工具返回 error 时标红（runTool 把异常包成 JSON，不走顶层错误）', () => {
    const failed = { ...toolEvent, output: '{"error":"unknown tool"}' }
    const { container } = render(<ToolCallIndicator event={failed} />)
    expect(container.querySelector('.tool--failed')).toBeTruthy()
  })
})

describe('MessageBubble', () => {
  it('用户消息和助手消息用不同的类名', () => {
    const { container: user } = render(<MessageBubble message={msg({ role: 'user' })} />)
    expect(user.querySelector('.bubble--user')).toBeTruthy()
    cleanup()
    const { container: bot } = render(<MessageBubble message={msg()} />)
    expect(bot.querySelector('.bubble--assistant')).toBeTruthy()
  })

  it('渲染挂在消息上的工具卡片', () => {
    render(<MessageBubble message={msg({ tools: [toolEvent] })} />)
    expect(screen.getByText(/get_weather/)).toBeTruthy()
  })

  it('流式中显示光标', () => {
    const { container } = render(<MessageBubble message={msg({ streaming: true })} />)
    expect(container.querySelector('.cursor')).toBeTruthy()
  })

  it('核查通过显示 ✅', () => {
    render(<MessageBubble message={msg({ verdict: { grounded: true, issues: [] } })} />)
    expect(screen.getByText(/✅/)).toBeTruthy()
  })

  it('核查存疑显示 ⚠️ 和问题列表', () => {
    render(<MessageBubble message={msg({ verdict: { grounded: false, issues: ['没依据'] } })} />)
    expect(screen.getByText(/⚠️/)).toBeTruthy()
    expect(screen.getByText(/没依据/)).toBeTruthy()
  })

  it('缓存命中显示标记', () => {
    render(<MessageBubble message={msg({ cacheHit: true })} />)
    expect(screen.getByText(/缓存命中/)).toBeTruthy()
  })
})

describe('ChatWindow', () => {
  const idle = { messages: [msg({ role: 'user', content: '问题' })], running: false }

  it('渲染消息列表', () => {
    render(<ChatWindow chat={idle} onSend={() => {}} />)
    expect(screen.getByText('问题')).toBeTruthy()
  })

  it('点发送时把输入内容交出去并清空输入框', () => {
    const sent: string[] = []
    render(<ChatWindow chat={idle} onSend={(t) => sent.push(t)} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '新问题' } })
    fireEvent.click(screen.getByRole('button', { name: /发送/ }))
    expect(sent).toEqual(['新问题'])
    expect(input.value).toBe('')
  })

  it('运行中禁用输入框和发送按钮（agent 是串行的）', () => {
    render(<ChatWindow chat={{ ...idle, running: true }} onSend={() => {}} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /发送/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('空输入不触发发送', () => {
    const sent: string[] = []
    render(<ChatWindow chat={idle} onSend={(t) => sent.push(t)} />)
    fireEvent.click(screen.getByRole('button', { name: /发送/ }))
    expect(sent).toEqual([])
  })

  it('显示错误提示', () => {
    render(
      <ChatWindow chat={{ ...idle, error: { code: 'API_KEY_MISSING', message: 'x' } }} onSend={() => {}} />,
    )
    expect(screen.getByText(/请在设置中配置 DeepSeek API Key/)).toBeTruthy()
  })
})

describe('SessionList', () => {
  const sessions = [
    { id: 's1', title: '会话一', updatedAt: 2 },
    { id: 's2', title: '会话二', updatedAt: 1 },
  ]

  it('列出所有会话', () => {
    render(<SessionList sessions={sessions} currentId="s1" onSelect={() => {}} onCreate={() => {}} onDelete={() => {}} />)
    expect(screen.getByText('会话一')).toBeTruthy()
    expect(screen.getByText('会话二')).toBeTruthy()
  })

  it('当前会话有选中样式', () => {
    const { container } = render(
      <SessionList sessions={sessions} currentId="s1" onSelect={() => {}} onCreate={() => {}} onDelete={() => {}} />,
    )
    expect(container.querySelectorAll('.session--active')).toHaveLength(1)
  })

  it('点击会话触发 onSelect', () => {
    const picked: string[] = []
    render(<SessionList sessions={sessions} currentId="s1" onSelect={(id) => picked.push(id)} onCreate={() => {}} onDelete={() => {}} />)
    fireEvent.click(screen.getByText('会话二'))
    expect(picked).toEqual(['s2'])
  })

  it('新建按钮触发 onCreate', () => {
    let created = 0
    render(<SessionList sessions={sessions} currentId="s1" onSelect={() => {}} onCreate={() => created++} onDelete={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /新对话/ }))
    expect(created).toBe(1)
  })

  it('删除按钮触发 onDelete 且不连带触发 onSelect', () => {
    const deleted: string[] = []
    const picked: string[] = []
    render(<SessionList sessions={sessions} currentId="s1" onSelect={(id) => picked.push(id)} onCreate={() => {}} onDelete={(id) => deleted.push(id)} />)
    fireEvent.click(screen.getAllByRole('button', { name: /删除/ })[1])
    expect(deleted).toEqual(['s2'])
    expect(picked).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/components.test.tsx`
Expected: FAIL —— 找不到组件模块

- [ ] **Step 3: 写 ToolCallIndicator**

`electron/renderer/src/components/ToolCallIndicator.tsx`：

```tsx
import { useState } from 'react'
import type { ToolCallEvent } from '../../../shared/channels'

// 工具失败不走顶层错误事件 —— runTool 把异常包成 {"error": "..."} 返回给模型，
// 所以这里靠解析 output 判断成败。
function isFailed(output: string): boolean {
  try {
    return typeof (JSON.parse(output) as { error?: unknown }).error === 'string'
  } catch {
    return false
  }
}

export function ToolCallIndicator({ event }: { event: ToolCallEvent }) {
  const [open, setOpen] = useState(false)
  const failed = isFailed(event.output)

  return (
    // 语义 class（tool / tool--failed）不带样式，只作测试与调试的锚点；
    // 视觉全部由 Tailwind utility 表达。Step 1 的测试断言 .tool--failed，别删。
    <div
      className={`tool ${failed ? 'tool--failed border-l-[3px] border-red' : ''} mb-2 overflow-hidden rounded-[10px] bg-canvas`}
    >
      <button
        className="tool__head flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-2 text-left text-ink-2"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{failed ? '⚠️' : '🔧'}</span>
        <span className="tool__name font-mono text-accent">{event.toolName}</span>
        <span className="ml-auto text-[0.85em]">第 {event.turn} 轮</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {/* 默认折叠：长 JSON 全渲染会拖慢长会话 */}
      {open && (
        <div className="px-3 pb-3">
          <pre className="mt-1.5 overflow-x-auto rounded-lg bg-page p-2.5 text-[0.85em]">
            {JSON.stringify(event.args, null, 2)}
          </pre>
          <pre className="mt-1.5 overflow-x-auto rounded-lg bg-page p-2.5 text-[0.85em]">
            {event.output}
          </pre>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 写 MessageBubble**

`electron/renderer/src/components/MessageBubble.tsx`：

```tsx
import ReactMarkdown from 'react-markdown'
import { ToolCallIndicator } from './ToolCallIndicator'
import type { ChatMessage } from '../chat-reducer'

// 用户气泡靠右、深一层；助手气泡靠左、浅一层。
// bubble--user / bubble--assistant 保留作测试锚点（Step 1 断言它们）。
const SIDE = {
  user: 'bubble--user self-end bg-field',
  assistant: 'bubble--assistant self-start bg-surface',
} as const

export function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={`bubble ${SIDE[message.role]} max-w-[76%] rounded-card px-4 py-3`}>
      {message.tools.map((tool, i) => (
        <ToolCallIndicator key={`${tool.turn}-${tool.toolName}-${i}`} event={tool} />
      ))}

      {/* bubble__text 有样式（styles.css 里给 Markdown 生成的 pre/code 用后代选择器）*/}
      <div className="bubble__text leading-relaxed">
        <ReactMarkdown>{message.content}</ReactMarkdown>
        {message.streaming && <span className="cursor" />}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {message.cacheHit && (
          <span className="badge badge--cache rounded-full bg-green-tint px-2.5 py-[3px] text-[0.85em] text-green">
            🟢 缓存命中
          </span>
        )}
        {message.verdict &&
          (message.verdict.grounded ? (
            <span className="badge badge--ok rounded-full bg-green-tint px-2.5 py-[3px] text-[0.85em] text-green">
              ✅ 答案被证据支撑
            </span>
          ) : (
            <span className="badge badge--warn rounded-[10px] bg-orange-tint px-2.5 py-[3px] text-[0.85em] text-orange">
              ⚠️ 可能有未被证据支撑的说法
              <ul className="mt-1.5 mb-0 list-disc pl-[18px]">
                {message.verdict.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </span>
          ))}
      </div>
    </div>
  )
}
```

> `rounded-card` 对应 `@theme` 里的 `--radius-bubble: 16px`；`bg-green-tint` 是 Tailwind 的
> 透明度语法，等价于原来手写的 `rgba(110, 231, 183, 0.12)`。

- [ ] **Step 5: 写 ChatWindow**

`electron/renderer/src/components/ChatWindow.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'
import { MessageBubble } from './MessageBubble'
import type { SessionChat } from '../chat-reducer'
import type { ErrorCode } from '../../../shared/channels'

const ERROR_TEXT: Record<ErrorCode, string> = {
  API_KEY_MISSING: '请在设置中配置 DeepSeek API Key',
  MODEL_ERROR: '模型调用失败，请检查网络或 API 配额',
  MAX_TURNS: 'Agent 反复调用工具未能收敛，已停止（可在设置中调大 MAX_TURNS）',
  BUSY: '上一个问题还在处理中，请稍候',
  UNKNOWN: '出错了',
}

export function ChatWindow({
  chat,
  onSend,
  disabled = false,
}: {
  chat: SessionChat
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  // 新消息到达时滚到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.messages])

  const blocked = chat.running || disabled

  const submit = () => {
    const value = text.trim()
    if (!value || blocked) return
    onSend(value)
    setText('')
  }

  return (
    <section className="chat flex min-w-0 flex-1 flex-col">
      <div className="chat__scroll flex flex-1 flex-col gap-3 overflow-y-auto p-6">
        {chat.messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {chat.error && (
          <p className="chat__error rounded-[10px] bg-red-tint px-3.5 py-2.5 text-red">
            {ERROR_TEXT[chat.error.code]}
            <span className="mt-1 block text-[0.85em] text-ink-2">{chat.error.message}</span>
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex gap-3 border-t border-line px-6 pt-3 pb-6">
        <textarea
          value={text}
          disabled={blocked}
          placeholder={blocked ? '正在思考…' : '问点什么（Enter 发送，Shift+Enter 换行）'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className="min-h-[52px] flex-1 resize-none rounded-[14px] border border-line-strong bg-surface p-3 font-[inherit] text-ink focus:outline-2 focus:outline-offset-[-1px] focus:outline-accent"
        />
        <button
          onClick={submit}
          disabled={blocked}
          className="cursor-pointer rounded-full border-none bg-accent px-[22px] font-semibold text-page disabled:cursor-not-allowed disabled:bg-field disabled:text-ink-2"
        >
          发送
        </button>
      </div>
    </section>
  )
}
```

- [ ] **Step 6: 写 SessionList**

`electron/renderer/src/components/SessionList.tsx`：

```tsx
import type { SessionMeta } from '../../../shared/channels'

export function SessionList({
  sessions,
  currentId,
  onSelect,
  onCreate,
  onDelete,
}: {
  sessions: SessionMeta[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}) {
  return (
    <aside className="sidebar flex w-60 flex-none flex-col gap-3 border-r border-line bg-canvas p-3">
      <button
        className="cursor-pointer rounded-full border-none bg-accent px-3.5 py-2 font-semibold text-page"
        onClick={onCreate}
      >
        ＋ 新对话
      </button>
      <ul className="m-0 list-none overflow-y-auto p-0">
        {sessions.map((s) => (
          // session--active 保留作测试锚点（Step 1 断言它），视觉靠后面的 utility
          <li
            key={s.id}
            className={`session group flex cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-2 ${
              s.id === currentId
                ? 'session--active bg-canvas text-ink'
                : 'text-ink-2 hover:bg-surface'
            }`}
            onClick={() => onSelect(s.id)}
          >
            <span className="flex-1 truncate">{s.title}</span>
            <button
              className="cursor-pointer border-none bg-transparent px-1 py-0.5 text-ink-2 opacity-0 group-hover:opacity-100"
              aria-label={`删除 ${s.title}`}
              onClick={(e) => {
                // 不让点击冒泡到 li，否则删除的同时会切到这个会话
                e.stopPropagation()
                onDelete(s.id)
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
```

- [ ] **Step 7: 确认设计 token（不要写手写 CSS）**

`electron/renderer/src/styles.css` 和 `main.tsx` 的样式引入**已经完成**，本步只需确认，不要重写。

设计系统移植自 beautifului.dev（用户指定的 UI 基准），token 是从该站生产 CSS 提取的真实值
（它同样用 Tailwind v4），取其 `.dark` 那一套。可用的 token：

- **表面**（按语义，不是层级）：`bg-page` 窗口底 · `bg-canvas` 次级区 · `bg-surface` 抬起的卡片 ·
  `bg-inset` 凹陷区（代码块） · `bg-field` 输入控件
- **文字**：`text-ink` · `text-ink-2` 次要 · `text-ink-3` 更弱
- **描边/悬停**：`border-line` · `border-line-strong` · `hover:bg-hover` · `hover:bg-hover-2`
- **强调/状态**：`text-accent` `bg-accent` · `text-accent-ink` · `bg-accent-tint` ·
  `text-green`/`bg-green-tint` · `text-orange`/`bg-orange-tint` · `text-red`/`bg-red-tint`
- **圆角**（按控件类型）：`rounded-card` 10px · `rounded-control` 8px · `rounded-chip` 6px
- **阴影**：`shadow-hairline` · `shadow-card` · `shadow-btn` · `shadow-overlay` · `shadow-inset-field`
- **字体**：`font-sans`（Inter，已打进包）· `font-mono`（JetBrains Mono）

**两条必须遵守的风格约定**，这是那个站视觉签名的来源：

1. **边界用 hairline ring，不用 border。** `shadow-card` 的第一层就是 `0 0 0 1px var(--color-line)`。
   卡片写 `shadow-card`，不要写 `border border-line`。只有分隔线（如输入区上边界）才用 border。
2. **颜色按语义选，不按深浅猜。** 代码块/JSON 用 `bg-inset`（凹陷），卡片用 `bg-surface`（抬起），
   输入框用 `bg-field`。别因为「差不多深」就混用。

语义 class（`.tool--failed`、`.session--active`、`.cursor` 等）保留但不带样式，只作测试锚点 ——
Step 1 的测试用 `container.querySelector` 断言它们。
- [ ] **Step 8: 跑组件测试**

Run: `pnpm vitest run tests/electron/components.test.tsx`
Expected: PASS（19 个用例）

> 若报 `document is not defined`，说明文件头的 `// @vitest-environment jsdom` 注释没生效——
> 它必须是文件的第一行，前面不能有空行或其他注释。

- [ ] **Step 9: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 10: Commit**

```bash
git add electron/renderer/src/styles.css electron/renderer/src/components/ electron/renderer/src/main.tsx tests/electron/components.test.tsx
git commit -m "feat(electron): chat UI components with dark theme"
```

---

### Task 13: 会话 IPC 接线 —— 多会话真正可用

**Files:**
- Modify: `electron/main/ipc-handlers.ts`
- Modify: `electron/main/preload.ts`
- Modify: `electron/renderer/src/App.tsx`（换掉临时界面，接真组件）
- Create: `electron/renderer/src/api.ts`

**Interfaces:**
- Consumes: Task 10 的 sessions 模块、Task 11 的 reducer、Task 12 的组件
- Produces: 完整的多会话聊天界面（新建/切换/删除/历史加载）

- [ ] **Step 1: ipc-handlers 加会话相关 handler**

在 `setupIpcHandlers` 里补（import 处加 `listSessions`, `deleteSession`, `newSessionId`, `createJsonSessionStore`）：

```ts
ipcMain.handle(CH.listSessions, () => listSessions(paths.sessionsDir))

// 新建会话不落盘：空会话没有内容可存，等第一条消息 onComplete 时自然创建文件。
// 副作用是新会话在列表里要等第一次回答完才出现 —— 前端用乐观更新补上。
ipcMain.handle(CH.createSession, () => newSessionId(Date.now()))

ipcMain.handle(CH.deleteSession, (_e, id: string) => deleteSession(paths.sessionsDir, id))

ipcMain.handle(CH.loadSession, (_e, id: string) =>
  createJsonSessionStore(paths.sessionsDir).load(id),
)
```

- [ ] **Step 2: preload 加对应方法**

在 `api` 对象里补：

```ts
listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke(CH.listSessions),
createSession: (): Promise<string> => ipcRenderer.invoke(CH.createSession),
deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(CH.deleteSession, id),
loadSession: (id: string): Promise<Message[]> => ipcRenderer.invoke(CH.loadSession, id),
```

对应补 import：`import type { SessionMeta, Message } from '../shared/channels'`

- [ ] **Step 3: 写 api.ts（Renderer 侧薄封装）**

`electron/renderer/src/api.ts`：

```ts
// window.electronAPI 的集中出口。组件不直接摸 window，
// 一来类型集中，二来将来要换传输方式（比如做 Web 版）只改这一个文件。
export const api = window.electronAPI
```

- [ ] **Step 4: 重写 App.tsx**

```tsx
import { useCallback, useEffect, useReducer, useState } from 'react'
import { SessionList } from './components/SessionList'
import { ChatWindow } from './components/ChatWindow'
import { chatReducer, emptySession } from './chat-reducer'
import { api } from './api'
import type { SessionMeta, RuntimeStatusEvent } from '../../shared/channels'

export function App() {
  const [chats, dispatch] = useReducer(chatReducer, {})
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [status, setStatus] = useState<RuntimeStatusEvent>({ phase: 'embedding', detail: '启动中…' })

  // 订阅所有 Main → Renderer 事件。每个事件都带 sessionId，
  // reducer 按 sessionId 分桶，所以即使用户切走了，回来消息也还在。
  useEffect(() => {
    const offs = [
      api.onRuntimeStatus(setStatus),
      api.onMessageChunk((event) => dispatch({ type: 'chunk', event })),
      api.onToolCall((event) => dispatch({ type: 'tool-call', event })),
      api.onCacheHit((event) => dispatch({ type: 'cache-hit', event })),
      api.onVerdict((event) => dispatch({ type: 'verdict', event })),
      api.onError((event) => dispatch({ type: 'error', event })),
      api.onMessageComplete((event) => {
        dispatch({ type: 'complete', event })
        // 答完了会话文件才落盘，这时候刷新列表才能拿到标题
        void api.listSessions().then(setSessions)
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // 启动时拉会话列表，没有会话就开一个新的
  useEffect(() => {
    void (async () => {
      const list = await api.listSessions()
      setSessions(list)
      if (list.length > 0) {
        setCurrentId(list[0].id)
      } else {
        setCurrentId(await api.createSession())
      }
    })()
  }, [])

  // 切换会话时从磁盘加载历史（内存里没有的话）
  const select = useCallback(async (id: string) => {
    setCurrentId(id)
    const messages = await api.loadSession(id)
    dispatch({ type: 'loaded', sessionId: id, messages })
  }, [])

  const create = useCallback(async () => {
    const id = await api.createSession()
    // 乐观加进列表：空会话不落盘，不这样做的话它在第一次回答前不会出现
    setSessions((prev) => [{ id, title: '新会话', updatedAt: Date.now() }, ...prev])
    setCurrentId(id)
  }, [])

  const remove = useCallback(
    async (id: string) => {
      await api.deleteSession(id)
      const list = await api.listSessions()
      setSessions(list)
      if (id === currentId) {
        setCurrentId(list[0]?.id ?? (await api.createSession()))
      }
    },
    [currentId],
  )

  const send = useCallback(
    (text: string) => {
      if (!currentId) return
      dispatch({ type: 'user-sent', sessionId: currentId, text })
      void api.sendMessage(currentId, text)
    },
    [currentId],
  )

  const chat = (currentId && chats[currentId]) || emptySession()
  const booting = status.phase !== 'ready'

  return (
    <>
      <SessionList
        sessions={sessions}
        currentId={currentId}
        onSelect={(id) => void select(id)}
        onCreate={() => void create()}
        onDelete={(id) => void remove(id)}
      />
      <ChatWindow chat={chat} onSend={send} disabled={booting} />
    </>
  )
}
```

- [ ] **Step 5: 手动验收多会话**

Run: `pnpm dev:electron`

Expected:
1. 提一个问题 → 答完后左侧出现以问题为标题的会话
2. 点「＋ 新对话」→ 提另一个问题 → 两个会话都在列表里
3. 切回第一个会话 → 历史消息完整显示
4. 删除一个会话 → 列表更新，当前会话自动切走
5. agent 跑的过程中输入框禁用；跑的时候切到另一个会话再切回来，消息不丢

- [ ] **Step 6: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add electron/main/ipc-handlers.ts electron/main/preload.ts electron/renderer/src/App.tsx electron/renderer/src/api.ts
git commit -m "feat(electron): multi-session chat with create, switch, delete and history"
```

---

### Task 14: 启动进度画面

**Files:**
- Create: `electron/renderer/src/components/StartupScreen.tsx`
- Modify: `electron/renderer/src/App.tsx`
- Modify: `electron/renderer/src/styles.css`
- Test: `tests/electron/startup-screen.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `RuntimeStatusEvent`
- Produces: `<StartupScreen status={RuntimeStatusEvent} onRetry={() => void} />`

**背景**：首次运行要从 HuggingFace 下载 embedding 模型，可能几十秒。没有进度画面的话用户会以为应用卡死。

- [ ] **Step 1: 写失败的测试**

`tests/electron/startup-screen.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { StartupScreen } from '../../electron/renderer/src/components/StartupScreen'

afterEach(cleanup)

describe('StartupScreen', () => {
  it('显示当前阶段的说明文字', () => {
    render(<StartupScreen status={{ phase: 'embedding', detail: '正在加载 embedding 模型…' }} onRetry={() => {}} />)
    expect(screen.getByText(/正在加载 embedding 模型/)).toBeTruthy()
  })

  it('把四个阶段都画出来，已完成的打勾', () => {
    const { container } = render(<StartupScreen status={{ phase: 'mcp', detail: '连接中' }} onRetry={() => {}} />)
    expect(container.querySelectorAll('.step')).toHaveLength(3)
    expect(container.querySelectorAll('.step--done')).toHaveLength(2)
  })

  it('首次启动提示模型下载可能较慢', () => {
    render(<StartupScreen status={{ phase: 'embedding', detail: 'x' }} onRetry={() => {}} />)
    expect(screen.getByText(/首次运行需要下载/)).toBeTruthy()
  })

  it('失败时显示错误详情和重试按钮', () => {
    let retried = 0
    render(<StartupScreen status={{ phase: 'failed', detail: 'MCP 起不来' }} onRetry={() => retried++} />)
    expect(screen.getByText(/MCP 起不来/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(retried).toBe(1)
  })

  it('失败时不显示阶段进度（已经没意义了）', () => {
    const { container } = render(<StartupScreen status={{ phase: 'failed', detail: 'x' }} onRetry={() => {}} />)
    expect(container.querySelectorAll('.step')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/startup-screen.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现组件**

`electron/renderer/src/components/StartupScreen.tsx`：

```tsx
import type { RuntimeStatusEvent } from '../../../shared/channels'

const STEPS = [
  { phase: 'embedding', label: '加载 embedding 模型' },
  { phase: 'indexing', label: '索引笔记' },
  { phase: 'mcp', label: '连接 MCP 工具' },
] as const

export function StartupScreen({
  status,
  onRetry,
}: {
  status: RuntimeStatusEvent
  onRetry: () => void
}) {
  if (status.phase === 'failed') {
    return (
      // startup 保留作测试锚点，视觉由 Tailwind utility 表达
      <div className="startup flex flex-1 flex-col items-center justify-center gap-2.5 bg-page">
        <h2 className="m-0 mb-2 tracking-wide">启动失败</h2>
        <p className="startup__error max-w-[420px] text-center text-red">{status.detail}</p>
        <button
          className="cursor-pointer rounded-full border-none bg-accent px-5 py-2 font-semibold text-page"
          onClick={onRetry}
        >
          重试
        </button>
      </div>
    )
  }

  const currentIndex = STEPS.findIndex((s) => s.phase === status.phase)

  return (
    <div className="startup flex flex-1 flex-col items-center justify-center gap-2.5 bg-page">
      <h2 className="m-0 mb-2 tracking-wide">Smallest Agent</h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {STEPS.map((step, i) => {
          // step / step--done / step--active 保留作测试锚点（Step 1 断言它们的数量）
          const state =
            i < currentIndex
              ? 'step--done text-green'
              : i === currentIndex
                ? 'step--active text-accent'
                : 'text-ink-2'
          return (
            <li key={step.phase} className={`step ${state}`}>
              {i < currentIndex ? '✓' : i === currentIndex ? '●' : '○'} {step.label}
            </li>
          )
        })}
      </ul>
      <p className="mt-3 mb-0 text-ink">{status.detail}</p>
      <p className="max-w-[340px] text-center text-[0.85em] text-ink-2">
        首次运行需要下载 embedding 模型，可能要等几十秒。
      </p>
    </div>
  )
}
```

- [ ] **Step 4: 不需要加样式**

样式已经写在 Step 3 的 Tailwind utility 里了，`styles.css` 不用动 —— 项目用 Tailwind v4，
组件的视觉全部就地表达，`styles.css` 只保留 `@theme` 调色板和三处 utility 表达不了的东西
（全局底色、`.cursor` 闪烁 keyframes、Markdown 生成的 `pre/code`）。

本步只需确认 Step 3 里用到的 token 都在 `@theme` 里存在：`bg-page`、`text-ink`、
`text-ink-2`、`text-accent`、`text-green`、`text-red`。都有，无需新增。

- [ ] **Step 5: App.tsx 接入**

加 import：

```tsx
import { StartupScreen } from './components/StartupScreen'
```

把 return 改成：

```tsx
  if (booting) {
    return <StartupScreen status={status} onRetry={() => window.location.reload()} />
  }

  return (
    <>
      <SessionList ... />
      <ChatWindow chat={chat} onSend={send} />
    </>
  )
```

（`ChatWindow` 的 `disabled={booting}` 可以去掉了——装配未完成时根本渲染不到它。）

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run tests/electron/startup-screen.test.tsx`
Expected: PASS（5 个用例）

- [ ] **Step 7: 手动验收**

Run: `pnpm dev:electron`
Expected: 启动时看到三步进度依次点亮，就绪后自动切到聊天界面。

- [ ] **Step 8: Commit**

```bash
git add electron/renderer/src/components/StartupScreen.tsx electron/renderer/src/App.tsx electron/renderer/src/styles.css tests/electron/startup-screen.test.tsx
git commit -m "feat(electron): startup progress screen with phase tracking and retry"
```

---

### Task 15: 设置面板

**Files:**
- Create: `electron/renderer/src/components/SettingsPanel.tsx`
- Modify: `electron/renderer/src/App.tsx`
- Modify: `electron/renderer/src/styles.css`
- Modify: `electron/main/ipc-handlers.ts`（改 NOTES_DIR 后重建索引）
- Test: `tests/electron/settings-panel.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `SETTING_KEYS` / `DesktopSettings`
- Produces: `<SettingsPanel settings={DesktopSettings} onSave={(patch) => void} onClose={() => void} />`

- [ ] **Step 1: 写失败的测试**

`tests/electron/settings-panel.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SettingsPanel } from '../../electron/renderer/src/components/SettingsPanel'

afterEach(cleanup)

describe('SettingsPanel', () => {
  it('把已有设置填进输入框', () => {
    render(<SettingsPanel settings={{ DEEPSEEK_MODEL: 'deepseek-chat' }} onSave={() => {}} onClose={() => {}} />)
    expect((screen.getByLabelText('DEEPSEEK_MODEL') as HTMLInputElement).value).toBe('deepseek-chat')
  })

  it('API Key 用密码框，不明文显示在屏幕上', () => {
    render(<SettingsPanel settings={{}} onSave={() => {}} onClose={() => {}} />)
    expect((screen.getByLabelText('DEEPSEEK_API_KEY') as HTMLInputElement).type).toBe('password')
  })

  it('保存时把改动交出去', () => {
    const saved: Record<string, string>[] = []
    render(<SettingsPanel settings={{}} onSave={(p) => saved.push(p)} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('DEEPSEEK_API_KEY'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByRole('button', { name: /保存/ }))
    expect(saved[0].DEEPSEEK_API_KEY).toBe('sk-new')
  })

  it('改 NOTES_DIR 时提示会重建索引', () => {
    render(<SettingsPanel settings={{ NOTES_DIR: '/old' }} onSave={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('NOTES_DIR'), { target: { value: '/new' } })
    expect(screen.getByText(/重建索引/)).toBeTruthy()
  })

  it('关闭按钮触发 onClose', () => {
    let closed = 0
    render(<SettingsPanel settings={{}} onSave={() => {}} onClose={() => closed++} />)
    fireEvent.click(screen.getByRole('button', { name: /关闭/ }))
    expect(closed).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/settings-panel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现组件**

`electron/renderer/src/components/SettingsPanel.tsx`：

```tsx
import { useState } from 'react'
import { SETTING_KEYS, type DesktopSettings } from '../../../main/config-env'

// 每个字段的说明，直接对应 src/config.ts 里的默认值语义
const HINTS: Partial<Record<(typeof SETTING_KEYS)[number], string>> = {
  DEEPSEEK_BASE_URL: '默认 https://api.deepseek.com/v1',
  DEEPSEEK_MODEL: '默认 deepseek-chat',
  FALLBACK_MODEL: '主模型连续失败时切换的备用模型',
  NOTES_DIR: 'RAG 检索的笔记目录，默认 ./notes',
  HF_ENDPOINT: '国内连不上 HuggingFace 时填 https://hf-mirror.com',
  STREAM: '填 0 关闭流式输出',
  LLM_CACHE: '填 0 关闭磁盘缓存',
  MAX_TURNS: 'agent 循环最多转几圈，默认 10',
  MAX_CONTEXT_TOKENS: '历史超过这个估算值就压缩，默认 2000',
  KEEP_RECENT: '压缩时保留最近几条，默认 6',
}

export function SettingsPanel({
  settings,
  onSave,
  onClose,
}: {
  settings: DesktopSettings
  onSave: (patch: DesktopSettings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<DesktopSettings>(settings)
  const notesDirChanged = (draft.NOTES_DIR ?? '') !== (settings.NOTES_DIR ?? '')

  return (
    // settings 保留作测试锚点；面板盖满窗口，所以是 fixed inset-0
    <div className="settings fixed inset-0 z-10 flex flex-col bg-canvas">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <h2 className="m-0 text-[1.1em]">设置</h2>
        <button
          aria-label="关闭"
          onClick={onClose}
          className="cursor-pointer border-none bg-transparent text-[1.1em] text-ink-2"
        >
          ✕
        </button>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {SETTING_KEYS.map((key) => (
          <label key={key} className="field flex flex-col gap-1">
            <span className="font-mono text-[0.8em] text-ink-2">{key}</span>
            <input
              aria-label={key}
              type={key === 'DEEPSEEK_API_KEY' ? 'password' : 'text'}
              value={draft[key] ?? ''}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              className="rounded-[10px] border border-line-strong bg-surface px-3 py-2.5 font-[inherit] text-ink focus:outline-2 focus:outline-offset-[-1px] focus:outline-accent"
            />
            {HINTS[key] && <span className="text-[0.78em] text-ink-2">{HINTS[key]}</span>}
          </label>
        ))}

        {/* 改笔记目录要重跑 buildNotesIndex，其余设置下次提问自动生效 */}
        {notesDirChanged && (
          <p className="settings__warn text-[0.85em] text-orange">保存后会重建索引，需要等待片刻。</p>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-line px-6 py-4">
        <p className="m-0 text-[0.8em] text-ink-2">API Key 以明文存在本地 userData 目录。</p>
        <button
          className="cursor-pointer rounded-full border-none bg-accent px-[22px] py-2 font-semibold text-page"
          onClick={() => onSave(draft)}
        >
          保存
        </button>
      </footer>
    </div>
  )
}
```

- [ ] **Step 4: 只加侧边栏设置入口的样式（其余已在 Step 3 的 utility 里）**

设置面板本身的视觉已经写在 Step 3 的 Tailwind utility 里，`styles.css` 不用动。
Step 5 要给 `SessionList` 加的设置入口按钮，样式同样就地写 utility：

```tsx
<button
  className="mt-auto cursor-pointer rounded-full border border-line bg-transparent px-3.5 py-1.5 text-ink-2"
  onClick={onOpenSettings}
>
  ⚙️ 设置
</button>
```

本步只需确认 Step 3 用到的 token 都在 `@theme` 里：`bg-canvas`/`-2`/`-3`/`-4`、
`text-ink`、`text-ink-2`、`text-orange`、`bg-accent`、`text-page`。都有，无需新增。

- [ ] **Step 5: SessionList 加设置入口**

在 `SessionList.tsx` 的 `</aside>` 之前加，并给组件加一个 `onOpenSettings: () => void` prop：

```tsx
      <button
        className="mt-auto cursor-pointer rounded-full border border-line bg-transparent px-3.5 py-1.5 text-ink-2"
        onClick={onOpenSettings}
      >
        ⚙️ 设置
      </button>
```

同步更新 `tests/electron/components.test.tsx` 里 `SessionList` 的四处 render 调用，补上 `onOpenSettings={() => {}}`。

- [ ] **Step 6: App.tsx 接入**

加状态和渲染：

```tsx
const [showSettings, setShowSettings] = useState(false)
const [settings, setSettings] = useState<DesktopSettings>({})

useEffect(() => {
  void api.getSettings().then(setSettings)
}, [])

const saveSettings = useCallback(async (patch: DesktopSettings) => {
  setSettings(await api.saveSettings(patch))
  setShowSettings(false)
}, [])
```

在 return 里，`<SessionList>` 加 `onOpenSettings={() => setShowSettings(true)}`，并在末尾加：

```tsx
{showSettings && (
  <SettingsPanel settings={settings} onSave={(p) => void saveSettings(p)} onClose={() => setShowSettings(false)} />
)}
```

- [ ] **Step 7: 主进程支持改 NOTES_DIR 后重建索引**

`setupIpcHandlers` 的签名改成接收一个可重建的 runtime 引用。在 `ipc-handlers.ts` 里把 `saveSettings` 的 handler 改成：

```ts
ipcMain.handle(CH.saveSettings, async (_e, patch) => {
  const before = getSettings().NOTES_DIR
  const next = saveSettings(patch)
  // 换了笔记目录，索引就过期了 —— 重跑 App 级装配
  if (next.NOTES_DIR !== before) await rebuild()
  return next
})
```

`rebuild` 由 `index.ts` 传入：关掉旧 runtime、用新 config 再跑一次 `createRuntime`、把新的 registry 交给一个新的 runner。最简单的做法是把 `runtime` 和 `runner` 放进一个可变的 holder 对象里，`rebuild` 替换它的字段。

- [ ] **Step 8: 跑测试**

Run: `pnpm vitest run tests/electron/settings-panel.test.tsx tests/electron/components.test.tsx`
Expected: PASS

- [ ] **Step 9: 手动验收**

Run: `pnpm dev:electron`
Expected: 点「⚙️ 设置」打开面板 → 改 `DEEPSEEK_MODEL` 保存 → 下一次提问用新模型（trace 里能看出来）→ 改 `NOTES_DIR` 保存后能看到重新索引的状态。

- [ ] **Step 10: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 11: Commit**

```bash
git add electron/renderer/src/components/SettingsPanel.tsx electron/renderer/src/components/SessionList.tsx electron/renderer/src/App.tsx electron/renderer/src/styles.css electron/main/ipc-handlers.ts electron/main/index.ts tests/electron/settings-panel.test.tsx tests/electron/components.test.tsx
git commit -m "feat(electron): settings panel with env passthrough and index rebuild"
```

---

### Task 16: 长会话虚拟滚动

**Files:**
- Create: `electron/renderer/src/visible-window.ts`
- Modify: `electron/renderer/src/components/ChatWindow.tsx`
- Test: `tests/electron/visible-window.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `visibleRange(total: number, limit?: number): { start: number; hiddenCount: number }`

**背景**：消息超过 100 条时全量渲染会明显卡顿。这里不引虚拟滚动库——只渲染最近 N 条 + 一个「显示更早的消息」按钮，够用且代码量最小。

- [ ] **Step 1: 写失败的测试**

`tests/electron/visible-window.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { visibleRange } from '../../electron/renderer/src/visible-window'

describe('visibleRange', () => {
  it('消息少于上限时全部显示', () => {
    expect(visibleRange(20)).toEqual({ start: 0, hiddenCount: 0 })
  })

  it('刚好等于上限时也全部显示', () => {
    expect(visibleRange(100, 100)).toEqual({ start: 0, hiddenCount: 0 })
  })

  it('超过上限时只显示最近的，并报告隐藏了多少条', () => {
    expect(visibleRange(150, 100)).toEqual({ start: 50, hiddenCount: 50 })
  })

  it('空列表不会算出负数', () => {
    expect(visibleRange(0)).toEqual({ start: 0, hiddenCount: 0 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/electron/visible-window.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`electron/renderer/src/visible-window.ts`：

```ts
// 长会话只渲染最近 N 条。不引虚拟滚动库 —— 对聊天这种「几乎总是看底部」的场景，
// 截断 + 一个「显示更早」按钮就够了，代码量和依赖都小得多。
const DEFAULT_LIMIT = 100

export function visibleRange(
  total: number,
  limit: number = DEFAULT_LIMIT,
): { start: number; hiddenCount: number } {
  const start = Math.max(0, total - limit)
  return { start, hiddenCount: start }
}
```

- [ ] **Step 4: ChatWindow 接入**

在 `ChatWindow.tsx` 里加 `showAll` 状态，把消息渲染改成：

```tsx
const [showAll, setShowAll] = useState(false)
const { start, hiddenCount } = showAll
  ? { start: 0, hiddenCount: 0 }
  : visibleRange(chat.messages.length)

// ...
<div className="chat__scroll flex flex-1 flex-col gap-3 overflow-y-auto p-6">
  {hiddenCount > 0 && (
    <button
      className="cursor-pointer self-center rounded-full border border-line-strong bg-surface px-4 py-1.5 text-ink-2"
      onClick={() => setShowAll(true)}
    >
      显示更早的 {hiddenCount} 条消息
    </button>
  )}
  {chat.messages.slice(start).map((m, i) => (
    <MessageBubble key={start + i} message={m} />
  ))}
  ...
</div>
```

样式就地写在 utility 里，`styles.css` 不用动（Tailwind 项目的惯例）。

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run tests/electron/visible-window.test.ts tests/electron/components.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/renderer/src/visible-window.ts electron/renderer/src/components/ChatWindow.tsx electron/renderer/src/styles.css tests/electron/visible-window.test.ts
git commit -m "feat(electron): cap rendered messages in long sessions"
```

---

### Task 17: 打包

**Files:**
- Modify: `package.json`（build 配置 + package scripts）
- Create: `build/entitlements.mac.plist`（如果 macOS 打包需要）
- Modify: `README.md`（打包说明）

**Interfaces:**
- Consumes: 前面全部
- Produces: `pnpm package:mac` 产出可安装的 `.dmg`

**关键点**：`mcp-server.ts` 用 `import.meta.url` 定位 `skills/` 目录（`join(here, 'skills')`），所以编译产物 `mcp-server.js` 旁边**必须**有 `skills/` 目录，否则 `list_skills` 会失败。

- [ ] **Step 1: 加 electron-builder 配置**

在 `package.json` 里加：

```json
"build": {
  "appId": "com.smallest-agent.app",
  "productName": "Smallest Agent",
  "directories": { "output": "dist-electron", "buildResources": "build" },
  "files": ["out/**/*"],
  "extraResources": [
    { "from": "out/main/mcp-server.js", "to": "mcp-server.js" },
    { "from": "skills", "to": "skills" }
  ],
  "asarUnpack": ["**/node_modules/@huggingface/**"],
  "mac": { "target": ["dmg", "zip"], "category": "public.app-category.developer-tools" },
  "win": { "target": ["nsis", "portable"] },
  "linux": { "target": ["AppImage"] }
}
```

同时加 scripts：

```json
"package:mac": "electron-vite build && electron-builder --mac",
"package:win": "electron-vite build && electron-builder --win",
"package:linux": "electron-vite build && electron-builder --linux"
```

> `skills/` 必须和 `mcp-server.js` 一起放进 `resourcesPath`，因为 mcp-server 用
> `join(dirname(fileURLToPath(import.meta.url)), 'skills')` 找技能文件。
> `@huggingface/transformers` 含原生依赖，打进 asar 后加载会失败，所以 unpack 出来。

- [ ] **Step 2: 构建**

Run: `pnpm build:electron`
Expected: 生成 `out/main/index.js`、`out/main/mcp-server.js`、`out/preload/preload.cjs`、`out/renderer/index.html`。用 `ls out/main/` 确认 `mcp-server.js` 真的在。

- [ ] **Step 3: 打包**

Run: `pnpm package:mac`
Expected: `dist-electron/` 下出现 `.dmg`

- [ ] **Step 4: 装到干净位置验证**

装上 `.dmg` 里的应用并启动（不要从项目目录启动，要模拟真实用户）。

Expected:
1. 启动进度画面正常走完（首次会下载 embedding 模型）
2. 在设置里填入 API Key 后能提问
3. **问「北京天气怎么样」能触发 `get_weather`** —— 这一条专门验证生产环境的 MCP server 启动方案（`process.execPath` + `ELECTRON_RUN_AS_NODE`）真的生效了
4. 问「有哪些技能」能触发 `list_skills` —— 验证 `skills/` 目录被正确打包到 `mcp-server.js` 旁边
5. 会话能保存，重启应用后还在（写在 userData 而不是应用目录）

若第 3 步失败，按顺序排查：`process.resourcesPath` 下有没有 `mcp-server.js`；`ELECTRON_RUN_AS_NODE` 有没有真的传进子进程（在 `transportOptions` 里打印一下）；`mcp-server.js` 单独用 `node out/main/mcp-server.js` 能不能跑起来。

- [ ] **Step 5: Commit**

```bash
git add package.json README.md
git commit -m "build(electron): package config with MCP server and skills in resources"
```

---

### Task 18: 文档

**Files:**
- Modify: `README.md`
- Create: `electron/README.md`

**Interfaces:**
- Consumes: 前面全部
- Produces: 开源可读的文档

- [ ] **Step 1: 主 README 加桌面版段落**

在现有的「运行」一节后面加：

```markdown
## 两个入口：CLI 和桌面版

同一套 agent 核心（`src/`），两个入口：

| | 命令行 | 桌面版 |
|---|---|---|
| 启动 | `pnpm dev "你的问题"` | `pnpm dev:electron` |
| 入口文件 | `cli.ts` | `electron/main/index.ts` |
| 适合 | 读代码、看 trace、跑 eval | 日常使用、多会话 |

**建议的阅读顺序：先 `cli.ts` 再 `electron/`。** `cli.ts` 把整条装配线写在一个文件里，
从上往下读就能看懂 agent 是怎么组装起来的；桌面版是同一条装配线拆成「启动时一次」和
「每条消息一次」两段，先理解了单次版本再看拆分才不会绕。

桌面版的架构说明见 `electron/README.md`。
```

同时在「结构」一节的目录树后面追加：

```
electron/main/      主进程：App 级装配 + IPC
electron/renderer/  前端：React 聊天界面
electron/shared/    两端共用的 IPC 频道与事件类型
```

- [ ] **Step 2: 写 electron/README.md**

内容要点（每节配代码位置）：

```markdown
# 桌面版架构

## 一句话

Main 进程 import 现有的 `src/` 跑 agent，Renderer 用 React 画界面，中间靠 IPC 事件推送。
`src/` 一行没改 —— 这是本目录唯一的硬约束。

## 装配线为什么要拆成两段

`cli.ts` 是「装配 → 跑一次 → 退出」。桌面端长驻，所以拆成：

- **App 级**（`main/agent-runtime.ts`，启动一次）：embedding 模型、笔记索引、MCP 子进程。这些贵，且与具体问题无关。
- **请求级**（`main/agent-runner.ts`，每条消息一次）：callModel 的 retry/cache/fallback 装饰链。

为什么 callModel 不能只建一次：`makeCallModel(config, registry, onText)` 把流式回调
**闭包进了内部**。全局只建一个的话，所有会话的 token 流都会涌向同一个 `onText`，
没法按 sessionId 路由。所以每次请求用当前 sessionId 重建这条链。

## 为什么串行

同一时刻只跑一个 `runAgent`（`main/agent-runner.ts` 的 `busy` 标志）。
会话文件是「读-改-写」，并发会互相覆盖；个人使用也没有并发收益。

## 零修改是怎么做到的

三个接缝，全是现有代码本来就留好的：

1. `loadConfig(env)` 接受 env 参数 → 设置面板把用户输入拼成 env 形状（`main/config-env.ts`），不改 `src/config.ts`
2. `loadMcpToolsFromServers(servers, connect)` 的第二个参数可注入连接器 → 桌面端传一个带 env 的版本（`main/mcp-connect.ts`），解决打包后 `ELECTRON_RUN_AS_NODE` 传不进子进程的问题
3. `runAgent` 的 `onTurn` / `onComplete` 钩子 → 直接用来推 IPC 事件和存会话

`SessionStore` 没有 `list` 方法，会话列表是桌面端新增的能力（`main/sessions.ts`），同样没动 `src/`。

## 测试策略

纯逻辑模块**不 import `electron`**，`app.getPath()` 之类的值由调用方传参 —— 这样 vitest
能在纯 Node 下直接跑它们（`tests/electron/`）。只有 `main/index.ts` 和 `main/ipc-handlers.ts`
碰 electron API，它们只做接线，靠手动验收。

## 打包的两个坑

1. **MCP server**：`npx tsx mcp-server.ts` 在打包后必然失败。生产环境用
   `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑编译产物（`main/mcp-paths.ts`）。
2. **skills 目录**：`mcp-server.ts` 用 `import.meta.url` 找 `skills/`，所以打包时
   `skills/` 必须和 `mcp-server.js` 一起放进 `resourcesPath`（见 package.json 的 extraResources）。
```

- [ ] **Step 3: 检查文档与代码一致**

逐条核对 `electron/README.md` 里提到的文件路径和函数名，确保都存在（`main/agent-runtime.ts`、`main/agent-runner.ts`、`main/config-env.ts`、`main/mcp-connect.ts`、`main/mcp-paths.ts`、`main/sessions.ts`）。

- [ ] **Step 4: 全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add README.md electron/README.md
git commit -m "docs(electron): document desktop architecture and CLI-to-desktop reading path"
```

---

## 自查记录

写完后对照 spec 逐节核了一遍，处理了这些：

- **spec 的 `TOOL_ERROR` 错误码去掉了**。`runTool`（`src/tools/index.ts:27-32`）捕获工具异常并包成 JSON 返回给模型，永远不会抛到顶层，所以那个错误码不可能触发。改成在工具卡片里标红显示（Task 12 有对应测试）。同时补了 `BUSY`——spec 说「已有任务时返回错误事件」但没给错误码。
- **`connectMcp` 没有 env 参数**这个冲突，用 `loadMcpToolsFromServers` 的第二个注入参数解决（Task 5），`src/` 不用改。
- **`loadMcpToolsFromServers` 是「全成功或全失败」**，所以 fs server 想做成可选就必须单独调一次并包 try（Task 6），这在 spec 里补了说明。
- **`SessionStore` 没有 `list`**，会话列表是 Electron 层新代码（Task 10）。
- **spec 提到的 embedding 懒加载删掉了**，它和启动进度画面的设计冲突（Task 6/14 按「启动时建好」实现）。
- **新建会话不落盘**：空会话没内容可存，列表里要靠前端乐观更新补上（Task 13 Step 1 注明）。
- 类型一致性过了一遍：`ChatMessage` / `SessionChat` / `ChatState`（Task 11 定义，Task 12/16 使用）、`McpServerSpec`（Task 4 定义，Task 5/6 使用）、`AgentRuntime`（Task 6 定义，Task 9 使用）、`RunnerDeps`（Task 8 定义，测试与 `makeDefaultRunnerDeps` 共用）、`DesktopSettings` / `SETTING_KEYS`（Task 3 定义，Task 15 使用）名称都对得上。

两处已知的、留给实现时验证的不确定项，都在对应步骤里写了排查方法：

- Electron 主进程的 ESM/CJS 产物格式（Task 1 Step 9）
- `projectRoot` 相对层数（Task 9 Step 5）
