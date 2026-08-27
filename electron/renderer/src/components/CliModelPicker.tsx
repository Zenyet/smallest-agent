// ============================================================================
// CliModelPicker.tsx —— 外部 CLI 的模型选择器
// ----------------------------------------------------------------------------
// 和 ModelPicker（内置 agent 那个）分开，因为「模型」这个词对两种引擎指的
// 不是一回事：
//
//   • 内置 agent：厂商 + 模型（我们自己发 HTTP，要 base_url 和 key），
//     所以那边按厂商分组、三十多项
//   • 外部 CLI：那个 CLI 自己声明的模型 id（通过 env / args 传给子进程），
//     一家就是一个清单、通常三五项
//
// 所以这边**不分组**：一家 CLI 的模型列表没有第二层，加个分组头只是噪音。
// 浮层规格仍然是同一套（overlay 底 + line_strong 边 + card 圆角）。
//
// 模型清单为什么要用户在 providers.json 里配（而不是问 CLI）：
// ACP 协议里没有模型选择，见 main/providers.ts 里 CliModel 的注释。
// ============================================================================

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ProvidersView } from '../../../shared/channels'

export function CliModelPicker({
  view,
  onPick,
}: {
  view: ProvidersView
  onPick: (modelId: string) => void
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

  // 认不出当前模型时显示 id 本身，不是空标签（和 ModelPicker 同一条）
  const currentName =
    view.models.find((m) => m.id === view.currentModel)?.name ?? view.currentModel ?? '默认模型'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="模型"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 max-w-[190px] shrink-0 cursor-pointer items-center gap-1 rounded-chip border-none bg-transparent px-1.5 text-[11.5px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <span className="truncate">{currentName}</span>
        <Icon name="chevron" size={10} strokeWidth={1.8} className="flex-none" />
      </button>

      <div
        ref={ref}
        popover="auto"
        role="listbox"
        aria-label="模型"
        id={id}
        style={{ margin: 0, top: 'auto', right: 'auto', ...pos }}
        className="fixed max-h-[320px] min-w-[200px] flex-col overflow-y-auto rounded-card border border-line-strong bg-overlay p-1 text-[12px] shadow-overlay open:flex"
      >
        {view.models.map((m) => {
          const isCurrent = m.id === view.currentModel
          return (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={isCurrent}
              onClick={() => {
                setOpen(false)
                onPick(m.id)
              }}
              className={`flex h-[26px] flex-none cursor-pointer items-center justify-between gap-2 rounded-chip border-none px-2 text-left text-[12px] transition-colors duration-100 ${
                isCurrent
                  ? 'bg-accent-tint text-ink'
                  : 'bg-transparent text-ink-2 hover:bg-overlay-hover hover:text-ink'
              }`}
            >
              <span className="truncate">{m.name}</span>
              {isCurrent && (
                <Icon name="check" size={11} strokeWidth={2.2} className="flex-none text-accent-ink" />
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}
