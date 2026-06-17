# smallest-agent Stage 4a (缓存 + 限流降级) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `callModel` 套三层可组合的生产包装——`withRetry`（瞬时错误指数退避重试）、`withFallback`（主模型失败切备用模型）、`withCache`（磁盘缓存：同样的 messages 第二次秒回、零 token）。agent 循环一行不改。

**Architecture:** 三个高阶函数，签名都是 `CallModel = (messages) => Promise<ModelResult>` → `CallModel`，纯逻辑、注入假 callModel/sleep/cache 做确定性单测。磁盘缓存 `createDiskCache(dir)` 按 `sha256(model + messages)` 存 `ModelResult`。cli 里组合：`withCache( withFallback( withRetry(主), withRetry(备) ) )`，再喂给 `runAgent`。底层 `makeCallModel`（SDK 边界）不变。

**Tech Stack:** 沿用 Stage 0-3，无新依赖（用 node:crypto 做 hash）。

---

## 文件结构（Stage 4a）

| 文件 | 职责 | 测试 |
|------|------|------|
| `src/types.ts`（改） | 导出 `CallModel` 类型；Config 增 `fallbackModel`/`maxRetries`/`cacheEnabled`/`cacheDir` | — |
| `src/config.ts`（改） | loadConfig 读 4 个新 env | config.test 增断言 |
| `.env.example` / `.gitignore`（改） | 新 env；忽略 `.llm-cache` | — |
| `src/resilience.ts`（新） | `withRetry` + `withFallback` | resilience.test.ts |
| `src/cache.ts`（新） | `createDiskCache` + `cacheKey` + `withCache` + `ResultCache` | cache.test.ts |
| `cli.ts`（改） | 组合三层包装 | 真机验证 |
| `README.md`（改） | 勾选 4a 概念 | — |

`CallModel` 类型（types.ts 导出，wrappers 全用它）：
```ts
export type CallModel = (messages: Message[]) => Promise<ModelResult>
```

---

## Task 1: 扩展 config + CallModel 类型

**Files:** Modify `src/types.ts`, `src/config.ts`, `.env.example`, `.gitignore`; Test `tests/config.test.ts`

- [ ] **Step 1: `src/types.ts`** —（a）在 `ModelResult` 定义之后加：
```ts
export type CallModel = (messages: Message[]) => Promise<ModelResult>
```
（b）在 `Config` 接口 `keepRecent: number` 之后加：
```ts
  fallbackModel: string      // 主模型连续失败时切到的备用模型
  maxRetries: number         // 瞬时错误的额外重试次数
  cacheEnabled: boolean      // 是否启用 LLM 结果磁盘缓存
  cacheDir: string           // 缓存目录
```

- [ ] **Step 2: `.gitignore` 末尾追加**
```
.llm-cache
```

- [ ] **Step 3: 改 `tests/config.test.ts`，在 `it('applies sensible defaults', ...)` 末尾追加**
```ts
    expect(c.fallbackModel).toBe('deepseek-chat')
    expect(c.maxRetries).toBe(2)
    expect(c.cacheEnabled).toBe(true)
    expect(c.cacheDir).toBe('./.llm-cache')
```

- [ ] **Step 4: 运行 `pnpm test config` 确认失败。**

- [ ] **Step 5: 改 `src/config.ts`，在 return 对象 `keepRecent: ...,` 之后加**
```ts
    fallbackModel: env.FALLBACK_MODEL ?? env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    maxRetries: numFromEnv(env.MAX_RETRIES, 2, 'MAX_RETRIES'),
    cacheEnabled: env.LLM_CACHE !== '0',
    cacheDir: env.LLM_CACHE_DIR ?? './.llm-cache',
```

- [ ] **Step 6: `.env.example` 末尾追加**
```
# 生产化（Stage 4a）
# 主模型失败时切到的备用模型（默认与主模型相同 = 仅作多一层重试保险）
# FALLBACK_MODEL=deepseek-reasoner
MAX_RETRIES=2
# LLM 结果缓存：设 0 关闭
LLM_CACHE=1
# LLM_CACHE_DIR=./.llm-cache
```

- [ ] **Step 7: `pnpm test config && pnpm typecheck` 绿；`pnpm test` 全绿（47 不变，只给已有用例加了断言）。**

