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
    expect(checkRefuses('我不确定，笔记里查不到相关信息').pass).toBe(true)
    expect(checkRefuses('Rust 所有权是这样的……').pass).toBe(false)
  })
  it('checkRefuses does not count a bare 没有 inside a fabricated answer', () => {
    // 编造但句中含「没有」——不应被当成拒答
    expect(checkRefuses('Rust 中值没有被复制而是移动').pass).toBe(false)
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
