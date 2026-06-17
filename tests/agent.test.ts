import { describe, it, expect, vi } from 'vitest'
import { runAgent } from '../src/agent'
import type { Message, ModelResult, ToolRegistry } from '../src/types'

const tools: ToolRegistry = {
  get_weather: {
    name: 'get_weather',
    description: '',
    parameters: {},
    run: (a: { city: string }) => ({ city: a.city, temperature: 22 }),
  },
}
const config = { systemPrompt: 'sys', maxTurns: 5 }

describe('runAgent', () => {
  it('returns text in one turn when no tool is called', async () => {
    const callModel = vi.fn(async (): Promise<ModelResult> => ({ text: '你好！', toolCalls: [] }))
    const out = await runAgent('hi', { callModel, tools, config })
    expect(out).toBe('你好！')
    expect(callModel).toHaveBeenCalledTimes(1)
  })

  it('runs a tool, feeds the result back, then returns the final answer', async () => {
    const seen: Message[][] = []
    const callModel = vi.fn(async (messages: Message[]): Promise<ModelResult> => {
      seen.push(structuredClone(messages))
      if (callModel.mock.calls.length === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: '北京' } }] }
      }
      return { text: '北京今天 22 度。', toolCalls: [] }
    })
    const out = await runAgent('北京天气', { callModel, tools, config })
    expect(out).toBe('北京今天 22 度。')
    expect(callModel).toHaveBeenCalledTimes(2)
    const second = seen[1]
    const toolMsg = second.find((m) => m.role === 'tool')
    expect(toolMsg?.toolCallId).toBe('c1')
    expect(JSON.parse(toolMsg!.content)).toMatchObject({ city: '北京' })
  })

  it('throws after exceeding maxTurns when the model never finishes', async () => {
    const callModel = vi.fn(async (): Promise<ModelResult> => ({
      text: '',
      toolCalls: [{ id: 'x', name: 'get_weather', args: { city: '北京' } }],
    }))
    await expect(
      runAgent('loop', { callModel, tools, config: { systemPrompt: 's', maxTurns: 3 } }),
    ).rejects.toThrow(/maxTurns/)
    expect(callModel).toHaveBeenCalledTimes(3)
  })

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
})
