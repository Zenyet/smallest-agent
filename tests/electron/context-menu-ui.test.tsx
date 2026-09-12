// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextMenu, CLOSED } from '../../electron/renderer/src/components/ContextMenu'

// jsdom 还没实现 popover（showPopover / hidePopover / :popover-open）。
// 组件靠它做「点外面关 / Esc 关 / top layer」，那三件事是平台行为、不该在这里
// 断言；但没有这几个桩组件会直接抛错，所以补一个最小实现，只维持开关状态。
//
// 真正的 light dismiss 和贴边翻转只能在真窗口里验 —— 这也是为什么下面测的是
// 「菜单项、顺序、破坏性样式、零间距」这些确定的东西，不是浮层行为本身。
//
// 下面每个 byRole 都带 `hidden: true`：桩只维持开关状态，没法让 jsdom 认为
// [popover] 已经显示，于是节点在无障碍树里算隐藏、role 查不到。真浏览器里
// showPopover() 之后就是可见的，所以这个 flag 是环境的补偿，不是组件的毛病。
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const open = new WeakSet<HTMLElement>()
  proto.showPopover = function (this: HTMLElement) {
    open.add(this)
  }
  proto.hidePopover = function (this: HTMLElement) {
    open.delete(this)
  }
  const realMatches = HTMLElement.prototype.matches
  proto.matches = function (this: HTMLElement, sel: string) {
    if (sel === ':popover-open') return open.has(this)
    return realMatches.call(this, sel)
  }
})

const at = { x: 10, y: 20 }

