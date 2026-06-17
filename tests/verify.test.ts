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
      const prompt = messages.at(-1)!.content
      expect(prompt).toContain('北京今天 22 度') // 答案
      expect(prompt).toContain('get_weather') // 证据
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
