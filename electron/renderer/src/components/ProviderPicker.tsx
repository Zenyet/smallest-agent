// ============================================================================
// ProviderPicker.tsx —— composer 上的「这轮由谁来跑」
// ----------------------------------------------------------------------------
// 内置 agent（本仓库的 ReAct 循环）还是外部 CLI（Claude Code / Codex / …）。
//
// 和 ModelPicker 分开而不是合成一个选择器：它们答的是**不同的问题**。
// 引擎决定「谁来跑这一轮」，模型决定「它用哪个脑子」—— 换引擎会连带换掉
// 可选的模型清单（那是 CLI 自己声明的），合成一个的话列表要嵌套两层。
//
// 浮层规格和 ModelPicker / ContextMenu 同一套（overlay 底 + line_strong 边 +
// card 圆角），这样应用里所有浮层是一个语言。定位那几个 style 也是同一份 ——
// 见 ModelPicker.tsx 里关于 UA `[popover] { inset: 0 }` 那段。
// ============================================================================

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ProvidersView } from '../../../shared/channels'

export function ProviderPicker({
  view,
  onPick,
}: {
  view: ProvidersView
  onPick: (providerId: string) => void
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
      // jsdom 没实现 popover；测试里只断言列表内容，不断言浮层行为
    }
  }, [open])

  // 平台的 light dismiss 只改 DOM、不通知 React —— 不听这个事件的话 open
  // 还是 true，下次点触发按钮会以为「已经开着」而关不掉
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'closed') setOpen(false)
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [])

  // 定位：往上开（composer 在窗口底部）。在 layout effect 里量，不在 render
  // 里直接读 ref —— 首帧 triggerRef.current 还是 null。见 ModelPicker 同一处。
  const [pos, setPos] = useState<{ left: string; bottom: string } | null>(null)
  useLayoutEffect(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: `${r.left}px`, bottom: `${window.innerHeight - r.top + 6}px` })
  }, [open])

  const current = view.options.find((o) => o.id === view.current)
  const currentName = current?.name ?? '内置 agent'
  const currentExternal = current?.external ?? false

  // 只有一个可选时不做成菜单：点开只有一项的下拉是空动作，
  // 显示成纯文本反而诚实（「现在用的是这个，没别的可选」）。
  // 模板里五家都是 disabled，所以这是**默认状态** —— 用户没配过外部 CLI 时
  // composer 上就是一行静态文字，不会多一个点了没反应的控件。
  if (view.options.length <= 1) {
    return (
      <div className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[11.5px] text-ink-3">
        <Icon name="bot" size={11} strokeWidth={1.8} className="flex-none" />
        <span className="truncate">{currentName}</span>
      </div>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="引擎"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 max-w-[150px] shrink-0 cursor-pointer items-center gap-1 rounded-chip border-none bg-transparent px-1.5 text-[11.5px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        <Icon
          name={currentExternal ? 'terminal' : 'bot'}
          size={11}
          strokeWidth={1.8}
          className="flex-none"
        />
        <span className="truncate">{currentName}</span>
        <Icon name="chevron" size={10} strokeWidth={1.8} className="flex-none" />
      </button>

      <div
        ref={ref}
        popover="auto"
        role="listbox"
        aria-label="引擎"
        id={id}
        style={{ margin: 0, top: 'auto', right: 'auto', ...pos }}
        className="fixed max-h-[320px] min-w-[200px] flex-col overflow-y-auto rounded-card border border-line-strong bg-overlay p-1 text-[12px] shadow-overlay open:flex"
      >
        {view.options.map((o) => {
          const isCurrent = o.id === view.current
          return (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={isCurrent}
              onClick={() => {
                setOpen(false)
                onPick(o.id)
              }}
              className={`flex h-[26px] flex-none cursor-pointer items-center gap-2 rounded-chip border-none px-2 text-left text-[12px] transition-colors duration-100 ${
                isCurrent
                  ? 'bg-accent-tint text-ink'
                  : 'bg-transparent text-ink-2 hover:bg-overlay-hover hover:text-ink'
              }`}
            >
              {/* 图标区分两类引擎：机器人=内置，终端=外部 CLI。
                  「它是不是在我机器上另起了一个进程」是用户该一眼看出的事 */}
              <Icon
                name={o.external ? 'terminal' : 'bot'}
                size={11}
                strokeWidth={1.8}
                className="flex-none"
              />
              <span className="flex-1 truncate">{o.name}</span>
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
