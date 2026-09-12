import { describe, it, expect } from 'vitest'
import { hydrateMessages } from '../../electron/renderer/src/hydrate'
import { truncateAtNthUser } from '../../electron/main/truncate'
import type { Message } from '../../src/types'

// 界面 nthUser（数气泡里的 user）必须和磁盘的 user 计数对齐，
// 否则编辑重发会砍错位置 —— 用户报的「后面的提问被覆盖删除」
describe('编辑重发的下标对齐', () => {
  it('三轮都被取消时，界面气泡数和磁盘 user 数一致', () => {
    // 修复后磁盘上的形状：每轮 user + 半截 assistant
    const disk: Message[] = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '半截一\n\n_（已停止）_' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '半截二\n\n_（已停止）_' },
      { role: 'user', content: '第三问' },
      { role: 'assistant', content: '半截三\n\n_（已停止）_' },
    ]
    const bubbles = hydrateMessages(disk, 's1')
    const bubbleUsers = bubbles.filter((b) => b.role === 'user')
    const diskUsers = disk.filter((m) => m.role === 'user')
    expect(bubbleUsers.length).toBe(diskUsers.length)

    // 界面上编辑第 2 个 user 气泡 → App 算出 nthUser
    const idx = bubbles.findIndex((b) => b.content === '第二问')
    const nthUser = bubbles.slice(0, idx).filter((b) => b.role === 'user').length
    expect(nthUser).toBe(1)

    // 磁盘按这个 nthUser 砍：应该正好剩第一轮
    const kept = truncateAtNthUser(disk, nthUser)
    expect(kept.map((m) => m.content)).toEqual(['第一问', '半截一\n\n_（已停止）_'])
  })

  // 反面：如果中断轮次没落盘（旧行为），下标就错位
  it('（旧行为）磁盘缺中断轮次时下标错位 —— 这是那个 bug', () => {
    // 旧行为：只有最后一轮被存下来
    const staleDisk: Message[] = [{ role: 'user', content: '第三问' }]
    // 界面上有 3 个 user 气泡，编辑第 2 个算出 nthUser=1
    const kept = truncateAtNthUser(staleDisk, 1)
    // 磁盘里找不到第 2 条 user → 原样返回（什么都没砍）
    // 于是 send() 追加新提问，历史变成「第三问 + 新提问」，第一二问永久消失
    expect(kept).toEqual(staleDisk)
  })

  it('工具轨迹跨轮不串（flush 在 user 之前）', () => {
    const disk: Message[] = [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'search', args: {} }] },
      { role: 'tool', content: 'r1', toolCallId: 't1', name: 'search' },
      // 这一轮被取消，没有正文 assistant
      { role: 'user', content: 'B' },
      { role: 'assistant', content: '答B' },
    ]
    const bubbles = hydrateMessages(disk, 's1')
    const users = bubbles.filter((b) => b.role === 'user').map((b) => b.content)
    expect(users).toEqual(['A', 'B'])
    // A 那轮的工具落在了 A 之后、B 之前
    const idxA = bubbles.findIndex((b) => b.content === 'A')
    const idxB = bubbles.findIndex((b) => b.content === 'B')
    const between = bubbles.slice(idxA + 1, idxB)
    expect(between.some((b) => b.tools.length > 0)).toBe(true)
  })
})
