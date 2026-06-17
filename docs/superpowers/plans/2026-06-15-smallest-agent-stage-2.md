# smallest-agent Stage 2 (记忆 + 上下文压缩) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 跨会话记得历史（JSON 文件持久化 messages），并在历史超过 token 预算时用 LLM 把较老的消息摘要压缩。`pnpm dev "我叫 Roy"` → 再 `pnpm dev "我叫啥"` 能答上来。

**Architecture:** 向后兼容地给 `runAgent` 加三个可选注入：`history`（开局塞入的旧消息）、`compact`（开局前压一次）、`onComplete`（跑完拿到完整消息去持久化）。不传就是 Stage 0/1 老行为，现有测试不破。记忆 = JSON 文件 session store；压缩 = 估算 token，超预算就把 system 与最近 K 条之间的老消息用 LLM 摘成一条。store/compact/summarize 全部用假依赖做确定性单测；真实摘要复用 `makeCallModel`（无工具）。

**Tech Stack:** 沿用 Stage 0/1（TS ESM、vitest、tsx、DeepSeek、transformers.js）。本阶段无新依赖。

---

## 文件结构（Stage 2）

| 文件 | 职责 | 测试 |
|------|------|------|
| `src/types.ts`（改） | Config 增 `sessionId` / `sessionsDir` / `maxContextTokens` / `keepRecent` | — |
| `src/config.ts`（改） | loadConfig 读 4 个新 env，给默认值 | config.test.ts 增断言 |
| `.env.example` / `.gitignore`（改） | 新 env 模板；忽略 `.sessions` | — |
| `src/memory/store.ts` | `createJsonSessionStore(dir)` → `load/save` | store.test.ts（临时目录） |
| `src/memory/compact.ts` | `estimateTokens` + `compactMessages`（注入 summarize） | compact.test.ts（假 summarize） |
| `src/memory/summarize.ts` | `makeSummarizer(callModel)` → 渲染对话调模型出摘要 | summarize.test.ts（假 callModel） |
| `src/agent.ts`（改） | AgentDeps 加 `history` / `compact` / `onComplete`，开局 seed + 压一次 + 收尾回调 | agent.test.ts 增 3 个用例 |
| `cli.ts`（改） | 接线 store + summarizer + compact，按 SESSION_ID 读写 | 真机验证 |
| `README.md`（改） | 勾选 Stage 2 概念 | — |

**Summarize 类型（compact.ts 导出，summarize.ts 实现该签名）：**
```ts
export type Summarize = (messages: Message[]) => Promise<string>
```

---

## Task 1: 扩展 config

**Files:** Modify `src/types.ts`, `src/config.ts`, `.env.example`, `.gitignore`; Test `tests/config.test.ts`

- [ ] **Step 1: `src/types.ts` 的 `Config` 接口加 4 个字段**（在 `localModelPath?` 之后）
```ts
  sessionId: string          // 会话标识；不同 id 互不干扰
  sessionsDir: string        // 会话 JSON 文件目录
  maxContextTokens: number   // 历史超过这个估算 token 数就压缩
  keepRecent: number         // 压缩时保留的最近消息条数
```

- [ ] **Step 2: `.gitignore` 末尾追加一行**
```
.sessions
```

- [ ] **Step 3: 改 `tests/config.test.ts`，在 `it('applies sensible defaults', ...)` 末尾追加**
```ts
    expect(c.sessionId).toBe('default')
    expect(c.sessionsDir).toBe('./.sessions')
    expect(c.maxContextTokens).toBe(2000)
    expect(c.keepRecent).toBe(6)
```

- [ ] **Step 4: 运行 `pnpm test config` 确认失败**（sessionId undefined）。

- [ ] **Step 5: 改 `src/config.ts`，在 return 对象 `localModelPath: env.LOCAL_MODEL_PATH,` 之后加**
```ts
    sessionId: env.SESSION_ID ?? 'default',
    sessionsDir: env.SESSIONS_DIR ?? './.sessions',
    maxContextTokens: numFromEnv(env.MAX_CONTEXT_TOKENS, 2000, 'MAX_CONTEXT_TOKENS'),
    keepRecent: numFromEnv(env.KEEP_RECENT, 6, 'KEEP_RECENT'),
```

