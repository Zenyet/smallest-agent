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

  it('fails a rubric case with an explicit diagnostic when no judge is supplied', async () => {
    const runCase: RunCase = async () => ({ answer: 'a', toolsUsed: [], evidence: [] })
    const report = await runEvalSuite([{ name: 'j', input: 'q', expect: { rubric: '标准' } }], runCase)
    expect(report.passed).toBe(0)
    expect(report.results[0].checks[0]).toMatchObject({ name: 'judge', pass: false })
    expect(report.results[0].checks[0].detail).toContain('judge')
  })
})
