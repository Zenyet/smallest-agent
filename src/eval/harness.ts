// ============================================================================
// harness.ts —— 评估套件执行引擎：跑用例、选打分器、聚合报告
// ----------------------------------------------------------------------------
// Stage 5 的评估基础设施。把「如何运行 agent」和「如何评分」解耦：
//   - RunCase 由外部（eval.ts）注入，决定如何真正跑 agent；
//   - judge 同样注入，决定 LLM-as-Judge 用哪个模型；
//   - harness 自身只负责「对每个 EvalCase 调 runCase → 选打分器 → 聚合」。
// 这种设计让 harness 可以在纯确定性的单测里替换成假 runCase + 假 judge，
// 无需真实模型也能验证打分逻辑。
// ============================================================================

import {
  checkContainsAny,
  checkToolUsed,
  checkCites,
  checkRefuses,
  type CheckResult,
  type JudgeFn,
} from './scorers'

// 一次 agent 运行的结果：最终答案文本、调用过的工具名列表、以及收集到的证据原文。
// evidence 从 onTurn 里的 toolResults 拼出，供 LLM-as-Judge 核查。
export interface RunOutput {
  answer: string
  toolsUsed: string[]
  evidence: string[]
}

// 单个评估用例的「期望」声明。每个字段对应一个打分器维度，
// 未声明的维度不参与打分——这样不同用例可以只关心自己在意的能力。
export interface CaseExpectation {
  containsAny?: string[]   // 答案必须包含这些关键字之一（程序化）
  toolUsed?: string        // 必须调用了该工具（程序化）
  cites?: boolean          // 必须注明来源（程序化，RAG 用例）
  refuses?: boolean        // 必须正确拒答（程序化+启发式，幻觉用例）
  rubric?: string          // 语义评分标准（LLM-as-Judge，需要传入 judge）
}

// 一个声明式的评估用例：输入问题 + 期望。不含任何运行逻辑，纯数据。
export interface EvalCase {
  name: string
  input: string
  expect: CaseExpectation
}

// 一个用例跑完后的完整结果快照：含每个 check 的通过/失败细节，
// 以及最终的 pass（所有 checks 全通过才算整体通过）。
export interface CaseResult {
  name: string
  input: string
  answer: string
  checks: CheckResult[]
  pass: boolean
}

// 整套 eval 的聚合报告，包含原始结果列表 + 汇总数字。
// passRate 范围 [0, 1]，可直接用于 CI 阈值判断。
export interface EvalReport {
  results: CaseResult[]
  passed: number
  total: number
  passRate: number
}

// RunCase 是「如何运行一个用例」的抽象。由调用方（eval.ts）注入，
// 内部包含真实的 runAgent 调用；单测里可以替换成返回固定内容的假实现。
export type RunCase = (input: string) => Promise<RunOutput>

// 核心函数：顺序跑所有 EvalCase，对每个用例按 expect 字段选择打分器，
// 汇总成 EvalReport。顺序执行（不并发）以避免多个真实 agent 同时跑的资源竞争。
//
// 依赖注入要点：
//   - runCase 注入 → 可确定性单测，无需真实模型
//   - judge 注入   → 可换用不同评审模型，或在单测里用假裁判
//   - rubric 用例若没传 judge 会显式 fail（detail 说明原因），而非静默跳过
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
    if (c.expect.rubric) {
      if (judge) {
        const v = await judge({
          question: c.input,
          answer: run.answer,
          evidence: run.evidence,
          rubric: c.expect.rubric,
        })
        checks.push({ name: 'judge', pass: v.pass, detail: v.reason })
      } else {
        // rubric 用例但没传 judge：显式失败并说明原因，而不是悄悄变成空 checks 的失败
        checks.push({ name: 'judge', pass: false, detail: '需要 judge 但未提供' })
      }
    }
    // checks 为空（expect 一个字段都没声明）时视为失败，避免空 case 静默通过。
    const pass = checks.length > 0 && checks.every((ch) => ch.pass)
    results.push({ name: c.name, input: c.input, answer: run.answer, checks, pass })
  }
  const passed = results.filter((r) => r.pass).length
  const total = results.length
  return { results, passed, total, passRate: total ? passed / total : 0 }
}
