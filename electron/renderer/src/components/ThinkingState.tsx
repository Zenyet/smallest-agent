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
// ⚠️ 目前**没有挂载点**（不是死代码，是等一条还没接的数据通路）。
//
// 它曾经挂在 ChatWindow 底部显示工具轨迹，但那份数据（lastMsg.tools）
// 气泡里的 ToolCallGroup 已经渲染了一遍 —— 同一批工具调用在界面上出现两处，
// 用户报了这个问题。工具调用的实时态现在并进了 ToolCallGroup 的 live。
//
// 保留它是因为**本来的归宿还在**：按参考站（beautifului.dev）的划分，
// 02 Thinking 显示的是**推理过程**，05 Tool Chips 才是工具调用。推理那条路
// 在 acp.ts 的 agent_thought_chunk 分支上，注释写着「接了要新开一条 IPC 通路，
// 而『思考过程要不要显示』是个产品判断」—— 那一天到来时，这个组件就是它的家。
//
// 如果你决定不做推理显示，连同这段注释一起删掉即可。

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
