// @vitest-environment jsdom
// App.tsx 顶层会跑 `export const api = window.electronAPI`（api.ts），
// 只在 node 环境跑会因为没有 window 直接炸掉，所以这个纯函数测试也得挂 jsdom。
import { describe, it, expect } from 'vitest'
import { mergeSessions } from '../../electron/renderer/src/App'
import type { SessionMeta } from '../../electron/shared/channels'

// 回归测试：手测时发现的真实 bug——onMessageComplete 和 remove() 曾经直接拿磁盘
// 列表整体覆盖 sessions 状态，导致刚创建、还没来得及落盘的空会话（"新会话"）在
// 别的会话答完消息的瞬间被静默冲掉。mergeSessions 是修复后提取出的纯函数：
// 磁盘列表是"已落盘"部分的真相，本地列表里磁盘没有的 id 就是"还没落盘"，取并集。
describe('mergeSessions', () => {
  const disk = (id: string, updatedAt: number): SessionMeta => ({ id, title: id, updatedAt })

  it('磁盘和本地完全一致时原样返回（按 updatedAt 降序）', () => {
    const list = [disk('a', 1), disk('b', 2)]
    expect(mergeSessions(list, list)).toEqual([disk('b', 2), disk('a', 1)])
  })

  it('本地有一个磁盘还没有的会话（刚创建、未落盘）时保留它，不被磁盘刷新冲掉', () => {
    const diskList = [disk('a', 1)]
    const prev = [{ id: 'new', title: '新会话', updatedAt: 999 }, disk('a', 1)]
    const merged = mergeSessions(diskList, prev)
    expect(merged.map((s) => s.id)).toEqual(['new', 'a'])
  })

  it('本地那份一旦在磁盘上出现，就用磁盘版本（已落盘，标题/时间可能更新了）', () => {
    const diskList = [{ id: 'a', title: '已保存的标题', updatedAt: 5 }]
    const prev = [{ id: 'a', title: '新会话', updatedAt: 1 }]
    const merged = mergeSessions(diskList, prev)
    expect(merged).toEqual([{ id: 'a', title: '已保存的标题', updatedAt: 5 }])
  })

  it('磁盘列表为空、本地全是未落盘会话时全部保留', () => {
    const prev = [{ id: 'x', title: '新会话', updatedAt: 1 }]
    expect(mergeSessions([], prev)).toEqual(prev)
  })

  // deletedIds（tombstone）解决的是「未落盘」和「已删除」在形状上无法区分的问题：
  // 两者都表现为「本地有、磁盘没有」。没有 tombstone 时，上面第二条规则
  // （本地独有 = 未落盘，保留）会把刚删掉的会话又捞回来。
  describe('deletedIds tombstone', () => {
    it('被 tombstone 的会话即使还在磁盘列表里也要滤掉（unlink 还没落地的空档）', () => {
      // remove() 里 deleteSession 的 IPC 往返未完成时，并发的 listSessions
      // 仍会返回这个 id —— 这正是它会「复活」的时刻。
      const diskList = [disk('a', 1), disk('doomed', 2)]
      const merged = mergeSessions(diskList, diskList, new Set(['doomed']))
      expect(merged.map((s) => s.id)).toEqual(['a'])
    })

    it('被 tombstone 的会话也不能靠「本地独有」这条规则复活', () => {
      const prev = [disk('doomed', 9)]
      expect(mergeSessions([], prev, new Set(['doomed']))).toEqual([])
    })

    it('并发调用：另一个会话答完消息时用陈旧的 prev 合并，也不会把正在删的那个捞回来', () => {
      // 真实时序：remove('doomed') 同步打上 tombstone → await deleteSession 期间，
      // 别的会话 onMessageComplete 触发 listSessions + mergeSessions，
      // 它拿到的 prev 和 diskList 都还含 doomed。tombstone 是共享的 ref，所以这里也生效。
      const staleDisk = [disk('a', 1), disk('doomed', 2)]
      const stalePrev = [disk('a', 1), disk('doomed', 2), { id: 'new', title: '新会话', updatedAt: 9 }]
      const tombstones = new Set(['doomed'])
      const merged = mergeSessions(staleDisk, stalePrev, tombstones)
      // doomed 被滤掉，而未落盘的 new 仍然保住 —— 两条规则不能互相伤害
      expect(merged.map((s) => s.id)).toEqual(['new', 'a'])
    })

    it('tombstone 撤销后（删除被拒），该会话恢复正常参与合并', () => {
      // DELETE_BLOCKED 的路径：主进程拒绝删除，remove() 的 catch 撤掉 tombstone。
      const diskList = [disk('busy', 3)]
      expect(mergeSessions(diskList, diskList, new Set()).map((s) => s.id)).toEqual(['busy'])
    })
  })
})
