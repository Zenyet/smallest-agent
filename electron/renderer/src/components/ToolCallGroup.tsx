import { useState } from 'react'
import { Icon } from './Icon'
import { ToolCallIndicator, isFailed } from './ToolCallIndicator'
import type { ToolCallEvent } from '../../../shared/channels'

// X.Xs，保留一位小数，跟 beautifului.dev 的耗时 chip 格式对齐。
function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

// 同一 turn 的工具调用压成一行摘要：折叠时只看到「本轮 N 次工具调用 · X.Xs」，
// 点开才展开成逐个 ToolCallIndicator（各自还能再折叠/展开参数和结果）。
//
// elapsedMs 目前没有数据来源 —— ToolCallEvent 不带时间戳，Task 13 接线时才会算出耗时
// 传进来。这里必须接受 undefined 并优雅跳过耗时展示，不能假造一个计时器。
export function ToolCallGroup({
  events,
  elapsedMs,
  live = false,
}: {
  events: ToolCallEvent[]
  elapsedMs?: number
  /**
   * 这一组正在进行中（模型还在调工具，答案还没开始写）。
   *
   * 为 true 时头部换成「正在调用 X」+ 转动的星芒 —— 这条实时信息原来由
   * 底部一个独立的 ThinkingState 显示，那等于把同一份 tools 渲染两遍
   * （气泡里一份 chip，底部一份实时行）。合并到 chip 上之后只剩一处。
   */
  live?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (events.length === 0) return null

  const failedCount = events.filter((e) => isFailed(e.output)).length
  const hasFailed = failedCount > 0

  return (
    // tool-group / tool-group--failed 保留作测试锚点，不带样式
    <div
      className={`tool-group ${hasFailed ? 'tool-group--failed' : ''} mb-1.5 w-full min-w-0 overflow-hidden rounded-control bg-canvas shadow-hairline`}
    >
      <button
        type="button"
        className="tool-group__head flex h-7 w-full items-center gap-1.5 px-2 text-left text-[12px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {/* 进行中优先于失败态：这一组还没跑完，failed 计数不是最终结论 */}
        <span className={live ? 'text-accent' : hasFailed ? 'text-red' : 'text-ink-3'}>
          <Icon
            name={live ? 'think' : hasFailed ? 'warn' : 'tool'}
            size={12}
            className={live ? 'animate-spin-slow' : undefined}
          />
        </span>
        <span>
          {live ? (
            // 点名当前这个工具，而不是只说「正在调用工具」——
            // fetch_url 跑得久的时候，用户想知道卡在哪一步
            `正在调用 ${events[events.length - 1].toolName}`
          ) : (
            <>
              本轮 {events.length} 次工具调用
              {elapsedMs !== undefined && <> · {formatElapsed(elapsedMs)}</>}
            </>
          )}
        </span>
        {hasFailed && (
          <span className="font-mono text-[11px] tabular-nums text-red">
            {failedCount}/{events.length}
          </span>
        )}
        <span className="ml-auto">
          <Icon name="chevron" size={12} className="text-ink-3" rotated={!open} />
        </span>
      </button>
      {/* 默认折叠：把推理证据放在一次点击之外，是 beautifului.dev 模式的核心 */}
      {open && (
        // pt-1.5：展开后第一个条目原本紧贴着标题按钮，中间没有任何间距。
        // 只给 pb 不给 pt 是那种「上下不对称」的典型症状
        <div
          className="min-w-0 px-2 pt-1.5 pb-2"
          style={{ animation: 'fade-in-only 140ms ease-out both' }}
        >
          {events.map((event, i) => (
            <ToolCallIndicator key={`${event.turn}-${event.toolName}-${i}`} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}
