import { useState } from 'react'
import { Icon } from './Icon'
import type { ToolCallEvent } from '../../../shared/channels'

// 正在跑的这一轮里，agent 到底在干什么 —— 一个默认收起的「思考轨迹」。
// 跟 ToolCallGroup 的分工：ToolCallGroup 渲染历史消息里已经跑完的某轮
// （展开看到结果）；ThinkingState 只出现在 running 期间，露出的是"当下这一刻
// 还没跑完的工具调用"。所以 running=true 时才挂载，一旦这轮结束就卸掉，
// 让位给 MessageBubble 里那个轮的 ToolCallGroup 摘要。
//
// 默认收起：思考过程只是给用户"看它没卡住"的安心感，不是第一优先级信息。
// 语音/文字回答才是主角，轨迹在需要时再展开。
export function ThinkingState({ tools }: { tools: ToolCallEvent[] }) {
  const [open, setOpen] = useState(false)
  const current = tools.at(-1)
  const label = current ? `正在调用 ${current.toolName}` : '正在思考'

  return (
    <div
      className={`w-fit max-w-[76%] self-start overflow-hidden rounded-card bg-surface shadow-card transition-[border-radius] duration-200 ${
        open ? 'rounded-b-none' : ''
      }`}
    >
      <button
        type="button"
        aria-expanded={open}
        // aria-controls 指向下面那个面板；收起时内容没必要留在 DOM（trace 很轻，
        // 展开/收起各一次交互，不需要 preserve-content）
        aria-controls={open ? 'thinking-trace' : undefined}
        className="flex h-7 cursor-pointer items-center gap-2 rounded-card border-none bg-transparent px-2.5 text-[12px] text-ink-2 transition-colors duration-100 hover:bg-hover"
        onClick={() => setOpen((v) => !v)}
      >
        {/* 思考态用 think 星芒 + 呼吸；text-ink-3 让它低调，别跟回答抢注意力 */}
        <span className="flex items-center gap-1.5 text-accent">
          <Icon name="think" size={13} className="animate-spin-slow" />
        </span>
        <span className="text-ink">{label}</span>
        {tools.length > 1 && (
          <span className="font-mono text-[11px] tabular-nums text-ink-3">{tools.length}</span>
        )}
        <Icon name="chevron" size={11} rotated={!open} />
      </button>

      {/* 展开轨迹：grid-rows 折叠动画（0fr→1fr），不展开时高度归零 */}
      <div
        id="thinking-trace"
        role="region"
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <ol className="m-0 flex list-none flex-col gap-0.5 border-t border-line px-2.5 py-1.5">
            {tools.map((t, i) => (
              <li key={`${t.turn}-${t.toolName}-${i}`} className="flex items-center gap-1.5 text-[12px]">
                {i === tools.length - 1 ? (
                  <Icon name="think" size={11} className="text-accent" />
                ) : (
                  <Icon name="check" size={11} className="text-green" />
                )}
                <span className="font-mono text-ink-2">{t.toolName}</span>
                {typeof t.elapsedMs === 'number' && (
                  <span className="ml-auto font-mono text-[11px] text-ink-3">
                    {(t.elapsedMs / 1000).toFixed(1)}s
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}