- [ ] **Step 6: `.env.example` 末尾追加**
```
# 记忆 + 上下文压缩
SESSION_ID=default
# SESSIONS_DIR=./.sessions
# 历史超过这个估算 token 数就触发 LLM 摘要压缩（想看压缩效果可调小，如 50）
MAX_CONTEXT_TOKENS=2000
# 压缩时保留的最近消息条数
KEEP_RECENT=6
```

- [ ] **Step 7: 运行 `pnpm test config && pnpm typecheck` 确认通过；再 `pnpm test` 确认 30 个仍全绿。**

- [ ] **Step 8: Commit**
```bash
git add src/types.ts src/config.ts .env.example .gitignore tests/config.test.ts
git commit -m "feat: add session + compaction config (sessionId, maxContextTokens, keepRecent)"
```

---

## Task 2: 会话存储 `memory/store.ts`

**Files:** Create `src/memory/store.ts`; Test `tests/store-session.test.ts`

- [ ] **Step 1: 写失败测试 `tests/store-session.test.ts`**
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonSessionStore } from '../src/memory/store'
import type { Message } from '../src/types'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-sessions-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createJsonSessionStore', () => {
  it('returns [] for an unknown session', async () => {
    expect(await createJsonSessionStore(dir).load('nope')).toEqual([])
  })

  it('round-trips messages through save/load', async () => {
    const store = createJsonSessionStore(dir)
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]
    await store.save('s1', msgs)
    expect(await store.load('s1')).toEqual(msgs)
  })

  it('sanitizes the session id so it cannot escape the directory', async () => {
    const store = createJsonSessionStore(dir)
    await store.save('../evil', [{ role: 'user', content: 'x' }])
    expect(await store.load('../evil')).toEqual([{ role: 'user', content: 'x' }])
  })
})
```

- [ ] **Step 2: 运行 `pnpm test store-session` 确认失败。**

- [ ] **Step 3: 写 `src/memory/store.ts`**
```ts
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Message } from '../types'

export interface SessionStore {
  load(sessionId: string): Promise<Message[]>
  save(sessionId: string, messages: Message[]): Promise<void>
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function createJsonSessionStore(dir: string): SessionStore {
  const baseDir = resolve(dir)
  const fileFor = (id: string) => join(baseDir, `${safeId(id)}.json`)
  return {
    async load(sessionId) {
      const file = fileFor(sessionId)
      if (!existsSync(file)) return []
      return JSON.parse(await readFile(file, 'utf8')) as Message[]
    },
    async save(sessionId, messages) {
      await mkdir(baseDir, { recursive: true })
      await writeFile(fileFor(sessionId), JSON.stringify(messages, null, 2), 'utf8')
    },
  }
}
```

- [ ] **Step 4: 运行 `pnpm test store-session` 确认通过（3）。**

- [ ] **Step 5: Commit**
```bash
git add src/memory/store.ts tests/store-session.test.ts
git commit -m "feat: JSON file session store for cross-run memory"
```

---

## Task 3: 压缩 `memory/compact.ts`

**Files:** Create `src/memory/compact.ts`; Test `tests/compact.test.ts`

- [ ] **Step 1: 写失败测试 `tests/compact.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest'
import { estimateTokens, compactMessages } from '../src/memory/compact'
import type { Message } from '../src/types'

const x = (n: number) => 'x'.repeat(n)

describe('estimateTokens', () => {
  it('approximates chars / 4', () => {
    expect(estimateTokens([{ role: 'user', content: x(40) }])).toBe(10)
  })
})

describe('compactMessages', () => {
  it('returns messages unchanged when under budget', async () => {
    const summarize = vi.fn(async () => 'S')
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'hi' },
    ]
    expect(await compactMessages(msgs, { maxTokens: 1000, keepRecent: 4, summarize })).toEqual(msgs)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('summarizes older messages when over budget, keeping system + recent', async () => {
    const summarize = vi.fn(async () => '摘要内容')
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: x(100) },
      { role: 'assistant', content: x(100) },
      { role: 'user', content: x(100) },
      { role: 'assistant', content: 'recent' },
    ]
    const out = await compactMessages(msgs, { maxTokens: 1, keepRecent: 1, summarize })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(out[0]).toEqual({ role: 'system', content: 's' })
    expect(out[1].content).toContain('摘要内容')
    expect(out.at(-1)).toEqual({ role: 'assistant', content: 'recent' })
    expect(out.length).toBeLessThan(msgs.length)
  })

