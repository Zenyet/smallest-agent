import { describe, it, expect, vi } from 'vitest'
import { estimateTokens, compactMessages } from '../src/memory/compact'
import type { Message } from '../src/types'

const x = (n: number) => 'x'.repeat(n)

describe('estimateTokens', () => {
  it('approximates non-CJK text as chars / 4', () => {
    expect(estimateTokens([{ role: 'user', content: x(40) }])).toBe(10)
  })
  it('counts CJK characters as ~1 token each', () => {
    expect(estimateTokens([{ role: 'user', content: '你好世界' }])).toBe(4)
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
  it('drops a leading orphan tool result so the kept window stays API-valid', async () => {
    const summarize = vi.fn(async () => 'S')
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: x(100) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
      { role: 'tool', content: '{}', toolCallId: 'c1', name: 't' },
      { role: 'assistant', content: 'final' },
    ]
    // keepRecent=2 would slice [tool, assistant] — the leading tool result is orphaned and must be dropped
    const out = await compactMessages(msgs, { maxTokens: 1, keepRecent: 2, summarize })
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    expect(out.at(-1)).toEqual({ role: 'assistant', content: 'final' })
  })
})
