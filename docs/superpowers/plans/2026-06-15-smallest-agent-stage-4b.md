# smallest-agent Stage 4b (降延迟 streaming + 降幻觉 verifier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** （1）降延迟：用 `streamText` 把最终答案逐字流式打印（首字更快）。（2）降幻觉：system prompt 要求引用来源 + 一个 **LLM-as-Judge verifier**——答案产出后用另一个 LLM 核查它是否被检索/工具证据支撑，没支撑就警告。

**Architecture:** 流式是 SDK 边界：`makeCallModel(config, registry, onText?)` 多一个可选 `onText`，给了就走 `streamText` 把文本增量喂给 `onText`，否则维持 `generateText`——对包装层（retry/fallback/cache）透明，缓存命中时不流式（直接返回）。verifier 是纯逻辑 + 可注入裁判：`makeVerifier(callModel)`，`parseVerdict` 纯函数；cli 用 `onTurn` 累积工具证据，答案产出后跑裁判。citation 靠改 SYSTEM_PROMPT。

**Tech Stack:** 沿用，无新依赖（用 `ai` 的 `streamText`）。

---

## 文件结构（Stage 4b）

| 文件 | 职责 | 测试 |
|------|------|------|
| `src/types.ts`（改） | Config 增 `stream: boolean` | — |
| `src/config.ts`（改） | `STREAM` env；SYSTEM_PROMPT 加引用来源要求 | config.test 增断言 |
| `.env.example`（改） | `STREAM` | — |
| `src/trace.ts`（改） | `formatTurn`/`printTurn` 加 `{ showText? }`（流式时不在 trace 里重复打印答案） | trace.test 增 1 例 |
| `src/verify.ts`（新） | `Verdict` + `parseVerdict` + `makeVerifier(callModel)` | verify.test.ts |
| `src/llm.ts`（改） | `makeCallModel(config, registry, onText?)` 流式分支 | 无单测，真机验证 |
| `cli.ts`（改） | 流式 onText + 证据累积 + 跑 verifier | 真机验证 |
| `README.md`（改） | 勾选 4b 概念 | — |

---

## Task 1: config（stream + 引用来源）+ trace（showText）

**Files:** Modify `src/types.ts`, `src/config.ts`, `.env.example`, `src/trace.ts`; Test `tests/config.test.ts`, `tests/trace.test.ts`

- [ ] **Step 1: `src/types.ts`** —— `Config` 接口在 `cacheDir: string` 之后加：
```ts
  stream: boolean            // 是否流式打印最终答案
```

- [ ] **Step 2: 改 `tests/config.test.ts`**，在 `it('applies sensible defaults', ...)` 末尾追加：
```ts
    expect(c.stream).toBe(true)
    expect(c.systemPrompt).toContain('来源')
```

- [ ] **Step 3: 运行 `pnpm test config` 确认失败。**

- [ ] **Step 4: `src/config.ts`** ——（a）把 `SYSTEM_PROMPT` 改成（追加引用要求）：
```ts
export const SYSTEM_PROMPT =
  '你是一个简洁、诚实的中文助手。当需要外部信息（如天气、笔记）时调用提供的工具，不要凭空编造；信息足够时直接回答。' +
  '当回答用到 search_notes 或读取文件得到的内容时，在末尾注明来源文件名（如：来源：01-rag.md）。'
```
（b）在 `loadConfig` 返回对象 `cacheDir: ...,` 之后加：
```ts
    stream: env.STREAM !== '0',
```

- [ ] **Step 5: `.env.example` 末尾追加**
```
# 流式输出最终答案：设 0 关闭
STREAM=1
```

- [ ] **Step 6: 运行 `pnpm test config` 确认通过。**

- [ ] **Step 7: 改 `tests/trace.test.ts`** —— 追加一个用例：
```ts
  it('omits the assistant text when showText is false', () => {
    const s = formatTurn(
      { turn: 1, result: { text: '机密答案', toolCalls: [] }, toolResults: [] },
      { showText: false },
    )
    expect(s).not.toContain('机密答案')
    expect(s).toContain('turn 1')
  })
```

