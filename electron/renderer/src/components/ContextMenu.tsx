// ============================================================================
// ContextMenu.tsx —— 自绘右键菜单
// ----------------------------------------------------------------------------
// 为什么不用原生菜单（main/context-menu.ts + Menu.popup）：那份菜单的间距、
// 行高、圆角、底色全由 AppKit 画，CSS 碰不到，所以它跟这套设计 token
// 对不上。要和 gpui 版一致就只能自己画。
//
// 规格照 rs/ui/src/context_menu.rs 抄（那边是基准）：
//   容器  overlay 底 + line_strong 1px 边 + card(10px) 圆角 + 4px padding
//   项    26px 行高、chip(6px) 圆角、hover 用 overlay_hover、12px 字
//   分隔线 1px line，左右出血（负 margin 吃掉容器的 4px padding）
//   **项与项之间零 gap** —— 这是那个文件存在的理由，别加回来
//
// ## 为什么这里比 gpui 那份短得多
//
// gpui 那份要手接光标定位、点外面关闭、Esc、焦点归还（见 context_menu.rs
// 的文件头），因为 gpui 没有可用的浮层原语。Web 这边这些是平台能力：
//
//   • `popover` 属性 —— 点外面自动关（light dismiss）、Esc 自动关、
//     自动进 top layer（不会被父容器的 overflow 裁掉，也不用 z-index 打架）
//   • CSS anchor positioning —— 贴边自动翻转，不用自己算窗口边界
//
// Electron 43（Chromium 远高于 popover 的 114 和 anchor 的 125）都支持。
// 所以这里只剩「菜单里有哪几项」这一件事要写。
//
// ## 无障碍上的取舍
//
// 换掉原生菜单会丢 VoiceOver 对系统菜单的原生支持。这里用 role="menu" /
// role="menuitem" 补语义，并自己接方向键遍历 —— 不接的话键盘用户只能 Tab，
// 而 Tab 在菜单里不是预期手势。
// ============================================================================

import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  /** 破坏性操作画成红色（对应原生菜单的 destructive） */
  destructive?: boolean
}

export interface ContextMenuState {
  /** 窗口坐标。null = 没开 */
  at: { x: number; y: number } | null
  items: ContextMenuItem[]
}

export const CLOSED: ContextMenuState = { at: null, items: [] }

export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // popover 是命令式 API（showPopover/hidePopover），要跟 React 的声明式
  // 状态对上就得在 effect 里同步。直接在 JSX 上写 open 属性不行 ——
  // popover 没有那个属性。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (state.at) {
      // 已经开着时再 show 会抛 InvalidStateError（同一个会话里连着右键
      // 两行就会遇到），所以先查状态
      if (!el.matches(':popover-open')) el.showPopover()
      // 开的时候把焦点收进来：Esc 的 light dismiss 不需要焦点，
      // 但方向键遍历需要
      el.focus()
    } else if (el.matches(':popover-open')) {
      el.hidePopover()
    }
  }, [state.at])

  // 平台的 light dismiss（点外面 / Esc）会自己关掉 popover，但它只改 DOM，
  // 不会通知 React —— 不听这个事件的话 state.at 还留着旧坐标，下次右键
  // 同一行时 effect 看不出变化，菜单就不再弹出。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'closed') onClose()
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [onClose])

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Esc 不用管，popover 的 light dismiss 已经接了
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const el = ref.current
    if (!el) return
    const rows = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    if (rows.length === 0) return
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    // 没有选中项时：↓ 落到第一项，↑ 落到最后一项（和系统菜单一致）
    const next =
      e.key === 'ArrowDown'
        ? at < 0
          ? 0
          : (at + 1) % rows.length
        : at < 0
          ? rows.length - 1
          : (at - 1 + rows.length) % rows.length
    rows[next].focus()
  }

  return (
    <div
      ref={ref}
      popover="auto"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // 定位：popover 默认居中在视口，要用 left/top 挪到光标处。
      // margin:0 是必须的 —— UA 样式给 [popover] 加了 auto margin，
      // 不清掉的话它会被推离指定坐标。
      style={{
        margin: 0,
        left: state.at ? `${state.at.x}px` : undefined,
        top: state.at ? `${state.at.y}px` : undefined,
      }}
      // 容器规格照 context_menu.rs：min-w 150、p-1(4px)、rounded-card(10px)、
      // bg-overlay、1px line-strong 边。
      //
      // **没有 gap** —— 项与项之间不留缝，这是和 gpui 版对齐的关键一条。
      className="fixed min-w-[150px] flex-col rounded-card border border-line-strong bg-overlay p-1 text-[12px] shadow-overlay open:flex"
    >
      {state.items.map((item, i) => (
        <div key={i} className="contents">
          {/* 分隔线夹在项之间。负 margin 让它铺满整个浮层宽度（吃掉容器那 4px
              padding）—— 缩在里面的短线看着像断掉的下划线。
              上下不留 margin：项之间不要缝。 */}
          {i > 0 && item.destructive && !state.items[i - 1].destructive && (
            <div className="-mx-1 h-px flex-none bg-line" />
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // 先关再执行：动作可能把这一行整个删掉（「删除会话」就是），
              // 那之后再去 hidePopover 一个已经卸载的节点会报错
              onClose()
              item.onSelect()
            }}
            className={`flex h-[26px] flex-none cursor-pointer items-center rounded-chip border-none bg-transparent px-2 text-left text-[12px] outline-none transition-colors duration-100 ${
              item.destructive ? 'text-red' : 'text-ink-2'
            } hover:bg-overlay-hover hover:text-ink focus-visible:bg-overlay-hover focus-visible:text-ink`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}
