import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icon'
import { ALL, CUSTOM_ID, CUSTOM_NAME } from '../settings-fields'

/**
 * 设置页凭据区的厂商选择器，替代原生 <select>。
 *
 * 和对话框里那四个选择器（ModelPicker / PermissionPicker 等）同一套外观 ——
 * 应用里所有选择器都用自定义浮层，而不是一部分 popover 一部分原生。
 */
export function VendorPicker({
  current,
  isConfigured,
  onPick,
}: {
  current: string
  /** (vendorId) => 这家是否已填了凭据（选项后面打勾用） */
  isConfigured: (id: string) => boolean
  onPick: (id: string) => void
}) {
  const id = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  // popover 是命令式 API，要和 React 的声明式状态对上就得在 effect 里同步
  useEffect(() => {
    const el = panelRef.current
    if (!el || !('showPopover' in el)) return
    try {
      if (open) {
        if (!el.matches(':popover-open')) el.showPopover()
      } else if (el.matches(':popover-open')) {
        el.hidePopover()
      }
    } catch {
      // jsdom 没实现 popover；测试里只断言内容，不断言浮层行为
    }
  }, [open])

  // 浮层外面点 / Esc → 关
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const onToggle = () => {
      if (!el.matches(':popover-open')) setOpen(false)
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [])

  const currentVendor = ALL.find((v) => v.id === current) || { id: CUSTOM_ID, name: CUSTOM_NAME }
  const options = [...ALL, { id: CUSTOM_ID, name: CUSTOM_NAME }]

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // 和原来 select 同宽同高
        className="flex h-7 w-[300px] flex-none cursor-pointer items-center justify-between gap-1.5 rounded-control border-none bg-field px-2 text-[13px] text-ink transition-colors duration-150 hover:bg-hover"
      >
        <span>{currentVendor.name}</span>
        <Icon name="chevron" size={12} className="text-ink-3" rotated={!open} />
      </button>

      <div
        ref={panelRef}
        popover="auto"
        role="listbox"
        aria-label="厂商"
        id={id}
        style={{
          margin: 0,

          right: 'auto',
          left: btnRef.current ? btnRef.current.getBoundingClientRect().left : 0,
          // 按钮下方 4px（和对话框里那几个选择器的间距一致）
          top: btnRef.current ? btnRef.current.getBoundingClientRect().bottom + 4 : 0,
        }}
        // 不写 border：shadow-overlay 的第一层已经是 0 0 0 1px var(--color-line-strong)，
        // 再加一条 border 就是双层描边。和对话框里那几个选择器统一。
        className="fixed max-h-[320px] min-w-[240px] flex-col overflow-y-auto rounded-card bg-overlay p-1 text-[12px] shadow-overlay open:flex"
      >
        {options.map((v) => {
          const isCurrent = v.id === current
          const configured = isConfigured(v.id)
          return (
            <button
              key={v.id}
              type="button"
              role="option"
              aria-selected={isCurrent}
              onClick={() => {
                setOpen(false)
                onPick(v.id)
              }}
              className={`flex h-[26px] flex-none cursor-pointer items-center justify-between gap-2 rounded-chip border-none pr-2 pl-3.5 text-left text-[12px] transition-colors duration-100 ${
                isCurrent
                  ? 'bg-accent-tint text-ink'
                  : 'bg-transparent text-ink-2 hover:bg-overlay-hover hover:text-ink'
              }`}
            >
              <span>{v.name}</span>
              {/* 已配的打勾（和原来 <option> 后缀 ✓ 同一个意思） */}
              {configured && <span className="text-[11px]">✓</span>}
            </button>
          )
        })}
      </div>
    </>
  )
}
