import { describe, it, expect } from 'vitest'
import { sessionTitle } from '../../electron/main/sessions'
import {
  lockAutoTitle,
  forgetAutoTitle,
  normalizeAutoTitles,
  type AutoTitles,
} from '../../electron/main/session-titles'
import type { Message } from '../../src/types'

// ============================================================================
// 侧边栏的会话名字第一次就定下，之后不再变
//
// 用户报：「左侧对话名称第一次就确定，不要再随后续的提问而变化」。
//
// 原因是标题每次 listSessions 都从**当前文件**重推，而文件内容会变：
//   • 上下文压缩把 `【之前对话摘要】…` 插到历史最前面，role 是 'user'
//     （compact.ts:59，那样才能过持久化的 filter）
//   • 编辑重发砍掉前面几轮，第一条 user 换人
//
// 实测的真实会话文件里两种都出现过。
// ============================================================================

describe('sessionTitle 跳过压缩摘要', () => {
  it('摘要在最前面时取真正的第一条用户消息', () => {
    const history: Message[] = [
      { role: 'user', content: '【之前对话摘要】\n## 对话摘要\n- **任务背景**：用户希望…' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '这个是什么' },
    ]
    // 不该是那段摘要
    expect(sessionTitle(history)).toBe('这个是什么')
  })

  it('全是摘要时退回「新会话」，不显示一大段 markdown', () => {
    const history: Message[] = [
      { role: 'user', content: '【之前对话摘要】\n## 对话摘要\n很长很长…' },
    ]
    expect(sessionTitle(history)).toBe('新会话')
  })

  it('正常历史不受影响', () => {
    expect(sessionTitle([{ role: 'user', content: '你是谁' }])).toBe('你是谁')
  })

  it('多行输入折叠空白（否则撑变形侧边栏）', () => {
    expect(sessionTitle([{ role: 'user', content: '第一行\n第二行' }])).toBe('第一行 第二行')
  })
})

describe('自动标题锁定', () => {
  it('第一次锁上', () => {
    const after = lockAutoTitle({}, 's1', '第一个问题')
    expect(after.s1).toBe('第一个问题')
  })

  // ## 这一条是整个修复的核心
  it('已经锁过就不覆盖 —— 名字从此不变', () => {
    const locked: AutoTitles = { s1: '第一个问题' }
    const after = lockAutoTitle(locked, 's1', '完全不同的新标题')
    expect(after.s1).toBe('第一个问题')
    // 没变化时原样返回同一个对象，调用方靠引用比较跳过写盘
    expect(after).toBe(locked)
  })

  it('空标题和「新会话」不锁 —— 等有真内容再定', () => {
    expect(lockAutoTitle({}, 's1', '')).toEqual({})
    expect(lockAutoTitle({}, 's1', '   ')).toEqual({})
    expect(lockAutoTitle({}, 's1', '新会话')).toEqual({})
  })

  it('超长标题截断', () => {
    const after = lockAutoTitle({}, 's1', 'x'.repeat(200))
    expect(after.s1!.length).toBe(60)
  })

  it('不同会话各自独立', () => {
    let t: AutoTitles = {}
    t = lockAutoTitle(t, 's1', '问题一')
    t = lockAutoTitle(t, 's2', '问题二')
    expect(t).toEqual({ s1: '问题一', s2: '问题二' })
  })

  it('删会话时清掉（不清会越攒越多）', () => {
    const t: AutoTitles = { s1: 'a', s2: 'b' }
    expect(forgetAutoTitle(t, 's1')).toEqual({ s2: 'b' })
    // 不存在时原样返回，跳过写盘
    expect(forgetAutoTitle(t, 'nope')).toBe(t)
  })

  it('畸形值不让侧边栏炸掉', () => {
    expect(normalizeAutoTitles(null)).toEqual({})
    expect(normalizeAutoTitles({ s1: 123, s2: '好的' })).toEqual({ s2: '好的' })
  })
})

describe('三级优先（ipc-handlers 的 listSessions 那段逻辑）', () => {
  // 用户手改的 > 第一次锁定的 > 现推的兜底
  const pick = (
    manual: Record<string, string>,
    auto: AutoTitles,
    derived: string,
    id = 's1',
  ): string => manual[id] ?? auto[id] ?? derived

  it('手改的最高', () => {
    expect(pick({ s1: '我起的名' }, { s1: '锁定的' }, '推出来的')).toBe('我起的名')
  })

  it('没手改时用锁定的 —— 这样文件变了名字也不变', () => {
    expect(pick({}, { s1: '锁定的' }, '推出来的')).toBe('锁定的')
  })

  it('都没有时才现推（旧会话第一次被列出来）', () => {
    expect(pick({}, {}, '推出来的')).toBe('推出来的')
  })
})
