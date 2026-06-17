# smallest-agent Stage 1 (真工具 + RAG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Stage 0 的 agent 加一个 `search_notes` 工具：本地 embedding（transformers.js）+ 内存余弦相似度向量库，对仓库内置的示例笔记做语义检索。证明「RAG 不是新架构，只是注册表里多了一个工具」——agent 循环一行不改。

**Architecture:** 沿用 Stage 0 的可测设计。纯逻辑（切块 `chunk`、余弦 `similarity`、内存库 `store`、建索引 `index`、检索工具）用「假 embedder」做确定性单测；真实 embedding 模型隔离在 `src/rag/embed.ts`（仅此文件加载模型），由真机运行验证。启动时 `cli.ts` 读 `notes/` → 切块 → embed → 建库 → 把 `search_notes` 塞进注册表传给 agent。

**Tech Stack:** 新增 `@huggingface/transformers`（本地 feature-extraction pipeline，默认模型 `Xenova/multilingual-e5-small`，多语言含中文）。其余沿用 Stage 0（TS ESM、vitest、tsx、Vercel AI SDK v6、DeepSeek）。

---

## 文件结构（Stage 1）

| 文件 | 职责 | 测试 |
|------|------|------|
| `src/types.ts`（改） | Config 增加 `embeddingModel` / `notesDir` | — |
| `src/config.ts`（改） | loadConfig 读两个新 env，给默认值 | config.test.ts 增断言 |
| `.env.example`（改） | 增 `EMBEDDING_MODEL` / `NOTES_DIR` | — |
| `src/rag/chunk.ts` | `chunkText(text, maxChars)` 纯切块 | chunk.test.ts |
| `src/rag/similarity.ts` | `cosineSimilarity(a, b)` 纯数学 | similarity.test.ts |
| `src/rag/store.ts` | 内存向量库 `createStore` + `search` | store.test.ts |
| `src/rag/embed.ts` | `Embedder` 类型 + `makeEmbedder`（真实模型，仅此文件碰 transformers.js） | 无单测，真机验证 |
| `src/rag/index.ts` | `buildNotesIndex` + `searchNotes` | index.test.ts（假 embedder + fixture） |
| `src/tools/searchNotes.ts` | `makeSearchNotesTool` 把检索包成 Tool | searchNotes.test.ts（假 store/embed） |
| `notes/*.md` | 5 篇示例笔记 | — |
| `cli.ts`（改） | 启动构建索引 + 合并工具注册表 | 真机验证 |
| `README.md`（改） | 勾选 Stage 1 概念 | — |
| `tests/fixtures/notes/*.md` | index 测试用的小 fixture | — |

**共享类型增量（`embed.ts` 导出，供 index/store-consumer/tool 复用）：**

```ts
export type Embedder = (texts: string[]) => Promise<number[][]>
```

---

## Task 1: 依赖 + 扩展 config

**Files:**
- Modify: `src/types.ts`, `src/config.ts`, `.env.example`, `.gitignore`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 安装依赖**

Run（从 `/Users/royzeng/lab/smallest-agent`）:
```bash
pnpm add @huggingface/transformers
```
Expected: 安装成功。

- [ ] **Step 2: `.gitignore` 增加模型缓存目录**

在文件末尾追加一行：
```
.cache
```

- [ ] **Step 3: 在 `src/types.ts` 的 `Config` 接口里加两个字段**

把 `Config` 改成（在 `systemPrompt` 后加两行）：
```ts
export interface Config {
  apiKey: string
  baseURL: string
  model: string
  temperature: number
  maxTurns: number
  systemPrompt: string
  embeddingModel: string
  notesDir: string
}
```

- [ ] **Step 4: 改 `tests/config.test.ts`，在「applies sensible defaults」用例里追加两条断言**

在该 `it('applies sensible defaults', ...)` 的断言末尾加：
```ts
    expect(c.embeddingModel).toBe('Xenova/multilingual-e5-small')
    expect(c.notesDir).toBe('./notes')
```

- [ ] **Step 5: 运行测试，确认失败**

Run: `pnpm test config`
Expected: 「applies sensible defaults」FAIL（`embeddingModel` undefined）。

