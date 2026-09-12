// ============================================================================
// PermissionPicker.tsx —— composer 上的「这条对话能动多少东西」
// ----------------------------------------------------------------------------
// 只读 / 询问 / 自动，仿 Codex 的那个选择器。
//
// ## 为什么在 composer 而不在设置页
//
// 「这条对话能不能动我的磁盘」是个**随任务变**的判断：查点东西用只读，
// 让它改代码用询问，跑一串脚手架命令时切自动。绑在会话上、放在提问的地方，
// 切会话就切回各自的模式，不用每次进设置改一个全局开关。
//
// ## 为什么只对内置 agent 显示
//
// 外部 CLI 自带权限模型（Claude Code 有它自己的「本次允许 / 本会话都允许」），
// 旁边再放一个只会让人以为这个能管住它 —— 而它管不住：我们只是把 CLI 发来的
// 权限请求转成审批卡，改不了它内部的规则。
// ============================================================================

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import {
  PERMISSION_MODES,
  permissionHint,
  permissionIcon,
  permissionLabel,
  type PermissionMode,
} from '../../../main/providers'

export function PermissionPicker({
  current,
  onPick,
}: {
  current: PermissionMode
  onPick: (mode: PermissionMode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    try {
      if (open) {
        if (!el.matches(':popover-open')) el.showPopover()
      } else if (el.matches(':popover-open')) {
        el.hidePopover()
      }
    } catch {
      // jsdom 没实现 popover
    }
  }, [open])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'closed') setOpen(false)
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [])

  const [pos, setPos] = useState<{ left: string; bottom: string } | null>(null)
  useLayoutEffect(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: `${r.left}px`, bottom: `${window.innerHeight - r.top + 6}px` })
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="权限"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-chip border-none bg-transparent px-1.5 text-[11.5px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <Icon name={permissionIcon(current)} size={11} strokeWidth={1.8} className="flex-none" />
        <span className="truncate">{permissionLabel(current)}</span>
      </button>

      <div
        ref={ref}
        popover="auto"
        role="listbox"
        aria-label="权限"
        id={id}
        style={{ margin: 0, top: 'auto', right: 'auto', ...pos }}
        // 不写 border：shadow-overlay 的第一层已经是 0 0 0 1px var(--color-line-strong)，
        // 再加一条 border 就是双层描边。跟右键菜单（ContextMenu）统一，
        // 边界一律走 ring —— 见 styles.css 文件头第 2 条。
        // gap-0.5：这三项每项两行（标题 + 一句说明），紧挨着时两项的说明和
        // 标题会黏成一片，扫不出边界。模型那个浮层每项只有一行，不需要。
        className="fixed max-h-[320px] min-w-[240px] flex-col gap-0.5 overflow-y-auto rounded-card bg-overlay p-1 text-[12px] shadow-overlay open:flex"
      >
        {PERMISSION_MODES.map((mode) => {
          const isCurrent = mode === current
          return (
            <button
              key={mode}
              type="button"
              role="option"
              aria-selected={isCurrent}
              onClick={() => {
                setOpen(false)
                onPick(mode)
              }}
              // 这三项比模型行高：每项带一句说明。
              // 「只读」「自动」这种词自己说不清后果 —— 用户要知道选了它
              // 磁盘会发生什么，而这正是不该让他去查文档的地方
              className={`flex flex-none cursor-pointer flex-col gap-0.5 rounded-chip border-none px-2 py-1.5 text-left transition-colors duration-100 ${
                isCurrent
                  ? 'bg-accent-tint text-ink'
                  : 'bg-transparent text-ink-2 hover:bg-overlay-hover hover:text-ink'
              }`}
            >
              <span className="flex items-center gap-1.5 text-[12px]">
                <Icon name={permissionIcon(mode)} size={11} strokeWidth={1.8} className="flex-none" />
                <span className="flex-1">{permissionLabel(mode)}</span>
                {isCurrent && (
                  <Icon name="check" size={11} strokeWidth={2.2} className="flex-none text-accent-ink" />
                )}
              </span>
              <span className="text-[11px] leading-snug text-ink-3">{permissionHint(mode)}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
