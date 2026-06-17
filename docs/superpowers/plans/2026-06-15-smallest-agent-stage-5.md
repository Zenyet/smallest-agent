# smallest-agent Stage 5 (Eval Harness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给整个 agent 套一层评估系统：一批声明式用例自动跑分（程序化检查 + LLM-as-Judge），出成绩单，并把结果写成 `eval-results.json`（RL/微调的种子数据）。`pnpm eval` 一键跑。

**Architecture:** `runEvalSuite(cases, runCase, judge?)` 纯编排——对每个用例跑 agent、按 `expect` 选择打分器评分、聚合成 `EvalReport`。agent 运行（`runCase`）与裁判（`judge`）都注入，所以 harness + 打分器用假依赖确定性单测；`eval.ts`（`pnpm eval`）才接真 agent + 真裁判。打分器：程序化（contains/toolUsed/cites/refuses）+ LLM-as-Judge（rubric 评分）。

**Tech Stack:** 沿用，无新依赖。微调以「可替换 `makeCallModel`（换成微调模型）」+「eval-results.json 种子数据」体现，不在本项目真训练。

---

## 文件结构（Stage 5）

| 文件 | 职责 | 测试 |
|------|------|------|
| `src/eval/scorers.ts`（新） | 程序化打分器 + `makeJudge`/`parseJudge`（LLM-as-Judge） | scorers.test.ts |
| `src/eval/harness.ts`（新） | `EvalCase`/`RunOutput`/`EvalReport` + `runEvalSuite` | harness.test.ts |
| `evals/cases.ts`（新） | ~8 个声明式用例 | — |
| `eval.ts`（新，根目录） | `pnpm eval`：接真 agent 批量跑 + 成绩单 + 写 JSON | 真机验证 |
| `package.json`（改） | 加 `"eval": "tsx eval.ts"` | — |
| `.gitignore`（改） | 忽略 `eval-results.json` | — |
| `README.md`（改） | 勾选 Stage 5 概念 | — |

> 说明：`eval.ts` 自包含地搭建工具运行时（embedding + 两个 MCP server + 注册表），用一个**不带缓存/不流式**的 `makeCallModel` 让每个用例真跑。与 `cli.ts` 有少量设置重复——本阶段刻意不抽公共运行时以免再动已稳定的 `cli.ts`。

---

## Task 1: 打分器 `src/eval/scorers.ts`

**Files:** Create `src/eval/scorers.ts`; Test `tests/scorers.test.ts`

- [ ] **Step 1: 写失败测试 `tests/scorers.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest'
import {
  checkContainsAny,
  checkToolUsed,
  checkCites,
  checkRefuses,
  parseJudge,
  makeJudge,
} from '../src/eval/scorers'
import type { Message, ModelResult } from '../src/types'

describe('programmatic scorers', () => {
  it('checkContainsAny passes when any keyword is present', () => {
    expect(checkContainsAny('今天 22 度晴', ['晴', '雨']).pass).toBe(true)
    expect(checkContainsAny('多云', ['晴', '雨']).pass).toBe(false)
  })
  it('checkToolUsed passes when the expected tool was used', () => {
    expect(checkToolUsed(['get_weather'], 'get_weather').pass).toBe(true)
    expect(checkToolUsed(['search_notes'], 'get_weather').pass).toBe(false)
  })
  it('checkCites passes when a source is cited', () => {
    expect(checkCites('……（来源：01-rag.md）').pass).toBe(true)
    expect(checkCites('随便说说').pass).toBe(false)
  })
  it('checkRefuses passes when the answer declines instead of fabricating', () => {
    expect(checkRefuses('笔记里没有相关内容').pass).toBe(true)
    expect(checkRefuses('Rust 所有权是这样的……').pass).toBe(false)
  })
})

describe('parseJudge', () => {
  it('parses a pass/reason JSON', () => {
    expect(parseJudge('{"pass": true, "reason": "符合"}')).toEqual({ pass: true, reason: '符合' })
  })
  it('falls back to fail on garbage', () => {
    expect(parseJudge('???').pass).toBe(false)
  })
})

describe('makeJudge', () => {
  it('asks the judge with the rubric + answer and returns its verdict', async () => {
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      expect(messages.at(-1)!.content).toContain('评分标准')
      expect(messages.at(-1)!.content).toContain('要点齐全')
      return { text: '{"pass": true, "reason": "ok"}', toolCalls: [] }
    })
    const judge = makeJudge(callModel)
    const v = await judge({ question: 'q', answer: 'a', evidence: ['e'], rubric: '要点齐全' })
    expect(v.pass).toBe(true)
    expect(callModel).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行 `pnpm test scorers` 确认失败。**

- [ ] **Step 3: 写 `src/eval/scorers.ts`**
```ts
import type { CallModel } from '../types'