- [ ] **Step 8: Commit**
```bash
git add src/types.ts src/config.ts .env.example .gitignore tests/config.test.ts
git commit -m "feat: add CallModel type + resilience/cache config"
```

---

## Task 2: 重试 + 降级 `src/resilience.ts`

**Files:** Create `src/resilience.ts`; Test `tests/resilience.test.ts`

- [ ] **Step 1: 写失败测试 `tests/resilience.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest'
import { withRetry, withFallback } from '../src/resilience'
import type { Message, ModelResult } from '../src/types'

const msgs: Message[] = [{ role: 'user', content: 'hi' }]
const ok: ModelResult = { text: 'ok', toolCalls: [] }
const noSleep = async () => {}

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn(async () => ok)
    const out = await withRetry(fn, { sleep: noSleep })(msgs)
    expect(out).toBe(ok)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries retryable errors then succeeds', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      if (++n < 3) throw new Error('rate limit exceeded')
      return ok
    })
    const out = await withRetry(fn, { retries: 3, sleep: noSleep })(msgs)
    expect(out).toBe(ok)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry when isRetryable says no', async () => {
    const fn = vi.fn(async () => { throw new Error('bad request') })
    await expect(withRetry(fn, { sleep: noSleep, isRetryable: () => false })(msgs)).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting retries', async () => {
    const fn = vi.fn(async () => { throw new Error('timeout') })
    await expect(withRetry(fn, { retries: 2, sleep: noSleep })(msgs)).rejects.toThrow(/timeout/)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('withFallback', () => {
  it('uses primary when it succeeds', async () => {
    const primary = vi.fn(async () => ok)
    const fallback = vi.fn(async (): Promise<ModelResult> => ({ text: 'fb', toolCalls: [] }))
    const out = await withFallback(primary, fallback)(msgs)
    expect(out).toBe(ok)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back when primary throws, and notifies', async () => {
    const fb: ModelResult = { text: 'fb', toolCalls: [] }
    const primary = vi.fn(async (): Promise<ModelResult> => { throw new Error('down') })
    const fallback = vi.fn(async () => fb)
    const onFallback = vi.fn()
    const out = await withFallback(primary, fallback, onFallback)(msgs)
    expect(out).toBe(fb)
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行 `pnpm test resilience` 确认失败。**

- [ ] **Step 3: 写 `src/resilience.ts`**
```ts
import type { CallModel } from './types'

export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  isRetryable?: (err: unknown) => boolean
  sleep?: (ms: number) => Promise<void>
}

function defaultRetryable(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string }
  const code = String(e?.statusCode ?? e?.status ?? '')
  const msg = String(e?.message ?? err)
  return code === '429' || /^5\d\d$/.test(code) || /rate.?limit|timeout|ECONN|ETIMEDOUT|fetch failed/i.test(msg)
}

export function withRetry(callModel: CallModel, opts: RetryOptions = {}): CallModel {
  const retries = opts.retries ?? 2
  const baseDelayMs = opts.baseDelayMs ?? 300
  const isRetryable = opts.isRetryable ?? defaultRetryable
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  return async (messages) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await callModel(messages)
      } catch (err) {
        lastErr = err
        if (attempt === retries || !isRetryable(err)) throw err
        await sleep(baseDelayMs * 2 ** attempt)
      }
    }
    throw lastErr
  }
}

export function withFallback(
  primary: CallModel,
  fallback: CallModel,
  onFallback?: (err: unknown) => void,
): CallModel {
  return async (messages) => {
    try {
      return await primary(messages)
    } catch (err) {
      onFallback?.(err)
      return await fallback(messages)
    }
  }
}
```

- [ ] **Step 4: 运行 `pnpm test resilience` 确认通过（6）。**

- [ ] **Step 5: Commit**
```bash
git add src/resilience.ts tests/resilience.test.ts
git commit -m "feat: withRetry (exponential backoff) and withFallback wrappers"
```

---

## Task 3: 磁盘缓存 `src/cache.ts`

**Files:** Create `src/cache.ts`; Test `tests/cache.test.ts`

- [ ] **Step 1: 写失败测试 `tests/cache.test.ts`**
```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiskCache, withCache, cacheKey, type ResultCache } from '../src/cache'
import type { Message, ModelResult } from '../src/types'