- [ ] **Step 8: 运行 `pnpm test trace` 确认新用例失败。**

- [ ] **Step 9: 用以下完整内容替换 `src/trace.ts`**
```ts
import type { TurnInfo } from './agent'

export function formatTurn(info: TurnInfo, opts: { showText?: boolean } = {}): string {
  const showText = opts.showText ?? true
  const lines: string[] = [`── turn ${info.turn} ──`]
  if (showText && info.result.text) lines.push(`🤖 ${info.result.text}`)
  for (const call of info.result.toolCalls) {
    lines.push(`🔧 调用 ${call.name}(${JSON.stringify(call.args)})`)
  }
  for (const tr of info.toolResults) {
    lines.push(`📦 ${tr.name} → ${tr.output}`)
  }
  return lines.join('\n')
}

export function printTurn(info: TurnInfo, opts: { showText?: boolean } = {}): void {
  console.log(formatTurn(info, opts))
}
```

- [ ] **Step 10: 运行 `pnpm test trace && pnpm test config && pnpm typecheck` 确认全绿。**

- [ ] **Step 11: Commit**
```bash
git add src/types.ts src/config.ts .env.example src/trace.ts tests/config.test.ts tests/trace.test.ts
git commit -m "feat: stream config + citation prompt + trace showText option"
```

---

## Task 2: verifier `src/verify.ts`（LLM-as-Judge）

**Files:** Create `src/verify.ts`; Test `tests/verify.test.ts`

- [ ] **Step 1: 写失败测试 `tests/verify.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest'
import { parseVerdict, makeVerifier } from '../src/verify'
import type { Message, ModelResult } from '../src/types'

describe('parseVerdict', () => {
  it('parses a clean JSON verdict', () => {
    expect(parseVerdict('{"grounded": true, "issues": []}')).toEqual({ grounded: true, issues: [] })
  })
  it('extracts JSON embedded in surrounding text', () => {
    const v = parseVerdict('判断：{"grounded": false, "issues": ["X 没有依据"]} 完')
    expect(v.grounded).toBe(false)
    expect(v.issues).toEqual(['X 没有依据'])
  })
  it('returns not-grounded on unparseable output', () => {
    const v = parseVerdict('我不知道')
    expect(v.grounded).toBe(false)
    expect(v.issues.length).toBeGreaterThan(0)
  })
})

describe('makeVerifier', () => {
  it('sends evidence + answer to the judge and returns the parsed verdict', async () => {
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      expect(messages.at(-1)!.content).toContain('北京今天 22 度')
      return { text: '{"grounded": true, "issues": []}', toolCalls: [] }
    })
    const verify = makeVerifier(callModel)
    const v = await verify({
      question: '北京天气',
      answer: '北京今天 22 度',
      evidence: ['get_weather: {"temperature":22}'],
    })
    expect(v.grounded).toBe(true)
    expect(callModel).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行 `pnpm test verify` 确认失败。**

- [ ] **Step 3: 写 `src/verify.ts`**
```ts
import type { CallModel } from './types'

export interface Verdict {
  grounded: boolean
  issues: string[]
}

export function parseVerdict(text: string): Verdict {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    const obj = JSON.parse(m ? m[0] : text) as { grounded?: unknown; issues?: unknown }
    return {
      grounded: Boolean(obj.grounded),
      issues: Array.isArray(obj.issues) ? obj.issues.map((x) => String(x)) : [],
    }
  } catch {
    return { grounded: false, issues: ['无法解析裁判输出'] }
  }
}

export interface VerifyInput {
  question: string
  answer: string
  evidence: string[]
}