export interface CheckResult {
  name: string
  pass: boolean
  detail?: string
}

export function checkContainsAny(answer: string, keywords: string[]): CheckResult {
  const hit = keywords.find((k) => answer.includes(k))
  return {
    name: 'containsAny',
    pass: Boolean(hit),
    detail: hit ? `命中「${hit}」` : `缺少 ${keywords.join('/')}`,
  }
}

export function checkToolUsed(toolsUsed: string[], expected: string): CheckResult {
  return {
    name: 'toolUsed',
    pass: toolsUsed.includes(expected),
    detail: `期望 ${expected}，实际用到 [${toolsUsed.join(', ')}]`,
  }
}

export function checkCites(answer: string): CheckResult {
  const cited = /来源[:：]/.test(answer) || /[\w-]+\.md/.test(answer)
  return { name: 'cites', pass: cited, detail: cited ? '已注明来源' : '未注明来源' }
}

export function checkRefuses(answer: string): CheckResult {
  const refused = /没有|未找到|找不到|不确定|无法|笔记里(没|未)/.test(answer)
  return { name: 'refuses', pass: refused, detail: refused ? '正确拒答' : '可能编造' }
}

export interface JudgeInput {
  question: string
  answer: string
  evidence: string[]
  rubric: string
}
export type JudgeFn = (input: JudgeInput) => Promise<{ pass: boolean; reason: string }>

export function parseJudge(text: string): { pass: boolean; reason: string } {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    const obj = JSON.parse(m ? m[0] : text) as { pass?: unknown; reason?: unknown }
    return { pass: Boolean(obj.pass), reason: String(obj.reason ?? '') }
  } catch {
    return { pass: false, reason: '无法解析裁判输出' }
  }
}

export function makeJudge(callModel: CallModel): JudgeFn {
  return async ({ question, answer, evidence, rubric }) => {
    const prompt =
      `评分标准：${rubric}\n\n` +
      `问题：${question}\n\n` +
      `证据（工具/检索返回）：\n${evidence.join('\n---\n') || '（无）'}\n\n` +
      `答案：\n${answer}\n\n` +
      `按评分标准判断答案是否合格。只输出 JSON：{"pass": true 或 false, "reason": "简短理由"}`
    const result = await callModel([
      { role: 'system', content: '你是严格的评测裁判。只依据评分标准与证据判断，只输出 JSON。' },
      { role: 'user', content: prompt },
    ])
    return parseJudge(result.text)
  }
}
```

- [ ] **Step 4: 运行 `pnpm test scorers` 确认通过（7）。**

- [ ] **Step 5: Commit**
```bash
git add src/eval/scorers.ts tests/scorers.test.ts
git commit -m "feat: eval scorers (programmatic + LLM-as-Judge)"
```

---

## Task 2: harness `src/eval/harness.ts`

**Files:** Create `src/eval/harness.ts`; Test `tests/harness.test.ts`

- [ ] **Step 1: 写失败测试 `tests/harness.test.ts`**
```ts
import { describe, it, expect, vi } from 'vitest'
import { runEvalSuite, type EvalCase, type RunCase } from '../src/eval/harness'

const cases: EvalCase[] = [
  { name: 'a', input: 'qa', expect: { containsAny: ['好'] } },
  { name: 'b', input: 'qb', expect: { toolUsed: 'get_weather' } },
]

