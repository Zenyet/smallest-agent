import { describe, it, expect } from 'vitest'
import { truncateAtNthUser } from '../../electron/main/truncate'
import type { Message } from '../../src/types'

// 一段有工具调用的真实形状历史：磁盘上一轮是「带 toolCalls 的 assistant →
// tool 结果 → 有正文的 assistant」好几条，界面上压成一个气泡。
// 这正是不能按界面下标砍的原因（见 truncate.ts 的文件头）。
const history: Message[] = [
  { role: 'user', content: '第一个问题' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'search_notes', args: { q: 'x' } }],
  },
  { role: 'tool', content: '{"hits":[]}', toolCallId: 'c1', name: 'search_notes' },
  { role: 'assistant', content: '第一个答案' },
  { role: 'user', content: '第二个问题' },
  { role: 'assistant', content: '第二个答案' },
  { role: 'user', content: '第三个问题' },
  { role: 'assistant', content: '第三个答案' },
]

describe('truncateAtNthUser', () => {
  it('砍第 0 条 user 之前 —— 整段清空（那条本身也砍掉）', () => {
    expect(truncateAtNthUser(history, 0)).toEqual([])
  })

  // 这一条是这个函数存在的理由：第 1 条 user 在磁盘上的下标是 4，而界面上
  // 它的下标是 2（工具那三条被压成一个气泡）。按界面下标砍会砍在
  // 「调了工具但没有结果」的位置上。
  it('砍第 1 条 user 之前 —— 前一轮完整保留，含工具轨迹', () => {
    const out = truncateAtNthUser(history, 1)
    expect(out).toHaveLength(4)
    expect(out.at(-1)).toEqual({ role: 'assistant', content: '第一个答案' })
    // 工具调用和它的结果要成对留下，不能砍在中间
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(out.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(true)
  })

  it('砍最后一条 user 之前 —— 留下它前面的全部', () => {
    const out = truncateAtNthUser(history, 2)
    expect(out).toHaveLength(6)
    expect(out.at(-1)).toEqual({ role: 'assistant', content: '第二个答案' })
  })

  // 越界不该静默清空历史 —— 那是最坏的失败方式（用户编辑一条消息，
  // 结果整个会话空了）。原样返回是安全的那一侧。
  it('nthUser 越界时原样返回，不清空', () => {
    expect(truncateAtNthUser(history, 3)).toEqual(history)
    expect(truncateAtNthUser(history, 99)).toEqual(history)
  })

  it('负数也原样返回', () => {
    expect(truncateAtNthUser(history, -1)).toEqual(history)
  })

  it('空历史不炸', () => {
    expect(truncateAtNthUser([], 0)).toEqual([])
  })

  // system 是我们注入的，不是对话内容，不该被当成锚点
  it('system 消息不影响 user 的计数', () => {
    const withSystem: Message[] = [
      { role: 'system', content: '你是一个助手' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'b' },
    ]
    const out = truncateAtNthUser(withSystem, 1)
    expect(out).toHaveLength(3)
    expect(out.at(-1)).toEqual({ role: 'assistant', content: 'A' })
  })

  it('不改原数组（调用方可能还拿着它）', () => {
    const copy = [...history]
    truncateAtNthUser(history, 1)
    expect(history).toEqual(copy)
  })
})
