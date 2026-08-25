import { describe, it, expect } from 'vitest'
import { menuFor } from '../../electron/main/context-menu'

// 菜单内容是纯数据，所以能直接测 —— 这也是把它从 ipc-handlers.ts 里拆出来的原因。
// （菜单现在由 renderer 自绘，见 components/ContextMenu.tsx，但「有哪几项」这个
// 产品决定仍留在主进程这一侧。）
describe('menuFor', () => {
  it('会话菜单是重命名 + 删除，只有删除标为破坏性', () => {
    const items = menuFor({ kind: 'session', id: 's1', title: '会话一' })
    expect(items.map((i) => i.action)).toEqual(['rename-session', 'delete-session'])
    // 重命名不是破坏性操作，不该画成红色
    expect(items[0].destructive).toBeUndefined()
    expect(items[1].destructive).toBe(true)
  })

  // 顺序是产品决定，值得锁住：重命名更常用，而删除放最后能减少误点
  // （菜单弹出时指针在顶部）。和 gpui 侧 sidebar.rs 的顺序一致。
  it('重命名排在删除前面', () => {
    const items = menuFor({ kind: 'session', id: 's1', title: 'x' })
    expect(items.findIndex((i) => i.action === 'rename-session')).toBeLessThan(
      items.findIndex((i) => i.action === 'delete-session'),
    )
  })

  it('项目菜单的文案必须说清「不删对话」', () => {
    // 「移除项目」单看很容易被理解成连里面的对话一起删掉。实际行为是只解除
    // 分组关系、会话都还在（见 main/projects.ts 的 removeProject）。
    // 文案是用户在按下之前唯一的信息来源，所以这条要锁住。
    const items = menuFor({ kind: 'project', id: 'p1', name: '我的项目' })
    expect(items).toHaveLength(1)
    expect(items[0].action).toBe('remove-project')
    expect(items[0].label).toMatch(/保留|不删/)
  })

  it('两种目标产出的 action 不同，上层才能分辨该调哪个删除逻辑', () => {
    const s = menuFor({ kind: 'session', id: 's1', title: 'x' }).map((i) => i.action)
    const p = menuFor({ kind: 'project', id: 'p1', name: 'y' }).map((i) => i.action)
    // 两套动作没有交集：上层靠 action 分辨该走哪条逻辑，重合了就会误删
    expect(s.filter((a) => p.includes(a))).toEqual([])
  })
})
