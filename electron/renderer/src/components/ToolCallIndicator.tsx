import { useState } from 'react'
import { Icon } from './Icon'
import type { ToolCallEvent } from '../../../shared/channels'

// 工具失败不走顶层错误事件 —— runTool 把异常包成 {"error": "..."} 返回给模型，
// 所以这里靠解析 output 判断成败。导出给 ToolCallGroup 复用，避免两处维护同一份判断逻辑。
export function isFailed(output: string): boolean {
  try {
    return typeof (JSON.parse(output) as { error?: unknown }).error === 'string'
  } catch {
    return false
  }
}

export function ToolCallIndicator({ event }: { event: ToolCallEvent }) {
  const [open, setOpen] = useState(false)
  const failed = isFailed(event.output)

  return (
    // 语义 class（tool / tool--failed）不带样式，只作测试与调试的锚点；
    // 视觉全部由 Tailwind utility 表达。Step 1 的测试断言 .tool--failed，别删。
    <div
      className={`tool ${failed ? 'tool--failed border-l-[3px] border-red' : ''} mb-1 overflow-hidden rounded-chip bg-surface shadow-hairline`}
    >
      <button
        type="button"
        className="tool__head flex h-7 w-full items-center gap-1.5 px-2 text-left text-[11.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={failed ? 'text-red' : 'text-ink-3'}>
          <Icon name={failed ? 'warn' : 'tool'} size={12} />
        </span>
        <span className="tool__name font-mono text-accent-ink">{event.toolName}</span>
        <span className="ml-auto text-[11px] text-ink-3">第 {event.turn} 轮</span>
        <Icon name="chevron" size={11} className="text-ink-3" rotated={!open} />
      </button>
      {/* 默认折叠：长 JSON 全渲染会拖慢长会话 */}
      {open && (
        <div className="px-2 pb-2" style={{ animation: 'fade-up 200ms cubic-bezier(0.23,1,0.32,1) both' }}>
          <pre className="mt-1 overflow-x-auto rounded-chip bg-inset p-2 text-[11px] font-normal text-ink-2 shadow-inset-field">
            {JSON.stringify(event.args, null, 2)}
          </pre>
          <pre className="mt-1 overflow-x-auto rounded-chip bg-inset p-2 text-[11px] font-normal text-ink-2 shadow-inset-field">
            {event.output}
          </pre>
        </div>
      )}
    </div>
  )
}