  it('does nothing if there are no older messages to summarize', async () => {
    const summarize = vi.fn(async () => 'S')
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: x(100) },
    ]
    const out = await compactMessages(msgs, { maxTokens: 1, keepRecent: 4, summarize })
    expect(out).toEqual(msgs)
    expect(summarize).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行 `pnpm test compact` 确认失败。**

- [ ] **Step 3: 写 `src/memory/compact.ts`**
```ts
import type { Message } from '../types'

export type Summarize = (messages: Message[]) => Promise<string>

// 粗略估算：约 4 字符 ≈ 1 token。够用即可，真实系统会用分词器。
export function estimateTokens(messages: Message[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0)
  return Math.ceil(chars / 4)
}

export async function compactMessages(
  messages: Message[],
  opts: { maxTokens: number; keepRecent: number; summarize: Summarize },
): Promise<Message[]> {
  if (estimateTokens(messages) <= opts.maxTokens) return messages

  const hasSystem = messages[0]?.role === 'system'
  const system = hasSystem ? messages.slice(0, 1) : []
  const rest = hasSystem ? messages.slice(1) : messages

  const recent = rest.slice(-opts.keepRecent)
  const older = rest.slice(0, Math.max(0, rest.length - opts.keepRecent))
  if (older.length === 0) return messages

  const summary = await opts.summarize(older)
  const summaryMsg: Message = { role: 'user', content: `【之前对话摘要】\n${summary}` }
  return [...system, summaryMsg, ...recent]
}
```

- [ ] **Step 4: 运行 `pnpm test compact` 确认通过（4）。**

- [ ] **Step 5: Commit**
```bash
git add src/memory/compact.ts tests/compact.test.ts
git commit -m "feat: token estimate and summarize-based context compaction"
```

---

## Task 4: 真实摘要 `memory/summarize.ts`

**Files:** Create `src/memory/summarize.ts`; Test `tests/summarize.test.ts`

- [ ] **Step 1: 写失败测试 `tests/summarize.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeSummarizer } from '../src/memory/summarize'
import type { Message, ModelResult } from '../src/types'

describe('makeSummarizer', () => {
  it('renders the conversation and returns the model summary text', async () => {
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      // 最后一条 user 消息里应包含被渲染的对话内容
      expect(messages.at(-1)!.content).toContain('我叫 Roy')
      return { text: '用户叫 Roy', toolCalls: [] }
    })
    const summarize = makeSummarizer(callModel)
    const out = await summarize([{ role: 'user', content: '我叫 Roy' }])
    expect(out).toBe('用户叫 Roy')
    expect(callModel).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行 `pnpm test summarize` 确认失败。**

- [ ] **Step 3: 写 `src/memory/summarize.ts`**
```ts
import type { Message, ModelResult } from '../types'
import type { Summarize } from './compact'

export function makeSummarizer(
  callModel: (messages: Message[]) => Promise<ModelResult>,
): Summarize {
  return async (messages: Message[]): Promise<string> => {
    const rendered = messages.map((m) => `${m.role}: ${m.content}`).join('\n')
    const result = await callModel([
      {
        role: 'system',
        content:
          '你是对话摘要器。把下面的对话压成简洁中文要点，保留关键事实、决定、用户偏好；只输出摘要文本，不要调用工具。',
      },
      { role: 'user', content: rendered },
    ])
    return result.text
  }
}
```

- [ ] **Step 4: 运行 `pnpm test summarize` 确认通过（1）。**

- [ ] **Step 5: Commit**
```bash
git add src/memory/summarize.ts tests/summarize.test.ts
git commit -m "feat: LLM summarizer (reuses callModel, injectable)"
```

---

## Task 5: agent 循环加 history / compact / onComplete

**Files:** Modify `src/agent.ts`; Test `tests/agent.test.ts`（追加用例）

- [ ] **Step 1: 在 `tests/agent.test.ts` 的 `describe('runAgent', ...)` 内、最后追加 3 个用例**（保留原有 3 个不动）
```ts
  it('seeds prior history between system and the new user message', async () => {
    const seen: Message[][] = []
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      seen.push(structuredClone(messages))
      return { text: 'ok', toolCalls: [] }
    })
    const history: Message[] = [
      { role: 'user', content: '我叫 Roy' },
      { role: 'assistant', content: '你好 Roy' },
    ]
    await runAgent('我叫啥', { callModel, tools, config, history })
    const msgs = seen[0]
    expect(msgs[0].role).toBe('system')
    expect(msgs[1]).toMatchObject({ role: 'user', content: '我叫 Roy' })
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: '你好 Roy' })
    expect(msgs[3]).toMatchObject({ role: 'user', content: '我叫啥' })
  })

  it('calls onComplete with the final messages including the answer', async () => {
    const callModel = vi.fn(async (): Promise<ModelResult> => ({ text: '答案', toolCalls: [] }))
    let saved: Message[] = []
    await runAgent('q', { callModel, tools, config, onComplete: (m) => { saved = m } })
    expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: '答案' })
  })

  it('compacts messages once before calling the model', async () => {
    const seen: Message[][] = []
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      seen.push(structuredClone(messages))
      return { text: 'ok', toolCalls: [] }
    })
    const compact = vi.fn(async (): Promise<Message[]> => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'COMPACTED' },
    ])
    await runAgent('q', { callModel, tools, config, compact })
    expect(compact).toHaveBeenCalledTimes(1)
    expect(seen[0]).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'COMPACTED' },
    ])
  })
