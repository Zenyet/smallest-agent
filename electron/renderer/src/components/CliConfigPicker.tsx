// ============================================================================
// CliConfigPicker.tsx —— 外部 CLI 的非模型会话配置选项（思考强度、模式等）
// ----------------------------------------------------------------------------
// 和 CliModelPicker 并列：模型清单是「用哪个脑子」，这些是「这个脑子怎么想」。
// ACP 的 session config option 里 category 不是 model 的 select 都会落到这里
// （thought_level / mode / model_config / …），每个渲染成一个独立的触发按钮。
//
// 触发按钮挤在 composer 那行，所以只显示「选项名 · 当前值」，展开才看得到
// 全部可选值。浮层规格和 CliModelPicker / ModelPicker 同一套。
// ============================================================================

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { configOptionCategoryLabel } from '../../../main/providers'
import type { ProvidersView } from '../../../shared/channels'

type ConfigOption = ProvidersView['configOptions'][number]

function ConfigOptionPicker({
  option,
  onPick,
}: {
  option: ConfigOption
  onPick: (optionId: string, value: string) => void
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

  // 显示名用 category 的中文翻译（thought_level → 思考强度），而不是 CLI 给的
  // 英文 name。CLI 的 name 可能更具体（「Reasoning effort」），但无法可靠翻译，
  // 而 category 是标准分类，译名稳定。
  const label = configOptionCategoryLabel(option.category)
  const currentName =
    option.options.find((v) => v.value === option.currentValue)?.name ?? option.currentValue

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 max-w-[140px] shrink-0 cursor-pointer items-center gap-1 rounded-chip border-none bg-transparent px-1.5 text-[11.5px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <span className="truncate">
          {label}
          <span className="text-ink-2"> · {currentName}</span>
        </span>
        <Icon name="chevron" size={10} strokeWidth={1.8} className="flex-none" />
      </button>

      <div
        ref={ref}
        popover="auto"
        role="listbox"
        aria-label={label}
        id={id}
        style={{ margin: 0, top: 'auto', right: 'auto', ...pos }}
        className="fixed max-h-[240px] min-w-[140px] flex-col overflow-y-auto rounded-card bg-overlay p-1 text-[12px] shadow-overlay open:flex"
      >
        <div className="sticky top-0 z-10 -mx-1 flex h-[22px] flex-none items-center bg-overlay px-3 text-[10.5px] font-semibold tracking-[0.09em] text-ink-3">
          {label}
        </div>
        {option.options.map((value) => {
          const isCurrent = value.value === option.currentValue
          return (
            <button
              key={value.value}
              type="button"
              role="option"
              aria-selected={isCurrent}
              onClick={() => {
                setOpen(false)
                if (!isCurrent) onPick(option.id, value.value)
              }}
              className={`flex h-[26px] flex-none cursor-pointer items-center justify-between gap-2 rounded-chip border-none pr-2 pl-3.5 text-left text-[12px] transition-colors duration-100 ${
                isCurrent
                  ? 'bg-accent-tint text-ink'
                  : 'bg-transparent text-ink-2 hover:bg-overlay-hover hover:text-ink'
              }`}
            >
              <span className="truncate">{value.name}</span>
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

export function CliConfigPicker({
  options,
  onPick,
}: {
  options: ProvidersView['configOptions']
  onPick: (optionId: string, value: string) => void
}) {
  if (options.length === 0) return null
  return (
    <>
      {options.map((option) => (
        <ConfigOptionPicker key={option.id} option={option} onPick={onPick} />
      ))}
    </>
  )
}