describe('runEvalSuite', () => {
  it('runs each case, scores via the relevant checks, and aggregates', async () => {
    const runCase: RunCase = async (input) =>
      input === 'qa'
        ? { answer: '很好', toolsUsed: [], evidence: [] }
        : { answer: '', toolsUsed: ['get_weather'], evidence: [] }
    const report = await runEvalSuite(cases, runCase)
    expect(report.total).toBe(2)
    expect(report.passed).toBe(2)
    expect(report.passRate).toBe(1)
    expect(report.results[0].checks[0].name).toBe('containsAny')
  })

  it('marks a case failed when a check fails', async () => {
    const runCase: RunCase = async () => ({ answer: '坏', toolsUsed: [], evidence: [] })
    const report = await runEvalSuite(
      [{ name: 'x', input: 'q', expect: { containsAny: ['好'] } }],
      runCase,
    )
    expect(report.passed).toBe(0)
    expect(report.results[0].pass).toBe(false)
  })

  it('uses the injected judge for rubric cases', async () => {
    const judge = vi.fn(async () => ({ pass: true, reason: 'ok' }))
    const runCase: RunCase = async () => ({ answer: 'a', toolsUsed: [], evidence: ['e'] })
    const report = await runEvalSuite(
      [{ name: 'j', input: 'q', expect: { rubric: '标准' } }],
      runCase,
      judge,
    )
    expect(judge).toHaveBeenCalledOnce()
    expect(report.results[0].checks[0].name).toBe('judge')
    expect(report.passed).toBe(1)
  })
})
```

- [ ] **Step 2: 运行 `pnpm test harness` 确认失败。**

- [ ] **Step 3: 写 `src/eval/harness.ts`**
```ts
import {
  checkContainsAny,
  checkToolUsed,
  checkCites,
  checkRefuses,
  type CheckResult,
  type JudgeFn,
} from './scorers'

export interface RunOutput {
  answer: string
  toolsUsed: string[]
  evidence: string[]
}

export interface CaseExpectation {
  containsAny?: string[]
  toolUsed?: string
  cites?: boolean
  refuses?: boolean
  rubric?: string
}

export interface EvalCase {
  name: string
  input: string
  expect: CaseExpectation
}

export interface CaseResult {
  name: string
  input: string
  answer: string
  checks: CheckResult[]
  pass: boolean
}

export interface EvalReport {
  results: CaseResult[]
  passed: number
  total: number
  passRate: number
}

export type RunCase = (input: string) => Promise<RunOutput>

export async function runEvalSuite(
  cases: EvalCase[],
  runCase: RunCase,
  judge?: JudgeFn,
): Promise<EvalReport> {
  const results: CaseResult[] = []
  for (const c of cases) {
    const run = await runCase(c.input)
    const checks: CheckResult[] = []
    if (c.expect.containsAny) checks.push(checkContainsAny(run.answer, c.expect.containsAny))
    if (c.expect.toolUsed) checks.push(checkToolUsed(run.toolsUsed, c.expect.toolUsed))
    if (c.expect.cites) checks.push(checkCites(run.answer))
    if (c.expect.refuses) checks.push(checkRefuses(run.answer))
    if (c.expect.rubric && judge) {
      const v = await judge({
        question: c.input,
        answer: run.answer,
        evidence: run.evidence,
        rubric: c.expect.rubric,
      })
      checks.push({ name: 'judge', pass: v.pass, detail: v.reason })
    }
    const pass = checks.length > 0 && checks.every((ch) => ch.pass)
    results.push({ name: c.name, input: c.input, answer: run.answer, checks, pass })
  }
  const passed = results.filter((r) => r.pass).length
  const total = results.length
  return { results, passed, total, passRate: total ? passed / total : 0 }
}
```

- [ ] **Step 4: 运行 `pnpm test harness` 确认通过（3）。**

- [ ] **Step 5: Commit**
```bash
git add src/eval/harness.ts tests/harness.test.ts
git commit -m "feat: eval harness — runEvalSuite (inject runCase + judge)"
```

---

## Task 3: 用例 + eval CLI + script + README + 验证

**Files:** Create `evals/cases.ts`, `eval.ts`; Modify `package.json`, `.gitignore`, `README.md`

- [ ] **Step 1: 写 `evals/cases.ts`**
```ts
import type { EvalCase } from '../src/eval/harness'