```

- [ ] **Step 2: 运行 `pnpm test agent` 确认新用例失败（旧的仍过）。**

- [ ] **Step 3: 用以下完整内容替换 `src/agent.ts`**
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
  history?: Message[]                                        // 之前会话的消息（不含 system）
  compact?: (messages: Message[]) => Promise<Message[]>      // 开局前压缩一次
  onComplete?: (messages: Message[]) => void | Promise<void> // 跑完拿到完整消息去持久化
}

export async function runAgent(userInput: string, deps: AgentDeps): Promise<string> {
  const { callModel, tools, config, onTurn, history, compact, onComplete } = deps

  let messages: Message[] = [
    { role: 'system', content: config.systemPrompt },
    ...(history ?? []),
    { role: 'user', content: userInput },
  ]

  if (compact) messages = await compact(messages)

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
      await onComplete?.(messages)
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

- [ ] **Step 4: 运行 `pnpm test agent` 确认全过（原 3 + 新 3 = 6），再 `pnpm typecheck`。**

- [ ] **Step 5: Commit**
```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "feat: agent supports history seeding, pre-loop compaction, onComplete"
```

---

## Task 6: CLI 接线 + README + 验证

**Files:** Modify `cli.ts`, `README.md`

- [ ] **Step 1: 用以下完整内容替换 `cli.ts`**
```ts
import 'dotenv/config'
import { loadConfig } from './src/config'
import type { Message } from './src/types'
import { tools } from './src/tools/index'
import { makeSearchNotesTool } from './src/tools/searchNotes'
import { makeEmbedder } from './src/rag/embed'
import { buildNotesIndex } from './src/rag/index'
import { makeCallModel } from './src/llm'
import { runAgent } from './src/agent'
import { printTurn } from './src/trace'
import { createJsonSessionStore } from './src/memory/store'
import { makeSummarizer } from './src/memory/summarize'
import { compactMessages } from './src/memory/compact'

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

  const searchTool = makeSearchNotesTool({ store, embed })
  const registry = { ...tools, [searchTool.name]: searchTool }
  const callModel = makeCallModel(config, registry)

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
    await sessions.save(
      config.sessionId,
      messages.filter((m) => m.role !== 'system'),
    )
  }

  const answer = await runAgent(question, {
    callModel,
    tools: registry,
    config,
    onTurn: printTurn,
    history,
    compact,
    onComplete,
  })
  console.log('\n=== 最终回答 ===')
  console.log(answer)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: 更新 `README.md`**
