import { describe, it, expect, vi } from 'vitest'
import { makeSummarizer } from '../src/memory/summarize'
import type { Message, ModelResult } from '../src/types'

describe('makeSummarizer', () => {
  it('renders the conversation and returns the model summary text', async () => {
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      expect(messages.at(-1)!.content).toContain('我叫 Roy')
      return { text: '用户叫 Roy', toolCalls: [] }
    })
    const summarize = makeSummarizer(callModel)
    const out = await summarize([{ role: 'user', content: '我叫 Roy' }])
    expect(out).toBe('用户叫 Roy')
    expect(callModel).toHaveBeenCalledOnce()
  })
})