export const cases: EvalCase[] = [
  {
    name: 'weather-via-mcp',
    input: '北京今天天气怎么样？',
    expect: { toolUsed: 'get_weather', containsAny: ['晴', '22'] },
  },
  {
    name: 'rag-chunking',
    input: '根据我的笔记，RAG 里 chunking 为什么重要？',
    expect: {
      toolUsed: 'search_notes',
      cites: true,
      rubric: '答案应基于笔记，解释 chunk 切太大语义被平均、太小丢上下文。',
    },
  },
  {
    name: 'rag-eval-harness',
    input: '根据笔记，Eval 和 Harness 是什么关系？',
    expect: { toolUsed: 'search_notes', rubric: '答案应说明 Harness 是跑 eval 的那套基础设施。' },
  },
  {
    name: 'skill-code-review',
    input: '用 code-review 技能评审这段代码：function add(a,b){return a-b}',
    expect: { toolUsed: 'get_skill', containsAny: ['减', 'subtract', '正确性'] },
  },
  {
    name: 'hallucination-refusal',
    input: '根据我的笔记，详细讲讲 Rust 的所有权机制',
    expect: {
      refuses: true,
      rubric: '笔记里没有 Rust 内容，答案应表明没有相关笔记/不确定，而不是编造所有权细节。',
    },
  },
  {
    name: 'list-notes-external-mcp',
    input: '列出我 notes 目录里有哪些文件',
    expect: { containsAny: ['01-rag', '.md'] },
  },
  {
    name: 'embedding-cosine',
    input: '根据笔记，为什么文本检索常用余弦相似度？',
    expect: { toolUsed: 'search_notes', rubric: '答案应提到关心方向/语义而非长度。' },
  },
  {
    name: 'plain-greeting',
    input: '你好，简单介绍下你自己',
    expect: { rubric: '应是简短自我介绍，不编造事实，可不调用任何工具。' },
  },
]
```

- [ ] **Step 2: 写 `eval.ts`（根目录）**
```ts
import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import { loadConfig } from './src/config'
import { makeSearchNotesTool } from './src/tools/searchNotes'
import { makeEmbedder } from './src/rag/embed'
import { buildNotesIndex } from './src/rag/index'
import { makeCallModel } from './src/llm'
import { runAgent, type TurnInfo } from './src/agent'
import { loadMcpToolsFromServers } from './src/mcp/client'
import { runEvalSuite, type RunCase } from './src/eval/harness'
import { makeJudge } from './src/eval/scorers'
import { cases } from './evals/cases'

