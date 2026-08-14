import { describe, it, expect } from 'vitest'
import { menuFor } from '../../electron/main/context-menu'

// 菜单内容是纯数据，所以能直接测 —— 这也是把它从 ipc-handlers.ts 里拆出来的原因：
// Menu.popup() 那一下要 electron，vitest 在纯 Node 里加载不了。
describe('menuFor', () => {
  it('会话菜单只有删除一项，且标为破坏性', () => {
    const items = menuFor({ kind: 'session', id: 's1', title: '会话一' })
    expect(items).toHaveLength(1)
    expect(items[0].action).toBe('delete-session')
    expect(items[0].destructive).toBe(true)
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
    const s = menuFor({ kind: 'session', id: 's1', title: 'x' })[0].action
    const p = menuFor({ kind: 'project', id: 'p1', name: 'y' })[0].action
    expect(s).not.toBe(p)
  })
})
