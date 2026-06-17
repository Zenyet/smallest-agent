import { describe, it, expect } from 'vitest'
import { formatTurn } from '../src/trace'

describe('formatTurn', () => {
  it('renders tool calls and tool results in a readable string', () => {
    const s = formatTurn({
      turn: 1,
      result: { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: '北京' } }] },
      toolResults: [{ name: 'get_weather', args: { city: '北京' }, output: '{"city":"北京"}' }],
    })
    expect(s).toContain('turn 1')
    expect(s).toContain('get_weather')
    expect(s).toContain('北京')
  })

  it('renders the assistant text when present', () => {
    const s = formatTurn({ turn: 2, result: { text: '搞定了', toolCalls: [] }, toolResults: [] })
    expect(s).toContain('搞定了')
  })

  it('omits the assistant text when showText is false', () => {
    const s = formatTurn(
      { turn: 1, result: { text: '机密答案', toolCalls: [] }, toolResults: [] },
      { showText: false },
    )
    expect(s).not.toContain('机密答案')
    expect(s).toContain('turn 1')
  })
})