export function makeVerifier(callModel: CallModel): (input: VerifyInput) => Promise<Verdict> {
  return async ({ question, answer, evidence }) => {
    const prompt =
      `问题：${question}\n\n` +
      `证据（工具/检索返回，只能依据这些）：\n${evidence.join('\n---\n')}\n\n` +
      `待核查答案：\n${answer}\n\n` +
      `判断答案是否被上述证据支撑。只输出 JSON：{"grounded": true 或 false, "issues": ["未被证据支撑的说法", ...]}`
    const result = await callModel([
      {
        role: 'system',
        content: '你是严格的事实核查裁判。只依据给定证据判断，不要用自己的知识补充。只输出 JSON。',
      },
      { role: 'user', content: prompt },
    ])
    return parseVerdict(result.text)
  }
}
```

- [ ] **Step 4: 运行 `pnpm test verify` 确认通过（4）。**

- [ ] **Step 5: Commit**
```bash
git add src/verify.ts tests/verify.test.ts
git commit -m "feat: LLM-as-Judge groundedness verifier (parseVerdict + makeVerifier)"
```

---

## Task 3: streaming in `src/llm.ts`（SDK 边界，无单测）

**Files:** Modify `src/llm.ts`

- [ ] **Step 1: 改 `src/llm.ts`** ——（a）import 加 `streamText`、类型加 `CallModel`/`ToolCall`：
```ts
import { generateText, streamText, tool } from 'ai'
```
并确保从 `./types` 导入了 `CallModel` 与 `ToolCall`（连同已有的 `Config, Message, ModelResult, ToolRegistry`）。
（b）把 `makeCallModel` 改成接收可选 `onText` 并在给了时走流式。完整替换 `makeCallModel`：
```ts
export function makeCallModel(
  config: Config,
  registry: ToolRegistry,
  onText?: (delta: string) => void,
): CallModel {
  const provider = createOpenAICompatible({
    name: 'deepseek',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  })
  const model = provider(config.model)

  const sdkTools = Object.fromEntries(
    Object.values(registry).map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: t.parameters as any }),
    ]),
  )

  const mapToolCalls = (toolCalls: any[]): ToolCall[] =>
    toolCalls.map((tc) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      args: (tc.input ?? {}) as Record<string, unknown>,
    }))

  return async (messages: Message[]): Promise<ModelResult> => {
    const sdkMessages = toSdkMessages(messages)
    if (onText) {
      const result = streamText({
        model,
        temperature: config.temperature,
        messages: sdkMessages,
        tools: sdkTools,
      })
      for await (const delta of result.textStream) onText(delta)
      return { text: await result.text, toolCalls: mapToolCalls(await result.toolCalls) }
    }
    const result = await generateText({
      model,
      temperature: config.temperature,
      messages: sdkMessages,
      tools: sdkTools,
    })
    return { text: result.text ?? '', toolCalls: mapToolCalls(result.toolCalls) }
  }
}
```
（保留文件里原有的 `toSdkMessages` 函数不动。）

- [ ] **Step 2: 类型检查**
Run: `pnpm typecheck`
Expected: 干净。若 v6 的 `streamText` 的 `textStream` / `await result.toolCalls` / `await result.text` 字段名或形态不同，仅在此文件按实际微调（SDK 边界，等同 generateText 当初的处理）直到 `pnpm typecheck` 通过。`pnpm test` 应仍是全绿（没有针对 llm.ts 的单测）。

- [ ] **Step 3: Commit**
```bash
git add src/llm.ts
git commit -m "feat: optional streaming in makeCallModel (streamText when onText given)"
```

---

## Task 4: CLI 接线（流式 + 证据 + verifier）+ README + 验证

**Files:** Modify `cli.ts`, `README.md`

- [ ] **Step 1: 用以下完整内容替换 `cli.ts`**
```ts
import 'dotenv/config'
import { loadConfig } from './src/config'
import type { Message, CallModel } from './src/types'
import { makeSearchNotesTool } from './src/tools/searchNotes'
import { makeEmbedder } from './src/rag/embed'
import { buildNotesIndex } from './src/rag/index'
import { makeCallModel } from './src/llm'
import { withRetry, withFallback } from './src/resilience'
import { createDiskCache, withCache } from './src/cache'
import { runAgent, type TurnInfo } from './src/agent'
import { printTurn } from './src/trace'
import { createJsonSessionStore } from './src/memory/store'
import { makeSummarizer } from './src/memory/summarize'
import { compactMessages } from './src/memory/compact'
import { loadMcpToolsFromServers } from './src/mcp/client'
import { makeVerifier } from './src/verify'

