import { describe, it, expect } from 'vitest'
import { parseSources } from '../../electron/renderer/src/sources'
import type { ToolCallEvent } from '../../electron/shared/channels'

const event = (over: Partial<ToolCallEvent> = {}): ToolCallEvent => ({
  sessionId: 's1',
  turn: 1,
  toolName: 'search_notes',
  args: { query: 'x' },
  output: '{"query":"x","hits":[]}',
  ...over,
})

describe('parseSources', () => {
  it('解析 search_notes 的成功输出，chars 取自 text 长度', () => {
    const output = JSON.stringify({
      query: 'x',
      hits: [
        { source: '01-rag.md', score: 0.8721, text: '一二三四五' },
        { source: '02-agent.md', score: 0.5, text: 'abcdefghij' },
      ],
    })
    const result = parseSources([event({ output })])
    expect(result).toEqual([
      { source: '01-rag.md', score: 0.8721, chars: 5 },
      { source: '02-agent.md', score: 0.5, chars: 10 },
    ])
  })

  it('忽略非 search_notes 的工具调用', () => {
    const output = JSON.stringify({ hits: [{ source: 'x.md', score: 1, text: 'abc' }] })
    const result = parseSources([event({ toolName: 'get_weather', output })])
    expect(result).toEqual([])
  })

  it('工具失败的 {"error": ...} 输出不产生来源，也不抛异常', () => {
    expect(() => parseSources([event({ output: '{"error":"boom"}' })])).not.toThrow()
    expect(parseSources([event({ output: '{"error":"boom"}' })])).toEqual([])
  })

  it('非法 JSON 不抛异常，返回空数组', () => {
    expect(() => parseSources([event({ output: 'not json{' })])).not.toThrow()
    expect(parseSources([event({ output: 'not json{' })])).toEqual([])
  })

  it('hits 缺失或不是数组时返回空数组', () => {
    expect(parseSources([event({ output: '{}' })])).toEqual([])
    expect(parseSources([event({ output: '{"hits":"nope"}' })])).toEqual([])
  })

  it('单条 hit 字段类型不对时跳过它，不影响同一输出里的其它合法 hit', () => {
    const output = JSON.stringify({
      hits: [
        { source: 'good.md', score: 0.9, text: 'abcde' },
        { source: 123, score: 0.9, text: 'abcde' }, // source 不是字符串
        { source: 'bad.md', score: 'high', text: 'abcde' }, // score 不是数字
        { source: 'bad2.md', score: 0.5, text: null }, // text 不是字符串
        null, // 整条不是对象
      ],
    })
    const result = parseSources([event({ output })])
    expect(result).toEqual([{ source: 'good.md', score: 0.9, chars: 5 }])
  })

  it('跨多个 turn 的 search_notes 调用按顺序拼接，不去重', () => {
    const out1 = JSON.stringify({ hits: [{ source: 'a.md', score: 0.9, text: 'abc' }] })
    const out2 = JSON.stringify({ hits: [{ source: 'a.md', score: 0.7, text: 'abcdef' }] })
    const result = parseSources([
      event({ turn: 1, output: out1 }),
      event({ turn: 2, output: out2 }),
    ])
    expect(result).toEqual([
      { source: 'a.md', score: 0.9, chars: 3 },
      { source: 'a.md', score: 0.7, chars: 6 },
    ])
  })

  it('空工具事件数组返回空数组', () => {
    expect(parseSources([])).toEqual([])
  })
})