const msgsA: Message[] = [{ role: 'user', content: 'A' }]
const msgsB: Message[] = [{ role: 'user', content: 'B' }]
const ok: ModelResult = { text: 'ok', toolCalls: [] }

function memCache(): ResultCache {
  const store = new Map<string, ModelResult>()
  return { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v) } }
}

describe('cacheKey', () => {
  it('is stable for the same input and differs across messages', () => {
    expect(cacheKey('m', msgsA)).toBe(cacheKey('m', msgsA))
    expect(cacheKey('m', msgsA)).not.toBe(cacheKey('m', msgsB))
  })
})

describe('createDiskCache', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'sa-cache-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('returns undefined on miss and round-trips on set', async () => {
    const cache = createDiskCache(dir)
    expect(await cache.get('k1')).toBeUndefined()
    await cache.set('k1', ok)
    expect(await cache.get('k1')).toEqual(ok)
  })
})

describe('withCache', () => {
  it('calls the model on miss and serves the repeat from cache (no 2nd call)', async () => {
    const fn = vi.fn(async () => ok)
    const onHit = vi.fn()
    const cached = withCache(fn, memCache(), 'model-x', onHit)
    const a1 = await cached(msgsA)
    const a2 = await cached(msgsA)
    expect(a1).toEqual(ok)
    expect(a2).toEqual(ok)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onHit).toHaveBeenCalledTimes(1)
  })

  it('misses for different messages', async () => {
    const fn = vi.fn(async () => ok)
    const cached = withCache(fn, memCache(), 'model-x')
    await cached(msgsA)
    await cached(msgsB)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 运行 `pnpm test cache` 确认失败。**

- [ ] **Step 3: 写 `src/cache.ts`**
```ts
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CallModel, ModelResult } from './types'

export interface ResultCache {
  get(key: string): Promise<ModelResult | undefined>
  set(key: string, value: ModelResult): Promise<void>
}

export function cacheKey(prefix: string, messages: unknown): string {
  return createHash('sha256')
    .update(`${prefix}\n${JSON.stringify(messages)}`)
    .digest('hex')
    .slice(0, 32)
}

export function createDiskCache(dir: string): ResultCache {
  const base = resolve(dir)
  const fileFor = (key: string) => join(base, `${key}.json`)
  return {
    async get(key) {
      const file = fileFor(key)
      if (!existsSync(file)) return undefined
      return JSON.parse(await readFile(file, 'utf8')) as ModelResult
    },
    async set(key, value) {
      await mkdir(base, { recursive: true })
      await writeFile(fileFor(key), JSON.stringify(value), 'utf8')
    },
  }
}

export function withCache(
  callModel: CallModel,
  cache: ResultCache,
  keyPrefix: string,
  onHit?: () => void,
): CallModel {
  return async (messages) => {
    const key = cacheKey(keyPrefix, messages)
    const hit = await cache.get(key)
    if (hit) {
      onHit?.()
      return hit
    }
    const result = await callModel(messages)
    await cache.set(key, result)
    return result
  }
}
```

- [ ] **Step 4: 运行 `pnpm test cache` 确认通过（4）。**

- [ ] **Step 5: Commit**
```bash
git add src/cache.ts tests/cache.test.ts
git commit -m "feat: disk LLM result cache (createDiskCache + withCache)"
```

---

## Task 4: CLI 组合三层包装 + README + 验证

**Files:** Modify `cli.ts`, `README.md`

- [ ] **Step 1: 改 `cli.ts`**
（a）加 import：
```ts
import { withRetry, withFallback } from './src/resilience'
import { createDiskCache, withCache } from './src/cache'
```
（b）把现有这一行：
```ts
    const callModel = makeCallModel(config, registry)
```
替换为：
```ts
    // 限流降级：主模型重试 → 失败切备用模型
    const primary = withRetry(makeCallModel(config, registry), { retries: config.maxRetries })
    const fallback =
      config.fallbackModel === config.model
        ? primary
        : withRetry(makeCallModel({ ...config, model: config.fallbackModel }, registry), {
            retries: config.maxRetries,
          })
    let callModel = withFallback(primary, fallback, (err) =>
      console.error(`主模型失败，降级到 ${config.fallbackModel}：${err instanceof Error ? err.message : err}`),
    )
    // 省 token：磁盘缓存（同样的 messages 第二次直接命中）
    if (config.cacheEnabled) {
      callModel = withCache(callModel, createDiskCache(config.cacheDir), config.model, () =>
        console.error('🟢 LLM 缓存命中（省 token）'),
      )
    }
```
（其余 main() 不变：`makeCallModel(config, {})` 给 summarizer 的那行保持原样、不包装；`runAgent({ callModel, ... })` 用上面这个 `callModel`。）

- [ ] **Step 2: README**
（a）把「### 阶段 4 — 生产化」整段的前半勾上：
```
### 阶段 4 — 生产化（4a ✅ / 4b 待做）
- [x] 缓存 / 省 token（withCache，磁盘缓存）
- [x] 限流降级（withRetry 指数退避 + withFallback 切备用模型）
- [ ] 降延迟（streaming）
- [ ] 降幻觉（引用强制 + verifier）
```
（b）在「## Stage 3 在做什么」之后新增：
```
## Stage 4a 在做什么

三层可组合的生产包装套在 `callModel` 外面（agent 循环不变）：
- `withRetry`：429/5xx/超时等瞬时错误指数退避重试。
- `withFallback`：主模型连续失败 → 切到 `FALLBACK_MODEL`。
- `withCache`：按 `sha256(model+messages)` 磁盘缓存 `ModelResult`，同样的请求第二次秒回、零 token。

> 看缓存：同一问题在两个干净会话各跑一次——第二次会打印「🟢 LLM 缓存命中」、几乎瞬时。
> `LLM_CACHE=0` 关缓存；`FALLBACK_MODEL=deepseek-reasoner` 配备用模型；`MAX_RETRIES=3` 调重试。
```
（c）「## 结构」追加：
```
src/resilience.ts  withRetry + withFallback（限流降级）
src/cache.ts       磁盘 LLM 缓存（省 token）
```

- [ ] **Step 3: `pnpm test && pnpm typecheck`** —— 全绿（47 + resilience 6 + cache 4 = 57），typecheck 干净。

- [ ] **Step 4: Commit**
```bash
git add cli.ts README.md
git commit -m "feat: wire retry/fallback/cache around callModel; stage 4a runnable"
```

- [ ] **Step 5: 真机验证（留给用户，需 DeepSeek key）**
```bash
SESSION_ID=c1 pnpm dev "用一句话说说 RAG 是什么"
SESSION_ID=c2 pnpm dev "用一句话说说 RAG 是什么"
```
Expected：第二次（相同问题、另一个干净会话）首个模型调用打印「🟢 LLM 缓存命中」、几乎瞬时返回。`LLM_CACHE=0 ...` 则两次都真调模型。

---

## Self-Review（已核对）

**Spec coverage：** Stage 4a = 缓存/省 token + 限流降级。缓存 = cache.ts(Task3) + cli 组合(Task4)；限流降级 = resilience.ts withRetry/withFallback(Task2) + cli 组合(Task4)。全是 `callModel` 的纯包装，agent 循环不动。

**Placeholder scan：** 无 TBD/TODO。每步完整代码 + 命令。底层 `makeCallModel`（SDK 边界）不改、不重测；包装逻辑全用假 callModel/sleep/cache 确定性单测。

**Type consistency：** `CallModel = (messages: Message[]) => Promise<ModelResult>` 定义于 types.ts，`withRetry`/`withFallback`/`withCache` 入参出参全用它。`ResultCache`/`createDiskCache(dir)`/`cacheKey(prefix, messages)`/`withCache(callModel, cache, keyPrefix, onHit?)`、`RetryOptions`/`withRetry(callModel, opts)`/`withFallback(primary, fallback, onFallback?)` 全程一致。Config 新增 4 字段不影响 agent 的 `Pick<Config,'systemPrompt'|'maxTurns'>`。`callModel` 经包装后仍是 `(messages)=>Promise<ModelResult>`，`runAgent`/`makeCallModel` 不变。`makeCallModel({...config, model: fallbackModel}, registry)` 复用既有签名。
