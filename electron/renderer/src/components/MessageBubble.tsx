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

export function MessageBubble({ message }: { message: ChatMessage }) {
  const groups = groupByTurn(message.tools)

  return (
    <div className={`bubble ${SIDE[message.role]} max-w-[76%] rounded-card px-3 py-2`}>
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
