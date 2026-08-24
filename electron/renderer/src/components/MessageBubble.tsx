import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Icon } from './Icon'
import { ToolCallGroup } from './ToolCallGroup'
import { StreamingText } from './StreamingText'
import type { ChatMessage } from '../chat-reducer'
import type { ToolCallEvent } from '../../../shared/channels'

// 用户气泡靠右、深一层；助手气泡靠左、浅一层。
// bubble--user / bubble--assistant 保留作测试锚点（Step 1 断言它们）。
const SIDE = {
  user: 'bubble--user self-end bg-field shadow-hairline',
  assistant: 'bubble--assistant self-start bg-surface shadow-card',
} as const

// 按 turn 分组，同一轮的工具调用压成一个 ToolCallGroup 摘要行，而不是逐个平铺。
// tools 数组本身已经按调用顺序追加（chat-reducer 的 tool-call action 是 push），
// Map 的迭代顺序 = 插入顺序，用 order 数组记录 turn 首次出现的顺序即可保留组间顺序，
// 每个分组内部的 events 顺序也天然是调用顺序（同样是 push 进去的）。
function groupByTurn(tools: ToolCallEvent[]): ToolCallEvent[][] {
  const order: number[] = []
  const byTurn = new Map<number, ToolCallEvent[]>()
  for (const tool of tools) {
    let bucket = byTurn.get(tool.turn)
    if (!bucket) {
      bucket = []
      byTurn.set(tool.turn, bucket)
      order.push(tool.turn)
    }
    bucket.push(tool)
  }
  return order.map((turn) => byTurn.get(turn)!)
}

// 气泡下面那条悬浮操作栏：复制。
//
// ## 为什么在这一层，而不在 StreamingText 里
//
// 原来复制按钮写在 StreamingText 里，条件是 `!message.streaming` —— 而那个组件
// 只在 streaming 为 true 时被渲染，所以**那个按钮从来没出现过**（见 StreamingText
// 的文件头）。放在气泡这一层，流式和非流式两种状态都能用。
//
// 用户消息也给复制：它是「我发出去的原话」，重发或改写时要拿回来。
function MessageActions({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false)

  // 空内容不给复制动作，避免一个字符都没收到时冒出个假的空拷贝
  if (message.content.length === 0) return null

  const copy = async () => {
    // clipboard 在非安全上下文里是 undefined，可选链避免抛异常
    await navigator.clipboard?.writeText(message.content)
    setCopied(true)
    // 2 秒后变回复制图标。存布尔 + 定时器而不是时间戳：React 这边有
    // 重渲染驱动，不像 gpui 那侧需要显式安排一次重绘
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className={`mt-1 flex h-[18px] items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 ${
        message.role === 'user' ? 'justify-end' : ''
      }`}
    >
      <button
        type="button"
        aria-label={copied ? '已复制' : '复制'}
        className={`flex h-5 w-5 items-center justify-center rounded-chip transition-colors duration-100 hover:bg-hover hover:text-ink ${
          copied ? 'text-green' : 'text-ink-3'
        }`}
        onClick={copy}
      >
        {/* 复制成功换成绿色对勾 —— 20px 里光换形状很容易看漏，
            所以形状和颜色一起换 */}
        <Icon name={copied ? 'check' : 'copy'} size={12} />
      </button>
    </div>
  )
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const groups = groupByTurn(message.tools)

  return (
    // group：悬浮气泡任意位置都要让下面那条操作栏显形。
    // 操作栏常驻但透明（不是 hover 时才挂进 DOM）—— 后者会让气泡在悬浮瞬间
    // 变高，下面所有消息跟着跳一下。常驻占位 + 改 opacity 布局是稳的。
    <div
      className={`bubble group ${SIDE[message.role]} max-w-[76%] rounded-card px-3 py-2`}
    >
      {groups.map((events) => (
        // 同一轮内所有工具调用共享一个 elapsedMs（agent-runner 按轮测量，见那边的注释），
        // 取第一条就是这一组的耗时。
        <ToolCallGroup key={events[0].turn} events={events} elapsedMs={events[0].elapsedMs} />
      ))}

      {/* bubble__text 有样式（styles.css 里给 Markdown 生成的 pre/code 用后代选择器）。
          流式消息用 StreamingText 渲染（打字机出现 + 来源标注），非流式走普通 Markdown。 */}
      {message.streaming ? (
        // StreamingText 里自带 .cursor 光标、来源气泡和复制等动作，见其实现
        <StreamingText message={message} />
      ) : (
        <div className="bubble__text text-[13px] leading-relaxed">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>
      )}

      <MessageActions message={message} />

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {message.cacheHit && (
          <span className="badge badge--cache flex items-center gap-1 rounded-full bg-green-tint px-2 py-0.5 text-[11.5px] text-green shadow-hairline">
            <Icon name="cache" size={11} /> 缓存命中
          </span>
        )}
        {message.verdict &&
          (message.verdict.grounded ? (
            <span className="badge badge--ok flex items-center gap-1 rounded-full bg-green-tint px-2 py-0.5 text-[11.5px] text-green shadow-hairline">
              <Icon name="verified" size={11} /> 答案被证据支撑
            </span>
          ) : (
            <span className="badge badge--warn rounded-card bg-orange-tint px-2 py-0.5 text-[11.5px] text-orange shadow-hairline">
              <span className="flex items-center gap-1">
                <Icon name="warn" size={11} /> 可能有未被证据支撑的说法
              </span>
              <ul className="mt-1.5 mb-0 list-disc pl-[18px]">
                {message.verdict.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </span>
          ))}
      </div>
    </div>
  )
}