describe('ContextMenu', () => {
  it('没开时不渲染任何菜单项', () => {
    render(<ContextMenu state={CLOSED} onClose={() => {}} />)
    expect(screen.queryAllByRole('menuitem', { hidden: true })).toHaveLength(0)
  })

  it('按给定顺序渲染菜单项', () => {
    render(
      <ContextMenu
        state={{
          at,
          items: [
            { label: '重命名', onSelect: () => {} },
            { label: '删除会话', onSelect: () => {}, destructive: true },
          ],
        }}
        onClose={() => {}}
      />,
    )
    expect(screen.getAllByRole('menuitem', { hidden: true }).map((el) => el.textContent)).toEqual([
      '重命名',
      '删除会话',
    ])
  })

  it('点某一项时先关菜单再执行动作', () => {
    // 顺序有意义：动作可能把这一行整个删掉（「删除会话」就是），
    // 之后再去操作已经卸载的节点会报错
    const order: string[] = []
    render(
      <ContextMenu
        state={{ at, items: [{ label: '删除会话', onSelect: () => order.push('action') }] }}
        onClose={() => order.push('close')}
      />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话', hidden: true }))
    expect(order).toEqual(['close', 'action'])
  })

  it('破坏性项画成红色，普通项不画', () => {
    render(
      <ContextMenu
        state={{
          at,
          items: [
            { label: '重命名', onSelect: () => {} },
            { label: '删除会话', onSelect: () => {}, destructive: true },
          ],
        }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('menuitem', { name: '重命名', hidden: true }).className).not.toMatch(/text-red/)
    expect(screen.getByRole('menuitem', { name: '删除会话', hidden: true }).className).toMatch(/text-red/)
  })

  // 这一条是这个组件存在的理由：gpui 侧自绘菜单就是为了去掉库里那个
  // gap（rs/ui/src/context_menu.rs 的文件头）。容器上有 gap 就说明抄错了。
  it('容器没有 gap —— 项与项之间不留缝', () => {
    const { container } = render(
      <ContextMenu state={{ at, items: [{ label: 'a', onSelect: () => {} }] }} onClose={() => {}} />,
    )
    const panel = container.querySelector('[role="menu"]')!
    expect(panel.className).not.toMatch(/\bgap-/)
  })

  // 容器规格照 context_menu.rs：overlay 底 + line_strong 1px 边 + card 圆角
  //
  // 那条 1px 边由 shadow-overlay 的第一层给（0 0 0 1px var(--color-line-strong)），
  // 不再额外写 border —— 两者并存就是双层描边，看起来像 outline 套着 border。
  // 边界统一走 ring 是这套设计系统的约定，见 styles.css 文件头第 2 条。
  it('容器用浮层配色和 card 圆角，且只有一层描边', () => {
    const { container } = render(
      <ContextMenu state={{ at, items: [{ label: 'a', onSelect: () => {} }] }} onClose={() => {}} />,
    )
    const panel = container.querySelector('[role="menu"]')!
    expect(panel.className).toMatch(/bg-overlay\b/)
    expect(panel.className).toMatch(/rounded-card/)
    // 描边来自 ring
    expect(panel.className).toMatch(/shadow-overlay\b/)
    // 不许再有第二层：border-* 会和上面那条 ring 叠成双线
    expect(panel.className).not.toMatch(/\bborder(-|\b)/)
  })

  it('菜单钉在光标位置', () => {
    const { container } = render(
      <ContextMenu
        state={{ at: { x: 133, y: 47 }, items: [{ label: 'a', onSelect: () => {} }] }}
        onClose={() => {}}
      />,
    )
    const panel = container.querySelector('[role="menu"]') as HTMLElement
    expect(panel.style.left).toBe('133px')
    expect(panel.style.top).toBe('47px')
    // UA 样式给 [popover] 加了 auto margin，不清掉会把它推离指定坐标
    expect(panel.style.margin).toBe('0px')
  })

  it('方向键在项之间循环', () => {
    render(
      <ContextMenu
        state={{
          at,
          items: [
            { label: '重命名', onSelect: () => {} },
            { label: '删除会话', onSelect: () => {}, destructive: true },
          ],
        }}
        onClose={() => {}}
      />,
    )
    const panel = screen.getByRole('menu', { hidden: true })
    const [first, second] = screen.getAllByRole('menuitem', { hidden: true })

    // 没有选中项时 ↓ 落到第一项（和系统菜单一致）
    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    // 末项再往下回到第一项
    fireEvent.keyDown(panel, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(first)
  })

  it('没有选中项时 ↑ 落到最后一项', () => {
    render(
      <ContextMenu
        state={{
          at,
          items: [
            { label: '重命名', onSelect: () => {} },
            { label: '删除会话', onSelect: () => {}, destructive: true },
          ],
        }}
        onClose={() => {}}
      />,
    )
    fireEvent.keyDown(screen.getByRole('menu', { hidden: true }), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem', { hidden: true })[1])
  })

  // ## 下面五条锁的是「菜单一弹出来就自己关掉」那个 bug
  //
  // 根因：popover="auto" 的 light dismiss 是 pointerdown / pointerup 配对判定
  // 的 —— pointerdown 记下「按在哪个浮层里」，pointerup 时关掉不在其中的。
  // 而右键的事件顺序是 pointerdown → contextmenu → pointerup：
  //
  //   1. pointerdown —— 菜单还没开，记为「按在所有浮层之外」
  //   2. contextmenu —— 组件在这里 showPopover()
  //   3. pointerup   —— 判定「刚才按在外面」→ 立刻关掉
  //
  // 用户看到菜单闪一下就没了。修法是改成 manual，自己接点外面和 Esc。
  //
  // light dismiss 本身是平台行为，jsdom 里验不了（桩只维持开关状态）。所以这里
  // 测的是「修法还在不在」：属性是 manual、两个替代手势都接上了。

  it('用 popover="manual" —— auto 的 light dismiss 会让右键菜单一开就关', () => {
    const { container } = render(
      <ContextMenu state={{ at, items: [{ label: 'a', onSelect: () => {} }] }} onClose={() => {}} />,
    )
    expect(container.querySelector('[role="menu"]')!.getAttribute('popover')).toBe('manual')
  })

  it('点菜单外面关闭（manual 不自带，得自己接）', () => {
    let closed = 0
    render(
      <ContextMenu
        state={{ at, items: [{ label: 'a', onSelect: () => {} }] }}
        onClose={() => closed++}
      />,
    )
    fireEvent.pointerDown(document.body)
    expect(closed).toBe(1)
  })

  it('点菜单里面不关闭 —— 那是在选一项，关闭由 onSelect 负责', () => {
    let closed = 0
    render(
      <ContextMenu
        state={{ at, items: [{ label: 'a', onSelect: () => {} }] }}
        onClose={() => closed++}
      />,
    )
    fireEvent.pointerDown(screen.getByRole('menu', { hidden: true }))
    expect(closed).toBe(0)
  })

  it('Esc 关闭（manual 没有内置的 Esc 关闭）', () => {
    let closed = 0
    render(
      <ContextMenu
        state={{ at, items: [{ label: 'a', onSelect: () => {} }] }}
        onClose={() => closed++}
      />,
    )
    fireEvent.keyDown(screen.getByRole('menu', { hidden: true }), { key: 'Escape' })
    expect(closed).toBe(1)
  })

  // 菜单没开时不该还挂着全局监听 —— 那会把别处的点击吃成一次 onClose
  it('没开时点外面不触发 onClose', () => {
    let closed = 0
    render(<ContextMenu state={CLOSED} onClose={() => closed++} />)
    fireEvent.pointerDown(document.body)
    expect(closed).toBe(0)
  })

  // UA 样式是 `[popover] { inset: 0; margin: auto; width: fit-content }`。
  // 左右都定住、宽度又是 fit-content 就是过约束，CSS 会丢掉一边 —— 这里丢的
  // 恰好是 right/bottom，所以只写 left/top 也能对，但那是碰巧。
  // 显式让开，免得哪天改成从右边或下边定位时悄悄失效（ModelPicker 就是这么
  // 中招的：它设 bottom，而 bottom 正是被丢掉的那个）。
  it('让开 UA 默认的 inset：margin 归零，right/bottom 显式 auto', () => {
    render(
      <ContextMenu state={{ at, items: [{ label: 'a', onSelect: () => {} }] }} onClose={() => {}} />,
    )
    const el = screen.getByRole('menu', { hidden: true }) as HTMLElement
    expect(el.style.left).toBe('10px')
    expect(el.style.top).toBe('20px')
    expect(el.style.margin).toBe('0px')
    expect(el.style.right).toBe('auto')
    expect(el.style.bottom).toBe('auto')
  })

  // 换掉原生菜单丢了 VoiceOver 对系统菜单的原生支持，role 语义是补偿。
  // 掉了就等于既没有原生支持、也没有 ARIA。
  it('带 menu / menuitem 语义', () => {
    render(
      <ContextMenu state={{ at, items: [{ label: 'a', onSelect: () => {} }] }} onClose={() => {}} />,
    )
    expect(screen.getByRole('menu', { hidden: true })).toBeTruthy()
    expect(screen.getAllByRole('menuitem', { hidden: true })).toHaveLength(1)
  })
})
