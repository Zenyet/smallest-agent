# smallest-agent Stage 0 (裸循环) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个能真正跑起来的最小 agent：手写 `while` 循环，调用一个假工具 `get_weather`，把工具结果喂回模型，打印每一轮 trace，返回自然语言答案。

**Architecture:** agent 循环是纯逻辑，通过依赖注入接收 `callModel`，因此可以用「脚本化的假模型」做确定性单元测试（无需联网）。真实的 DeepSeek 调用隔离在 `src/llm.ts` 一个文件里（Vercel AI SDK 的 OpenAI-compatible provider），由 `pnpm dev` 端到端运行来验证。工具定义**不挂 `execute`**，让 SDK 把 tool-call 交还给我们自己执行——这是保持「看得见循环」的关键。

**Tech Stack:** TypeScript (ESM), Node 22 + pnpm 10, Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`), `zod`, `tsx`（运行）, `vitest`（测试）, `dotenv`（读 .env）。Provider: DeepSeek（OpenAI 兼容），全部走环境变量。

---

## 文件结构（Stage 0）

| 文件 | 职责 |
|------|------|
| `package.json` | 脚本与依赖 |
| `tsconfig.json` | TS ESM（`moduleResolution: bundler`，无扩展名导入） |
| `.gitignore` / `.env.example` | 忽略 node_modules/.env；env 模板 |
| `src/types.ts` | 共享类型：`Message` / `ToolCall` / `ModelResult` / `Tool` / `ToolRegistry` / `Config` |
| `src/config.ts` | `loadConfig(env)`：读取并校验环境变量，给默认值；`SYSTEM_PROMPT` |
| `src/tools/weather.ts` | 假工具 `get_weather`（zod 参数 + run） |
| `src/tools/index.ts` | 工具注册表 `tools` + `runTool(registry, name, args)` |
| `src/agent.ts` | `runAgent(userInput, deps)`：手写循环（依赖注入 callModel） |
| `src/trace.ts` | `formatTurn(info)` / `printTurn(info)`：每一轮可读输出 |
| `src/llm.ts` | `makeCallModel(config, registry)`：真实 DeepSeek 调用（仅此文件碰 SDK） |
| `cli.ts` | 读 argv → loadConfig → 组装依赖 → runAgent → 打印答案 |
| `README.md` | 6 阶段 × 18 概念可勾选学习地图 + 运行说明 |
| `tests/*.test.ts` | config / tools / agent / trace 的单元测试 |

**类型契约（所有任务共用，务必一致）：**

```ts
// src/types.ts
export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface Message {
  role: Role
  content: string
  toolCalls?: ToolCall[]   // 仅出现在「请求调用工具」的 assistant 消息上
  toolCallId?: string      // 仅出现在 tool 消息上（回答的是哪个 call）
  name?: string            // 工具名，仅出现在 tool 消息上
}

export interface ModelResult {
  text: string
  toolCalls: ToolCall[]
}

export interface Tool {
  name: string
  description: string
  parameters: unknown      // 一个 zod schema；在 llm.ts 里转成模型的 tool 定义
  run: (args: any) => unknown | Promise<unknown>
}
export type ToolRegistry = Record<string, Tool>

export interface Config {
  apiKey: string
  baseURL: string
  model: string
  temperature: number
  maxTurns: number
  systemPrompt: string
}
```

---

## Task 1: 项目脚手架与依赖

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "smallest-agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

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
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "cli.ts", "tests"]
}
```

- [ ] **Step 3: 写 `.gitignore`**

```
node_modules
.env
dist
```

- [ ] **Step 4: 写 `.env.example`**

```
DEEPSEEK_API_KEY=sk-xxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
TEMPERATURE=0
MAX_TURNS=10
```

- [ ] **Step 5: 安装依赖**

Run:
```bash
cd /Users/royzeng/lab/smallest-agent
pnpm add ai @ai-sdk/openai-compatible zod dotenv
pnpm add -D typescript tsx vitest @types/node
```
Expected: 安装成功，生成 `node_modules` 与 `pnpm-lock.yaml`，`package.json` 出现 `dependencies` / `devDependencies`。

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example pnpm-lock.yaml
git commit -m "chore: scaffold smallest-agent stage 0 (deps, tsconfig)"
```

---

## Task 2: 共享类型 + 配置 (`config.ts`)

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 写 `src/types.ts`**（内容见上方「类型契约」整块，原样写入）

- [ ] **Step 2: 写失败测试 `tests/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('throws when DEEPSEEK_API_KEY missing', () => {
    expect(() => loadConfig({})).toThrow(/DEEPSEEK_API_KEY/)
  })

  it('applies sensible defaults', () => {
    const c = loadConfig({ DEEPSEEK_API_KEY: 'k' })
    expect(c.baseURL).toBe('https://api.deepseek.com/v1')
    expect(c.model).toBe('deepseek-chat')
    expect(c.temperature).toBe(0)
    expect(c.maxTurns).toBe(10)
    expect(c.systemPrompt.length).toBeGreaterThan(0)
  })

  it('reads overrides from env', () => {
    const c = loadConfig({
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
      TEMPERATURE: '0.7',
      MAX_TURNS: '3',
    })
    expect(c.model).toBe('deepseek-reasoner')
    expect(c.temperature).toBe(0.7)
    expect(c.maxTurns).toBe(3)
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test config`
Expected: FAIL，报错类似 `Cannot find module '../src/config'`。

- [ ] **Step 4: 写实现 `src/config.ts`**

```ts
import type { Config } from './types'

export const SYSTEM_PROMPT =
  '你是一个简洁、诚实的中文助手。当需要外部信息（如天气）时调用提供的工具，不要凭空编造；信息足够时直接回答。'

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY（把 .env.example 复制成 .env 并填好）')
  }
  return {
    apiKey,
    baseURL: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    temperature: env.TEMPERATURE !== undefined ? Number(env.TEMPERATURE) : 0,
    maxTurns: env.MAX_TURNS !== undefined ? Number(env.MAX_TURNS) : 10,
    systemPrompt: SYSTEM_PROMPT,
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm test config`
Expected: PASS（3 个测试全绿）。

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: shared types and env-driven config"
```

---

## Task 3: 工具注册表与 `runTool` (`tools/`)

**Files:**
- Create: `src/tools/weather.ts`
- Create: `src/tools/index.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: 写失败测试 `tests/tools.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { weatherTool } from '../src/tools/weather'
import { runTool, tools } from '../src/tools/index'
import type { ToolRegistry } from '../src/types'

describe('weatherTool', () => {
  it('returns a fixed weather object for a city', () => {
    expect(weatherTool.run({ city: '北京' })).toEqual({
      city: '北京',
      temperature: 22,
      condition: '晴',
      unit: '°C',
    })
  })
})

describe('runTool', () => {
  it('runs a known tool and returns a JSON string', async () => {
    const out = await runTool(tools, 'get_weather', { city: '上海' })
    expect(JSON.parse(out)).toMatchObject({ city: '上海' })
  })

  it('returns error JSON for an unknown tool', async () => {
    const out = await runTool(tools, 'does_not_exist', {})
    expect(JSON.parse(out)).toHaveProperty('error')
  })

  it('catches errors thrown inside a tool and returns them as JSON', async () => {
    const reg: ToolRegistry = {
      boom: {
        name: 'boom',
        description: '',
        parameters: {},
        run: () => {
          throw new Error('kaboom')
        },
      },
    }
    const out = await runTool(reg, 'boom', {})
    expect(JSON.parse(out).error).toMatch(/kaboom/)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test tools`
Expected: FAIL，报错类似 `Cannot find module '../src/tools/weather'`。

- [ ] **Step 3: 写 `src/tools/weather.ts`**

```ts
import { z } from 'zod'
import type { Tool } from '../types'

export const weatherTool: Tool = {
  name: 'get_weather',
  description: '查询某个城市的当前天气。当用户询问某地天气时调用。',
  parameters: z.object({
    city: z.string().describe('城市名称，例如 北京'),
  }),
  run: (args: { city: string }) => ({
    city: args.city,
    temperature: 22,
    condition: '晴',
    unit: '°C',
  }),
}
```

- [ ] **Step 4: 写 `src/tools/index.ts`**

```ts
import type { ToolRegistry } from '../types'
import { weatherTool } from './weather'

export const tools: ToolRegistry = {
  [weatherTool.name]: weatherTool,
}

export async function runTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = registry[name]
  if (!tool) {
    return JSON.stringify({ error: `unknown tool: ${name}` })
  }
  try {
    const output = await tool.run(args)
    return JSON.stringify(output)
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm test tools`
Expected: PASS（4 个测试全绿）。

- [ ] **Step 6: Commit**

```bash
git add src/tools/weather.ts src/tools/index.ts tests/tools.test.ts
git commit -m "feat: tool registry, weather tool, and runTool with error capture"
```

---

## Task 4: agent 循环 (`agent.ts`)

**Files:**
- Create: `src/agent.ts`
- Test: `tests/agent.test.ts`

- [ ] **Step 1: 写失败测试 `tests/agent.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runAgent } from '../src/agent'
import type { Message, ModelResult, ToolRegistry } from '../src/types'

const tools: ToolRegistry = {
  get_weather: {
    name: 'get_weather',
    description: '',
    parameters: {},
    run: (a: { city: string }) => ({ city: a.city, temperature: 22 }),
  },
}
const config = { systemPrompt: 'sys', maxTurns: 5 }

describe('runAgent', () => {
  it('returns text in one turn when no tool is called', async () => {
    const callModel = vi.fn(async (): Promise<ModelResult> => ({ text: '你好！', toolCalls: [] }))
    const out = await runAgent('hi', { callModel, tools, config })
    expect(out).toBe('你好！')
    expect(callModel).toHaveBeenCalledTimes(1)
  })

  it('runs a tool, feeds the result back, then returns the final answer', async () => {
    const seen: Message[][] = []
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      seen.push(structuredClone(messages))
      if (callModel.mock.calls.length === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: '北京' } }] }
      }
      return { text: '北京今天 22 度。', toolCalls: [] }
    })
    const out = await runAgent('北京天气', { callModel, tools, config })
    expect(out).toBe('北京今天 22 度。')
    expect(callModel).toHaveBeenCalledTimes(2)
    const second = seen[1]
    const toolMsg = second.find((m) => m.role === 'tool')
    expect(toolMsg?.toolCallId).toBe('c1')
    expect(JSON.parse(toolMsg!.content)).toMatchObject({ city: '北京' })
  })

  it('throws after exceeding maxTurns when the model never finishes', async () => {
    const callModel = vi.fn(async (): Promise<ModelResult> => ({
      text: '',
      toolCalls: [{ id: 'x', name: 'get_weather', args: { city: '北京' } }],
    }))
    await expect(
      runAgent('loop', { callModel, tools, config: { systemPrompt: 's', maxTurns: 3 } }),
    ).rejects.toThrow(/maxTurns/)
    expect(callModel).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test agent`
Expected: FAIL，报错类似 `Cannot find module '../src/agent'`。

- [ ] **Step 3: 写实现 `src/agent.ts`**

```ts
import type { Config, Message, ModelResult, ToolRegistry } from './types'
import { runTool } from './tools/index'

export interface TurnInfo {
  turn: number
  result: ModelResult
  toolResults: { name: string; args: Record<string, unknown>; output: string }[]
}

export interface AgentDeps {
  callModel: (messages: Message[]) => Promise<ModelResult>
  tools: ToolRegistry
  config: Pick<Config, 'systemPrompt' | 'maxTurns'>
  onTurn?: (info: TurnInfo) => void
}

export async function runAgent(userInput: string, deps: AgentDeps): Promise<string> {
  const { callModel, tools, config, onTurn } = deps
  const messages: Message[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: userInput },
  ]

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    const result = await callModel(messages)
    messages.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
    })

    const toolResults: TurnInfo['toolResults'] = []

    if (result.toolCalls.length === 0) {
      onTurn?.({ turn, result, toolResults })
      return result.text
    }

    for (const call of result.toolCalls) {
      const output = await runTool(tools, call.name, call.args)
      messages.push({ role: 'tool', content: output, toolCallId: call.id, name: call.name })
      toolResults.push({ name: call.name, args: call.args, output })
    }
    onTurn?.({ turn, result, toolResults })
  }

  throw new Error(`Agent exceeded maxTurns (${config.maxTurns}) without finishing`)
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test agent`
Expected: PASS（3 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "feat: hand-written agent loop with injectable callModel"
```

---

## Task 5: trace 输出 (`trace.ts`)

**Files:**
- Create: `src/trace.ts`
- Test: `tests/trace.test.ts`

- [ ] **Step 1: 写失败测试 `tests/trace.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { formatTurn } from '../src/trace'

describe('formatTurn', () => {
  it('renders tool calls and tool results in a readable string', () => {
    const s = formatTurn({
      turn: 1,
      result: { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: '北京' } }] },
      toolResults: [{ name: 'get_weather', args: { city: '北京' }, output: '{"city":"北京"}' }],
    })
    expect(s).toContain('turn 1')
    expect(s).toContain('get_weather')
    expect(s).toContain('北京')
  })

  it('renders the assistant text when present', () => {
    const s = formatTurn({ turn: 2, result: { text: '搞定了', toolCalls: [] }, toolResults: [] })
    expect(s).toContain('搞定了')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test trace`
Expected: FAIL，报错类似 `Cannot find module '../src/trace'`。

- [ ] **Step 3: 写实现 `src/trace.ts`**

```ts
import type { TurnInfo } from './agent'

export function formatTurn(info: TurnInfo): string {
  const lines: string[] = [`── turn ${info.turn} ──`]
  if (info.result.text) lines.push(`🤖 ${info.result.text}`)
  for (const call of info.result.toolCalls) {
    lines.push(`🔧 调用 ${call.name}(${JSON.stringify(call.args)})`)
  }
  for (const tr of info.toolResults) {
    lines.push(`📦 ${tr.name} → ${tr.output}`)
  }
  return lines.join('\n')
}

export function printTurn(info: TurnInfo): void {
  console.log(formatTurn(info))
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test trace`
Expected: PASS（2 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/trace.ts tests/trace.test.ts
git commit -m "feat: human-readable per-turn trace"
```

---

## Task 6: 真实模型调用 (`llm.ts`)

> 说明：此文件是唯一接触 SDK / 网络的地方，**不写单元测试**（需要真实 API）。它的正确性由 Task 7 的 `pnpm dev` 端到端运行验证。Vercel AI SDK 的消息/工具结果具体字段在不同小版本可能有差异；若运行时报字段错误，以实际运行为准微调 `toSdkMessages` 与返回字段（这正是"看见协议"的学习点）。

**Files:**
- Create: `src/llm.ts`

- [ ] **Step 1: 写实现 `src/llm.ts`**

```ts
import { generateText, tool } from 'ai'
import type { ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { Config, Message, ModelResult, ToolRegistry } from './types'

// 内部 Message[] -> Vercel AI SDK 的 ModelMessage[]（在这里"看见"消息协议）
function toSdkMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'system') return { role: 'system', content: m.content }
    if (m.role === 'user') return { role: 'user', content: m.content }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId!,
            toolName: m.name!,
            output: { type: 'text', value: m.content },
          },
        ],
      }
    }
    // assistant
    if (m.toolCalls && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args,
          })),
        ],
      }
    }
    return { role: 'assistant', content: m.content }
  })
}

export function makeCallModel(config: Config, registry: ToolRegistry) {
  const provider = createOpenAICompatible({
    name: 'deepseek',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  })
  const model = provider(config.model)

  // 关键：tool() 不挂 execute，SDK 只把 tool-call 交还给我们，由 agent 循环自己执行
  const sdkTools = Object.fromEntries(
    Object.values(registry).map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.parameters as any }),
    ]),
  )

  return async function callModel(messages: Message[]): Promise<ModelResult> {
    const result = await generateText({
      model,
      temperature: config.temperature,
      messages: toSdkMessages(messages),
      tools: sdkTools,
    })
    return {
      text: result.text ?? '',
      toolCalls: result.toolCalls.map((tc: any) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        args: (tc.input ?? tc.args ?? {}) as Record<string, unknown>,
      })),
    }
  }
}
```

- [ ] **Step 2: 类型检查通过**

Run: `pnpm typecheck`
Expected: 无类型错误（若 SDK 类型对某字段报错，按运行实际微调后再次 `pnpm typecheck` 直到通过）。

- [ ] **Step 3: Commit**

```bash
git add src/llm.ts
git commit -m "feat: real DeepSeek callModel via AI SDK (manual-loop, no execute)"
```

---

## Task 7: CLI 接线 + README + 端到端验证

**Files:**
- Create: `cli.ts`
- Create: `README.md`

- [ ] **Step 1: 写 `cli.ts`**

```ts
import 'dotenv/config'
import { loadConfig } from './src/config'
import { tools } from './src/tools/index'
import { makeCallModel } from './src/llm'
import { runAgent } from './src/agent'
import { printTurn } from './src/trace'

async function main() {
  const question = process.argv.slice(2).join(' ').trim()
  if (!question) {
    console.error('用法: pnpm dev "你的问题"')
    process.exit(1)
  }
  const config = loadConfig()
  const callModel = makeCallModel(config, tools)
  const answer = await runAgent(question, { callModel, tools, config, onTurn: printTurn })
  console.log('\n=== 最终回答 ===')
  console.log(answer)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: 写 `README.md`**

````markdown
# smallest-agent

用一个最小但能真正跑起来的 agent，把 18 个 AI 工程核心概念串成一条线，基于代码动手学习。
方法论：**先跑通最小例子，再理解原理**。核心就是一个手写的 `while` 循环——每个概念都是「在循环的某个位置加一段代码」。

## 运行

```bash
pnpm install
cp .env.example .env   # 填入 DeepSeek 的 key / baseURL / model
pnpm dev "北京天气怎么样"
pnpm test              # 跑单元测试
```

## Stage 0 在做什么

一个手写 agent 循环（`src/agent.ts`）：调模型 → 若要调工具则执行并把结果喂回 → 否则返回答案。
工具定义不挂 `execute`，所以 SDK 把 tool-call 交还给我们自己执行——循环看得见。

## 6 阶段 × 18 概念 学习地图

### 阶段 0 — 裸循环 ✅
- [x] 提示词工程（`SYSTEM_PROMPT`）
- [x] 上下文工程（`messages` 数组）
- [x] 温度等参数（`config.temperature`）
- [x] 工具调用 / 工具定义（`tools/` + `runTool`）
- [x] 模型选型（`llm.ts`，env 驱动）
- [x] 模型底层 / 优势局限（trace 里观察）

### 阶段 1 — 真工具 + RAG
- [ ] RAG（`search_notes` 工具）
- [ ] embedding / 向量检索

### 阶段 2 — 记忆 + 上下文管理
- [ ] 记忆（持久化 `messages`）
- [ ] 上下文压缩

### 阶段 3 — MCP + Skills
- [ ] MCP（工具改为动态加载）
- [ ] Skills

### 阶段 4 — 生产化
- [ ] 缓存 / 省 token
- [ ] 降延迟（streaming）
- [ ] 限流降级（try-catch / fallback）
- [ ] 降幻觉（引用强制 + verifier）

### 阶段 5 — Eval Harness
- [ ] 测试体系 / Eval
- [ ] 微调（认知 + 可替换 llm 接口）

## 结构

```
src/agent.ts   循环本体
src/llm.ts     真实模型调用（仅此文件碰 SDK）
src/tools/     工具注册表 + 假工具
src/config.ts  env 驱动配置
src/trace.ts   每一轮可读输出
cli.ts         入口
```
````

- [ ] **Step 3: 全量测试 + 类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部测试 PASS（config 3 + tools 4 + agent 3 + trace 2 = 12），无类型错误。

- [ ] **Step 4: 端到端验证（需要真实 DeepSeek key）**

前置：确认 `.env` 已填好可用的 `DEEPSEEK_API_KEY`（及 baseURL/model）。

Run: `pnpm dev "北京天气怎么样"`
Expected:
- 终端打印至少一轮 trace，其中包含 `🔧 调用 get_weather({"city":"北京"})` 与 `📦 get_weather → {...}`；
- 最后 `=== 最终回答 ===` 是一句包含天气信息的自然语言。

Run: `pnpm dev "你好，简单介绍下你自己"`
Expected: 不调用任何工具，一轮内直接返回自然语言答案（trace 里没有 `🔧`）。

> 若端到端运行报 SDK 字段/格式错误：只改 `src/llm.ts` 的 `toSdkMessages` 或返回字段映射，重跑直到两条命令都符合预期。**不要**改 `agent.ts`/`tools`/`config` 的契约。

- [ ] **Step 5: Commit**

```bash
git add cli.ts README.md
git commit -m "feat: CLI entrypoint and README learning map; stage 0 runnable"
```

---

## Self-Review（已核对）

**Spec coverage（对照 spec 第 7 节 Stage 0）：**
- 模块职责 config/llm/tools/trace/agent/cli → Task 2/6/3/5/4/7 ✓
- 数据流（cli→agent→callModel→toolCalls→回填→再调） → Task 4 循环 + Task 7 接线 ✓
- 错误处理：maxTurns 上限（Task 4 测试3）、工具 try-catch 回填（Task 3 测试3）、缺 env 即报错（Task 2 测试1） ✓
- 验收标准 1（pnpm install）→ Task 1；2（调工具闭环）→ Task 7 Step4；3（trace 可见）→ Task 5 + Task 7 Step4；4（无工具问题一轮结束）→ Task 7 Step4 第二条；5（README 清单）→ Task 7 Step2 ✓
- 6 个 stage-0 概念全部落到代码位置（见 README 地图） ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤都给了完整代码与确切命令。`llm.ts` 明确标注「由端到端运行验证、不写单测」并给出完整实现，非占位。

**Type consistency：** `Message`/`ToolCall`/`ModelResult`/`Tool`/`ToolRegistry`/`Config` 定义于 `src/types.ts`，在 config/tools/agent/llm/trace/测试中签名一致；`runAgent(userInput, deps)`、`runTool(registry, name, args)`、`makeCallModel(config, registry)`、`callModel(messages)`、`formatTurn(info)`/`printTurn(info)` 在计划全程命名一致。`TurnInfo` 定义于 `agent.ts`，被 `trace.ts`（type-only）与测试引用，无运行时循环依赖。