async function main() {
  const question = process.argv.slice(2).join(' ').trim()
  if (!question) {
    console.error('用法: pnpm dev "你的问题"')
    process.exit(1)
  }
  const config = loadConfig()

  console.error('加载 embedding 模型并构建笔记索引…')
  const embed = await makeEmbedder(config)
  const store = await buildNotesIndex({ notesDir: config.notesDir, embed })
  console.error(`索引完成：${store.size} 个片段`)

  console.error('连接 MCP server，发现工具…')
  const fsDir = process.env.MCP_FS_DIR ?? './notes'
  const mcp = await loadMcpToolsFromServers([
    { command: 'npx', args: ['tsx', 'mcp-server.ts'] },
    { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', fsDir] },
  ])
  try {
    const mcpTools = mcp.tools
    console.error(`MCP 工具：${Object.keys(mcpTools).join(', ')}`)
    const searchTool = makeSearchNotesTool({ store, embed })
    const registry = { ...mcpTools, [searchTool.name]: searchTool }

    // 降延迟：流式打印（缓存命中时不会触发，base 不被调用）
    let streamed = false
    const onText = (delta: string) => {
      streamed = true
      process.stdout.write(delta)
    }

    // 限流降级 + 缓存（每个模型各自缓存）
    const cache = config.cacheEnabled ? createDiskCache(config.cacheDir) : undefined
    const buildCallModel = (model: string): CallModel => {
      let cm: CallModel = withRetry(
        makeCallModel({ ...config, model }, registry, config.stream ? onText : undefined),
        { retries: config.maxRetries },
      )
      if (cache) cm = withCache(cm, cache, model, () => console.error('🟢 LLM 缓存命中（省 token）'))
      return cm
    }
    const primary = buildCallModel(config.model)
    const callModel: CallModel =
      config.fallbackModel === config.model
        ? primary
        : withFallback(primary, buildCallModel(config.fallbackModel), (err) =>
            console.error(
              `主模型失败，降级到 ${config.fallbackModel}：${err instanceof Error ? err.message : err}`,
            ),
          )

    // 记忆 + 压缩
    const sessions = createJsonSessionStore(config.sessionsDir)
    const history = await sessions.load(config.sessionId)
    if (history.length) console.error(`已载入会话「${config.sessionId}」的 ${history.length} 条历史`)
    const summarize = makeSummarizer(makeCallModel(config, {}))
    const compact = (messages: Message[]) =>
      compactMessages(messages, {
        maxTokens: config.maxContextTokens,
        keepRecent: config.keepRecent,
        summarize,
      })
    const onComplete = async (messages: Message[]) => {
      await sessions.save(config.sessionId, messages.filter((m) => m.role !== 'system'))
    }

    // 降幻觉：累积工具证据；流式时不在 trace 里重复打印答案文本
    const evidence: string[] = []
    const onTurn = (info: TurnInfo) => {
      printTurn(info, { showText: !config.stream })
      for (const tr of info.toolResults) evidence.push(`${tr.name}: ${tr.output}`)
    }

    if (config.stream) console.error('（流式输出，最终答案逐字出现）')
    const answer = await runAgent(question, {
      callModel,
      tools: registry,
      config,
      onTurn,
      history,
      compact,
      onComplete,
    })

    if (streamed) process.stdout.write('\n')
    else {
      console.log('\n=== 最终回答 ===')
      console.log(answer)
    }

    // 降幻觉：LLM-as-Judge 核查答案是否被证据支撑
    if (evidence.length > 0) {
      const verdict = await makeVerifier(makeCallModel(config, {}))({ question, answer, evidence })
      if (verdict.grounded) {
        console.error('\n✅ 核查：答案被证据支撑')
      } else {
        console.error('\n⚠️ 核查：答案可能有未被证据支撑的说法：')
        for (const issue of verdict.issues) console.error(`  - ${issue}`)
      }
    }
  } finally {
    await mcp.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: README** ——（a）「### 阶段 4 — 生产化」整段替换为：
```
### 阶段 4 — 生产化 ✅
- [x] 缓存 / 省 token（withCache，磁盘缓存）
- [x] 限流降级（withRetry 指数退避 + withFallback 切备用模型）
- [x] 降延迟（streamText 流式打印最终答案）
- [x] 降幻觉（引用来源 + LLM-as-Judge verifier 核查）
```
（b）在「## Stage 4a 在做什么」之后新增：
```
## Stage 4b 在做什么

- 降延迟：`makeCallModel(config, registry, onText)` 给了 `onText` 就走 `streamText`，最终答案逐字出现；对 retry/fallback/cache 透明（缓存命中不流式）。`STREAM=0` 关闭。
- 降幻觉：system prompt 要求用到检索/文件内容时注明来源文件名；答案产出后，`makeVerifier`（LLM-as-Judge）拿「问题 + 工具证据 + 答案」让另一个 LLM 判断答案是否被证据支撑，不支撑就打印 ⚠️ 及问题清单。

> 试试：`pnpm dev "根据我的笔记，chunking 为什么重要？"`——答案逐字出现、末尾带（来源：01-rag.md），随后一行 ✅ 核查。
> 故意诱导幻觉：`pnpm dev "根据我的笔记，介绍一下 Rust 的所有权"`（笔记里没有）——看裁判会不会标 ⚠️。
```
（c）「## 结构」追加一行：
```
src/verify.ts      LLM-as-Judge 证据核查（降幻觉）
```

- [ ] **Step 3: 全量测试 + 类型检查**
Run: `pnpm test && pnpm typecheck`
Expected: 58（4a 末）+ verify 4 + trace 1 = 63 个测试通过，typecheck 干净。

- [ ] **Step 4: Commit**
```bash
git add cli.ts README.md
git commit -m "feat: wire streaming + groundedness verifier into CLI; stage 4b runnable"
```

- [ ] **Step 5: 真机端到端（留给用户，需 DeepSeek key）**
```bash
pnpm dev "根据我的笔记，RAG 里 chunking 为什么重要？"
```
Expected：最终答案**逐字出现**、末尾注明来源（如 来源：01-rag.md），随后 stderr 打印 `✅ 核查：答案被证据支撑`。
```bash
pnpm dev "根据我的笔记，讲讲 Rust 所有权机制"
```
Expected：笔记里没有该内容，裁判应打印 `⚠️ 核查：...` 列出未被证据支撑的说法（演示降幻觉）。`STREAM=0 pnpm dev "..."` 则回到「=== 最终回答 ===」整段打印。

---

## Self-Review（已核对）

**Spec coverage：** Stage 4b = 降延迟 + 降幻觉。降延迟 = llm.ts 流式(Task3) + cli onText(Task4) + trace showText(Task1)。降幻觉 = SYSTEM_PROMPT 引用(Task1) + verify.ts LLM-as-Judge(Task2) + cli 证据累积与裁判调用(Task4)。

**Placeholder scan：** 无 TBD/TODO。llm.ts 流式是 SDK 边界、明确标注真机/typecheck 验证并给完整实现；verifier 逻辑用假 callModel 单测。

**Type consistency：** `makeCallModel(config, registry, onText?)` 向后兼容（既有无 onText 调用走 generateText 不变；summarizer/verifier 用无 onText 版本）。`CallModel`/`ModelResult`/`ToolCall` 复用 types.ts。`Verdict`/`parseVerdict`/`makeVerifier(callModel)`/`VerifyInput` 全程一致。`formatTurn`/`printTurn` 新增可选 `{ showText? }`，默认 true，既有调用与测试不破；cli 用 `{ showText: !config.stream }`。`TurnInfo` 从 agent.ts 导入。Config 新增 `stream` 不影响 agent 的 `Pick<Config,'systemPrompt'|'maxTurns'>`。证据由 `onTurn(info).toolResults` 累积，answer 来自 `runAgent` 返回值，裁判用独立的无工具 callModel。