async function main() {
  const config = loadConfig()

  console.error('构建 eval 运行时（embedding + MCP）…')
  const embed = await makeEmbedder(config)
  const store = await buildNotesIndex({ notesDir: config.notesDir, embed })
  const fsDir = process.env.MCP_FS_DIR ?? './notes'
  const mcp = await loadMcpToolsFromServers([
    { command: 'npx', args: ['tsx', 'mcp-server.ts'] },
    { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', fsDir] },
  ])
  try {
    const searchTool = makeSearchNotesTool({ store, embed })
    const registry = { ...mcp.tools, [searchTool.name]: searchTool }
    // eval：每个用例真跑——用不带缓存/不流式的 callModel
    const callModel = makeCallModel(config, registry)
    const judge = makeJudge(makeCallModel(config, {}))

    const runCase: RunCase = async (input) => {
      const toolsUsed: string[] = []
      const evidence: string[] = []
      const onTurn = (info: TurnInfo) => {
        for (const call of info.result.toolCalls) toolsUsed.push(call.name)
        for (const tr of info.toolResults) evidence.push(`${tr.name}: ${tr.output}`)
      }
      const answer = await runAgent(input, { callModel, tools: registry, config, onTurn })
      return { answer, toolsUsed, evidence }
    }

    console.error(`跑 ${cases.length} 个用例…\n`)
    const report = await runEvalSuite(cases, runCase, judge)

    for (const r of report.results) {
      console.log(`${r.pass ? '✅' : '❌'} ${r.name}`)
      for (const ch of r.checks) {
        console.log(`   ${ch.pass ? '·' : '✗'} ${ch.name}${ch.detail ? '：' + ch.detail : ''}`)
      }
    }
    console.log(`\n通过 ${report.passed}/${report.total}（${Math.round(report.passRate * 100)}%）`)

    await writeFile('eval-results.json', JSON.stringify(report, null, 2), 'utf8')
    console.error('\n结果已写入 eval-results.json（可作 RL/微调的种子数据）')
  } finally {
    await mcp.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 3: `package.json` 的 scripts 加一行**
```json
    "eval": "tsx eval.ts",
```
（放在 `"dev"` 之后即可，注意保留逗号 JSON 合法。）

- [ ] **Step 4: `.gitignore` 末尾追加**
```
eval-results.json
```

- [ ] **Step 5: README**
（a）「### 阶段 5 — Eval Harness」整段替换为：
```
### 阶段 5 — Eval Harness ✅
- [x] 测试体系 / Eval（runEvalSuite：程序化 + LLM-as-Judge，`pnpm eval`）
- [x] 微调（认知 + 可替换 llm 接口：换 `DEEPSEEK_MODEL` 即换模型；eval-results.json 作种子数据）
```
（b）在「## Stage 4b 在做什么」之后新增：
```
## Stage 5 在做什么

给整个 agent 套评估系统：`evals/cases.ts` 放声明式用例，`runEvalSuite` 对每个用例跑 agent、按 `expect` 选打分器评分、聚合成成绩单。
打分器两类：程序化（contains/toolUsed/cites/refuses）+ LLM-as-Judge（rubric 评分，开放式答案没法字符串匹配只能让模型评）。
harness 与裁判都注入，所以逻辑可确定性单测；`pnpm eval` 才接真 agent。

> 跑分：`pnpm eval`（需 DeepSeek key，会真跑每个用例）。结果写入 `eval-results.json`。
> 这份结果就是你之前学的「会增值的测试集 / RL 与微调的种子数据」的最小形态——改 prompt/换模型后再跑，看分数涨没涨。
> 微调：本项目不真训练；它体现在「换 `DEEPSEEK_MODEL` 就换模型」这个可替换接口，和 eval 产出的数据资产上。
```
（c）「## 结构」追加：
```
src/eval/      scorers + harness（评估打分）
evals/cases.ts 评估用例
eval.ts        pnpm eval 入口
```

- [ ] **Step 6: 全量测试 + 类型检查**
Run: `pnpm test && pnpm typecheck`
Expected: 63（4b 末）+ scorers 7 + harness 3 = 73 个测试通过，typecheck 干净（含 eval.ts / evals/cases.ts）。

- [ ] **Step 7: Commit**
```bash
git add evals/cases.ts eval.ts package.json .gitignore README.md
git commit -m "feat: eval cases + pnpm eval CLI scoreboard; stage 5 runnable"
```

- [ ] **Step 8: 真机验证（留给用户，需 DeepSeek key）**
```bash
pnpm eval
```
Expected：逐个用例打印 ✅/❌ 及各 check 明细，末尾「通过 N/8（xx%）」，并生成 `eval-results.json`。个别用例（尤其 rubric/refusal）可能因模型发挥时过时不过，属正常——eval 的意义是量化、可对比，不是必须满分。

---

## Self-Review（已核对）

**Spec coverage：** Stage 5 = 测试体系/Eval + 微调。Eval = scorers(Task1) + harness(Task2) + cases/eval CLI(Task3)，程序化 + LLM-as-Judge 两类打分器齐备。微调 = README 说明「可替换 llm 接口 + eval-results.json 种子数据」，并勾选认知项。

**Placeholder scan：** 无 TBD/TODO。eval.ts 标注「真机验证」并给完整实现；harness/scorers 用假 runCase/假 judge/假 callModel 确定性单测。

**Type consistency：** `CheckResult`/`JudgeFn`/`JudgeInput`/`checkContainsAny`/`checkToolUsed`/`checkCites`/`checkRefuses`/`parseJudge`/`makeJudge` 定义于 scorers.ts；`RunOutput`/`CaseExpectation`/`EvalCase`/`CaseResult`/`EvalReport`/`RunCase`/`runEvalSuite` 定义于 harness.ts 并从 scorers 引入 check 函数与 `JudgeFn`/`CheckResult`。`evals/cases.ts` 用 `EvalCase`；`eval.ts` 用 `RunCase`/`makeJudge`/`runEvalSuite`，复用既有 `makeCallModel`/`runAgent`/`loadMcpToolsFromServers` 等，签名一致。eval 用不带缓存/流式的 `makeCallModel`，每个用例 `runAgent` 无 history（互不污染）。