- [ ] **Step 6: 改 `src/config.ts` 的 return，加两行**

在 `loadConfig` 的返回对象里 `systemPrompt: SYSTEM_PROMPT,` 之后加：
```ts
    embeddingModel: env.EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small',
    notesDir: env.NOTES_DIR ?? './notes',
```

- [ ] **Step 7: 改 `.env.example`，末尾追加**

```
EMBEDDING_MODEL=Xenova/multilingual-e5-small
NOTES_DIR=./notes
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm test config && pnpm typecheck`
Expected: config 测试全绿，typecheck 无错。

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore src/types.ts src/config.ts .env.example tests/config.test.ts
git commit -m "feat: add transformers.js dep and embeddingModel/notesDir config"
```

---

## Task 2: 切块 `chunk.ts`

**Files:**
- Create: `src/rag/chunk.ts`
- Test: `tests/chunk.test.ts`

- [ ] **Step 1: 写失败测试 `tests/chunk.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { chunkText } from '../src/rag/chunk'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world'])
  })

  it('returns empty array for whitespace-only text', () => {
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('packs multiple paragraphs into chunks under the size limit', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc'
    const chunks = chunkText(text, 10)
    // 'aaaa\n\nbbbb' = 10 chars fits; 'cccc' starts a new chunk
    expect(chunks).toEqual(['aaaa\n\nbbbb', 'cccc'])
  })

  it('hard-splits a paragraph longer than maxChars', () => {
    const long = 'x'.repeat(25)
    const chunks = chunkText(long, 10)
    expect(chunks).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
    expect(chunks.every((c) => c.length <= 10)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test chunk`
Expected: FAIL（module not found）。

- [ ] **Step 3: 写 `src/rag/chunk.ts`**

```ts
export function chunkText(text: string, maxChars = 500): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxChars) {
      chunks.push(current)
      current = ''
    }
    if (para.length > maxChars) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars))
      }
      continue
    }
    current = current ? `${current}\n\n${para}` : para
  }

  if (current) chunks.push(current)
  return chunks
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test chunk`
Expected: PASS（4 个测试）。

- [ ] **Step 5: Commit**

```bash
git add src/rag/chunk.ts tests/chunk.test.ts
git commit -m "feat: paragraph-aware text chunker"
```

---

## Task 3: 余弦相似度 `similarity.ts`

**Files:**
- Create: `src/rag/similarity.ts`
- Test: `tests/similarity.test.ts`

- [ ] **Step 1: 写失败测试 `tests/similarity.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { cosineSimilarity } from '../src/rag/similarity'

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1)
  })

  it('is 0 when a vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length/)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test similarity`
Expected: FAIL（module not found）。

- [ ] **Step 3: 写 `src/rag/similarity.ts`**

```ts
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test similarity`
Expected: PASS（5 个测试）。

- [ ] **Step 5: Commit**

```bash
git add src/rag/similarity.ts tests/similarity.test.ts
git commit -m "feat: cosine similarity"
```

---

## Task 4: 内存向量库 `store.ts`

**Files:**
- Create: `src/rag/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: 写失败测试 `tests/store.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { createStore } from '../src/rag/store'

const chunks = [
  { text: 'apple pie', source: 'a.md', vector: [1, 0] },
  { text: 'banana bread', source: 'b.md', vector: [0, 1] },
  { text: 'apple juice', source: 'c.md', vector: [0.9, 0.1] },
]

describe('createStore', () => {
  it('reports its size', () => {
    expect(createStore(chunks).size).toBe(3)
  })

  it('ranks the closest chunk first', () => {
    const hits = createStore(chunks).search([1, 0], 2)
    expect(hits).toHaveLength(2)
    expect(hits[0].source).toBe('a.md')
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it('returns at most k hits', () => {
    expect(createStore(chunks).search([1, 0], 1)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test store`
Expected: FAIL（module not found）。

- [ ] **Step 3: 写 `src/rag/store.ts`**

```ts
import { cosineSimilarity } from './similarity'

export interface StoredChunk {
  text: string
  source: string
  vector: number[]
}

export interface SearchHit {
  text: string
  source: string
  score: number
}

export interface VectorStore {
  size: number
  search(queryVector: number[], k: number): SearchHit[]
}

export function createStore(chunks: StoredChunk[]): VectorStore {
  return {
    size: chunks.length,
    search(queryVector: number[], k: number): SearchHit[] {
      return chunks
        .map((c) => ({
          text: c.text,
          source: c.source,
          score: cosineSimilarity(queryVector, c.vector),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
    },
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test store`
Expected: PASS（3 个测试）。

- [ ] **Step 5: Commit**

```bash
git add src/rag/store.ts tests/store.test.ts
git commit -m "feat: in-memory cosine vector store"
```

---

## Task 5: 真实 embedder `embed.ts`（隔离，无单测）

> 说明：此文件是唯一加载 transformers.js 模型的地方，**不写单元测试**。它由 Task 8 的真机运行（或 embedder smoke test）验证。先建它，因为 Task 6（index）要 import 它导出的 `Embedder` 类型。

**Files:**
- Create: `src/rag/embed.ts`

- [ ] **Step 1: 写 `src/rag/embed.ts`**

```ts
import { pipeline } from '@huggingface/transformers'
import type { Config } from '../types'

export type Embedder = (texts: string[]) => Promise<number[][]>

export async function makeEmbedder(config: Config): Promise<Embedder> {
  const extractor = await pipeline('feature-extraction', config.embeddingModel)
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return []
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    return output.tolist() as number[][]
  }
}
```

- [ ] **Step 2: 类型检查通过**

Run: `pnpm typecheck`
Expected: 无类型错误。若 transformers.js 的类型对 `extractor(...)` 或 `.tolist()` 报错，仅在此文件做最小 `as` 调整（这是 SDK 边界文件，等同 `llm.ts` 的处理）后再次 `pnpm typecheck` 直到通过。

- [ ] **Step 3: Commit**

```bash
git add src/rag/embed.ts
git commit -m "feat: local transformers.js embedder (isolated)"
```

---

## Task 6: 建索引 + 检索 `index.ts`

**Files:**
- Create: `src/rag/index.ts`
- Create: `tests/fixtures/notes/apple.md`, `tests/fixtures/notes/banana.md`
- Test: `tests/index.test.ts`

- [ ] **Step 1: 写 fixture 文件**

`tests/fixtures/notes/apple.md`:
```
苹果是一种水果 apple。
```

`tests/fixtures/notes/banana.md`:
```
香蕉也是一种水果 banana。
```

- [ ] **Step 2: 写失败测试 `tests/index.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { buildNotesIndex, searchNotes } from '../src/rag/index'
import type { Embedder } from '../src/rag/embed'

// 假 embedder：根据关键词给确定性向量，[apple?, banana?]
const fakeEmbed: Embedder = async (texts) =>
  texts.map((t) => [t.includes('apple') ? 1 : 0, t.includes('banana') ? 1 : 0])

const fixtureDir = new URL('./fixtures/notes', import.meta.url).pathname

describe('buildNotesIndex', () => {
  it('reads .md files, chunks, and embeds every chunk', async () => {
    const store = await buildNotesIndex({ notesDir: fixtureDir, embed: fakeEmbed })
    expect(store.size).toBe(2)
  })
})

describe('searchNotes', () => {
  it('returns hits ranked by semantic closeness, with source and score', async () => {
    const store = await buildNotesIndex({ notesDir: fixtureDir, embed: fakeEmbed })
    const result = await searchNotes(store, fakeEmbed, 'apple', 1)
    expect(result.query).toBe('apple')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].source).toBe('apple.md')
    expect(result.hits[0].score).toBeGreaterThan(0)
    expect(typeof result.hits[0].text).toBe('string')
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test index`
Expected: FAIL（module not found）。

- [ ] **Step 4: 写 `src/rag/index.ts`**

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chunkText } from './chunk'
import { createStore, type StoredChunk, type VectorStore } from './store'
import type { Embedder } from './embed'

export async function buildNotesIndex(opts: {
  notesDir: string
  embed: Embedder
  maxChars?: number
}): Promise<VectorStore> {
  const { notesDir, embed, maxChars } = opts
  const entries = await readdir(notesDir)
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort()

  const pieces: { text: string; source: string }[] = []
  for (const file of mdFiles) {
    const content = await readFile(join(notesDir, file), 'utf8')
    for (const chunk of chunkText(content, maxChars)) {
      pieces.push({ text: chunk, source: file })
    }
  }

  const vectors = await embed(pieces.map((p) => p.text))
  const stored: StoredChunk[] = pieces.map((p, i) => ({
    text: p.text,
    source: p.source,
    vector: vectors[i],
  }))
  return createStore(stored)
}

export interface SearchNotesResult {
  query: string
  hits: { source: string; score: number; text: string }[]
}

export async function searchNotes(
  store: VectorStore,
  embed: Embedder,
  query: string,
  k = 4,
): Promise<SearchNotesResult> {
  const [queryVector] = await embed([query])
  const hits = store.search(queryVector, k).map((h) => ({
    source: h.source,
    score: Number(h.score.toFixed(4)),
    text: h.text,
  }))
  return { query, hits }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm test index`
Expected: PASS（2 个测试）。

- [ ] **Step 6: Commit**

```bash
git add src/rag/index.ts tests/index.test.ts tests/fixtures/notes/apple.md tests/fixtures/notes/banana.md
git commit -m "feat: build notes index and semantic searchNotes"
```

---

## Task 7: 检索工具 `tools/searchNotes.ts`

**Files:**
- Create: `src/tools/searchNotes.ts`
- Test: `tests/searchNotes.test.ts`

- [ ] **Step 1: 写失败测试 `tests/searchNotes.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeSearchNotesTool } from '../src/tools/searchNotes'
import type { VectorStore } from '../src/rag/store'
import type { Embedder } from '../src/rag/embed'

describe('makeSearchNotesTool', () => {
  it('builds a Tool named search_notes', () => {
    const store: VectorStore = { size: 0, search: () => [] }
    const embed: Embedder = async (t) => t.map(() => [0])
    const tool = makeSearchNotesTool({ store, embed })
    expect(tool.name).toBe('search_notes')
    expect(typeof tool.run).toBe('function')
  })

  it('embeds the query and returns store hits', async () => {
    const store: VectorStore = {
      size: 1,
      search: vi.fn(() => [{ text: 'hi', source: 'n.md', score: 0.9 }]),
    }
    const embed: Embedder = vi.fn(async (t) => t.map(() => [1, 0]))
    const tool = makeSearchNotesTool({ store, embed })
    const out: any = await tool.run({ query: '问题', k: 1 })
    expect(embed).toHaveBeenCalledWith(['问题'])
    expect(out.query).toBe('问题')
    expect(out.hits[0].source).toBe('n.md')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test searchNotes`
Expected: FAIL（module not found）。

- [ ] **Step 3: 写 `src/tools/searchNotes.ts`**

```ts
import { z } from 'zod'
import type { Tool } from '../types'
import type { VectorStore } from '../rag/store'
import type { Embedder } from '../rag/embed'
import { searchNotes } from '../rag/index'

export function makeSearchNotesTool(deps: { store: VectorStore; embed: Embedder }): Tool {
  return {
    name: 'search_notes',
    description: '在用户的笔记库里做语义检索。需要引用笔记内容、或回答与已有笔记相关的问题时调用。',
    parameters: z.object({
      query: z.string().describe('检索用的自然语言查询'),
      k: z.number().int().positive().optional().describe('返回片段数，默认 4'),
    }),
    run: async (args: { query: string; k?: number }) =>
      searchNotes(deps.store, deps.embed, args.query, args.k ?? 4),
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm test searchNotes`
Expected: PASS（2 个测试）。

- [ ] **Step 5: Commit**

```bash
git add src/tools/searchNotes.ts tests/searchNotes.test.ts
git commit -m "feat: search_notes tool wrapping the retriever"
```

---

## Task 8: 示例笔记 + CLI 接线 + README + 验证

**Files:**
- Create: `notes/01-rag.md`, `notes/02-agent-loop.md`, `notes/03-embedding-vector.md`, `notes/04-nextjs-cloudflare.md`, `notes/05-eval-harness.md`
- Modify: `cli.ts`, `README.md`

- [ ] **Step 1: 写 5 篇示例笔记**（每篇 2-4 段中文，主题分明，便于看出语义检索效果）

`notes/01-rag.md`:
```
# RAG 检索增强生成

RAG 把「检索」和「生成」拼在一起：先用向量检索从知识库里找出与问题最相关的片段，再把这些片段塞进 prompt 让大模型作答。它解决的是模型「不知道你的私有数据」和「容易编造」的问题。

关键步骤是 chunking（切块）、embedding（向量化）、相似度检索、以及把命中片段拼进上下文。chunk 切得太大语义被平均掉，太小又丢上下文，是效果好坏的关键。
```

`notes/02-agent-loop.md`:
```
# Agent 的本质是一个循环

Agent = LLM + 工具 + 循环。最朴素的实现就是一个 while 循环：问模型下一步做什么，如果模型要调工具就执行并把结果喂回去，否则就返回最终答案。

LangChain 几万行代码，核心也只是把这个循环包了一层。先把裸循环写出来跑通，再往上叠记忆、RAG、MCP 等能力，每个能力都是在循环的某个位置加一段代码。
```

`notes/03-embedding-vector.md`:
```
# 向量与 Embedding

Embedding 把一段文字映射成一串数字（向量），语义相近的文字向量也相近。比较两个向量常用余弦相似度，它衡量方向是否一致，而不在乎长度。

文本检索几乎都用余弦相似度。Embedding 模型和聊天模型是两种不同的模型：前者输出向量、极便宜，用于检索；后者输出文本，用于生成。
```

`notes/04-nextjs-cloudflare.md`:
```
# 部署 Next.js 到 Cloudflare

把 Next.js 部署到 Cloudflare Pages 时，常见的坑是 Node API 不被 edge runtime 支持、以及环境变量注入方式不同。需要确认使用的依赖是否兼容 edge。

数据库层如果用 Postgres，可以配合 Drizzle ORM；要做向量检索可以用 pgvector，Drizzle 已经原生支持 vector 列。
```

`notes/05-eval-harness.md`:
```
# Eval 与 Harness

做出能 demo 的 Agent 不难，做出能上线的 Agent 99% 是 eval 工作。Eval 是在没有标准答案的情况下客观衡量好坏，常见打分方式有 exact match、程序化校验、LLM-as-Judge、人工标注。

Harness 是跑 eval 的那套基础设施：准备测试集、组织运行、自动打分。测试集是会增值的资产，用户每用一次就能发现新的 bad case，加进去变成永久回归。
```

- [ ] **Step 2: 改 `cli.ts`（启动构建索引 + 合并注册表）—— 替换整个文件内容**

```ts
import 'dotenv/config'
import { loadConfig } from './src/config'
import { tools } from './src/tools/index'
import { makeSearchNotesTool } from './src/tools/searchNotes'
import { makeEmbedder } from './src/rag/embed'
import { buildNotesIndex } from './src/rag/index'
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

  console.error('加载 embedding 模型并构建笔记索引…（首次会下载模型）')
  const embed = await makeEmbedder(config)
  const store = await buildNotesIndex({ notesDir: config.notesDir, embed })
  console.error(`索引完成：${store.size} 个片段，来自 ${config.notesDir}`)

  const searchTool = makeSearchNotesTool({ store, embed })
  const registry = { ...tools, [searchTool.name]: searchTool }

  const callModel = makeCallModel(config, registry)
  const answer = await runAgent(question, { callModel, tools: registry, config, onTurn: printTurn })
  console.log('\n=== 最终回答 ===')
  console.log(answer)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 3: 改 `README.md`**

将「### 阶段 1 — 真工具 + RAG」整段替换为：
```
### 阶段 1 — 真工具 + RAG ✅
- [x] RAG（`search_notes` 工具）
- [x] embedding / 向量检索（本地 transformers.js + 内存余弦库）
- [x] chunking（`src/rag/chunk.ts`）
```

并在「## Stage 0 在做什么」之后新增一节：
```
## Stage 1 在做什么

RAG 不是新架构，只是注册表里多了一个 `search_notes` 工具——agent 循环一行没改。
启动时读 `notes/` → 切块 → 本地 embedding → 建内存向量库；提问时模型按需调 `search_notes`，
用余弦相似度取回最相关片段再作答。换更大的向量库（pgvector / sqlite-vec）只需替换 `src/rag/store.ts`，接口不变。

> embedding 模型默认 `Xenova/multilingual-e5-small`（多语言，含中文），首次运行会从 HuggingFace 下载。
> 想指向你真实的 Obsidian vault：设置 `NOTES_DIR=/path/to/vault`。
```

并把「## 结构」里的代码块补一行：
```
src/rag/       chunk / similarity / store / embed / index（RAG 全套）
```

- [ ] **Step 4: 全量单测 + 类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部单测 PASS（Stage 0 的 14 个 + Stage 1 新增：chunk 4 + similarity 5 + store 3 + index 2 + searchNotes 2 = 16，共 30），typecheck 无错。

- [ ] **Step 5: Embedder smoke test（验证真实模型，不依赖 DeepSeek key）**

写一个临时脚本 `scripts/smoke-embed.ts`（验证后删除，不提交）：
```ts
import { loadConfig } from '../src/config'
import { makeEmbedder } from '../src/rag/embed'

const config = loadConfig({ DEEPSEEK_API_KEY: 'x' } as any)
const embed = await makeEmbedder(config)
const [v] = await embed(['你好，世界'])
console.log('vector length:', v.length)
```
Run: `pnpm tsx scripts/smoke-embed.ts`
Expected: 打印一个正整数向量维度（如 `vector length: 384`）。这证明本地 embedding 真的能跑。
- 若环境无法联网下载模型：记录该情况，跳过本步骤，留给用户真机验证。
- 验证完删除：`rm scripts/smoke-embed.ts`（若目录空也删 `scripts/`）。不要提交这个临时脚本。

- [ ] **Step 6: Commit**

```bash
git add notes cli.ts README.md
git commit -m "feat: sample notes, RAG wiring in CLI, README; stage 1 runnable"
```

- [ ] **Step 7: 真机端到端（留给用户，需 DeepSeek key + 联网下载 embedding 模型）**

填好 `.env` 后：
```bash
pnpm dev "根据我的笔记，RAG 里 chunking 为什么重要？"
```
Expected: trace 里出现 `🔧 调用 search_notes(...)` 与 `📦 search_notes → {...hits...}`，最终答案引用了 `01-rag.md` 的内容。
```bash
pnpm dev "你好"
```
Expected: 不调用任何工具，一轮直接作答。

---

## Self-Review（已核对）

**Spec coverage：** Stage 1 = 「真工具 + RAG，覆盖 RAG / embedding / 工具设计」。RAG 管线 = chunk(Task2) + similarity(Task3) + store(Task4) + embed(Task5) + index(Task6)；工具化 = searchNotes(Task7)；接线 + 示例数据 = Task8。「向量库先用内存版 cosine」「embedding 本地 transformers.js」「内置示例笔记 + notesDir 可配」全部落地。

**Placeholder scan：** 无 TBD/TODO。`embed.ts` 明确标注「无单测、真机/ smoke 验证」并给完整实现，非占位。临时 smoke 脚本明确要求验证后删除、不提交。

**Type consistency：** `Embedder` 定义于 `embed.ts`，被 index/searchNotes/测试统一引用。`VectorStore`/`StoredChunk`/`SearchHit` 定义于 `store.ts`，被 index/tool/测试引用。`buildNotesIndex({notesDir, embed, maxChars?})`、`searchNotes(store, embed, query, k?)`、`makeSearchNotesTool({store, embed})`、`makeEmbedder(config)`、`cosineSimilarity(a,b)`、`chunkText(text, maxChars?)`、`createStore(chunks)` 全程命名一致。Config 新增 `embeddingModel`/`notesDir` 不影响 agent 的 `Pick<Config,'systemPrompt'|'maxTurns'>`。新工具 `search_notes` 与既有 `get_weather` 同为 `Tool`，经 cli 合并进注册表，agent 循环不变。