（a）把「### 阶段 2 — 记忆 + 上下文管理」整段替换为：
```
### 阶段 2 — 记忆 + 上下文管理 ✅
- [x] 记忆（JSON 文件持久化 messages，按 SESSION_ID 分会话）
- [x] 上下文压缩（超 token 预算时 LLM 摘要老消息）
```
（b）在「## Stage 1 在做什么」之后新增一节：
```
## Stage 2 在做什么

`runAgent` 开局把上次会话的 messages（存在 `.sessions/<id>.json`）塞回 system 与本轮 user 之间，跑完再存回——这就是「记忆」。
历史超过 `MAX_CONTEXT_TOKENS`（粗估 ~4 字符/token）时，把 system 与最近 `KEEP_RECENT` 条之间的老消息用 DeepSeek 摘成一条「对话摘要」，省 token、不爆上下文。

> 看记忆：`SESSION_ID=demo pnpm dev "我叫 Roy"` 再 `SESSION_ID=demo pnpm dev "我叫啥"`。
> 看压缩：把 `MAX_CONTEXT_TOKENS` 调到很小（如 50），多聊几轮，trace/会话文件里会出现「【之前对话摘要】」。
> 换新会话：换一个 `SESSION_ID`，或删掉 `.sessions/<id>.json`。
```
（c）「## 结构」代码块追加一行：
```
src/memory/    store / compact / summarize（记忆 + 压缩）
```

- [ ] **Step 3: 全量单测 + 类型检查**
Run `pnpm test && pnpm typecheck`。Expected: 30（前两阶段）+ 新增（config 改的不算新测试；store-session 3 + compact 4 + summarize 1 + agent 新 3 = 11）= 41 个测试通过，typecheck 干净。

- [ ] **Step 4: Commit**
```bash
git add cli.ts README.md
git commit -m "feat: wire memory + compaction into CLI; stage 2 runnable"
```

- [ ] **Step 5: 真机端到端（留给用户，需 DeepSeek key）**
```bash
SESSION_ID=demo pnpm dev "我叫 Roy，记住"
SESSION_ID=demo pnpm dev "我叫什么？"
```
Expected：第二条答出「Roy」；`.sessions/demo.json` 里能看到累积的 messages。
压缩：`MAX_CONTEXT_TOKENS=50 SESSION_ID=demo pnpm dev "再随便聊一句"` 后，会话文件里出现「【之前对话摘要】」开头的消息。

---

## Self-Review（已核对）

**Spec coverage：** Stage 2 = 记忆 + 上下文压缩。记忆 = store(Task2) + runAgent 的 history/onComplete(Task5) + cli 接线(Task6)；压缩 = compact(Task3) + summarize(Task4) + runAgent 的 compact 注入(Task5)。JSON 文件存储、LLM 摘要、SESSION_ID 分会话全部落地。

**Placeholder scan：** 无 TBD/TODO，每步给完整代码与命令。summarize.ts 通过注入 callModel 做到可单测（不再是"仅真机验证"）。

**Type consistency：** `Summarize` 定义于 compact.ts，summarize.ts 实现该签名、compact.ts 使用。`SessionStore`/`createJsonSessionStore(dir)`、`estimateTokens`/`compactMessages(messages, {maxTokens, keepRecent, summarize})`、`makeSummarizer(callModel)`、`runAgent(userInput, deps)` 新增可选 `history`/`compact`/`onComplete` 全程一致。Config 新增 4 字段不影响 agent 的 `Pick<Config,'systemPrompt'|'maxTurns'>`。runAgent 改动向后兼容：不传新字段时与 Stage 0/1 行为完全一致，原有 agent/其它测试不破。摘要消息用 `role:'user'`（非 system），故 cli 的 `filter(role!=='system')` 持久化时会保留摘要、且重载时不会和新注入的 system 重复。
