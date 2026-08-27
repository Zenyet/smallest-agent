import { useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Icon } from './Icon'
import { ToolCallGroup } from './ToolCallGroup'
import { StreamingText } from './StreamingText'
import type { ChatMessage } from '../chat-reducer'
import type { ToolCallEvent } from '../../../shared/channels'

// 用户气泡靠右、深一层；助手气泡靠左、浅一层。
// bubble--user / bubble--assistant 保留作测试锚点（Step 1 断言它们）。
//
// 拆成两组是因为外层多了一个 wrapper（见 MessageBubble 里那段说明）：
// 对齐归 wrapper，皮肤归气泡本身。
const ALIGN = {
  user: 'self-end items-end',
  assistant: 'self-start items-start',
} as const

const SKIN = {
  user: 'bubble--user bg-field shadow-hairline',
  assistant: 'bubble--assistant bg-surface shadow-card',
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

// 气泡**下面**那条悬浮操作栏：复制（+ 用户消息的编辑）。
//
// ## 为什么在气泡外面
//
// 原来这条栏渲染在气泡内部，于是气泡的 py-2 会在它下面再垫一层 padding ——
// 表现出来就是「气泡底部空了一块」，而且没有徽章的消息（绝大多数）那块空白
// 完全是白给的。gpui 侧是「气泡下面那一行」（chat.rs 的 render_message_actions
// 文件头原话），操作栏和气泡是兄弟节点。这里跟它对齐。
//
// ## 为什么在这一层，而不在 StreamingText 里
//
// 原来复制按钮写在 StreamingText 里，条件是 `!message.streaming` —— 而那个组件
// 只在 streaming 为 true 时被渲染，所以**那个按钮从来没出现过**（见 StreamingText
// 的文件头）。放在气泡这一层，流式和非流式两种状态都能用。
//
// 用户消息也给复制：它是「我发出去的原话」，重发或改写时要拿回来。
function MessageActions({
  message,
  onEdit,
}: {
  message: ChatMessage
  /** 点编辑。不传就不显示那个按钮（助手消息、或正在跑的时候） */
  onEdit?: () => void
}) {
  const [copied, setCopied] = useState(false)

  // 空内容不给操作栏，避免一个字符都没收到时冒出个假的空拷贝
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
      className={`mt-0.5 flex h-[18px] items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 ${
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

      {/* 编辑只给用户消息：改模型说过的话没有意义 —— 它不是「我想说的」，
          改了也不会让模型重新想。 */}
      {onEdit && (
        <button
          type="button"
          aria-label="编辑"
          className="flex h-5 w-5 items-center justify-center rounded-chip text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
          onClick={onEdit}
        >
          <Icon name="edit" size={12} />
        </button>
      )}
    </div>
  )
}

// 编辑态：气泡**原地**变成输入框。
//
// ## 为什么不塞回底部的 composer
//
// 所有主流客户端（ChatGPT、Claude）都是气泡原地变输入框，下面配「取消 / 发送」。
// 塞回 composer 的问题是用户失去「我在改哪一条」的位置感 —— 尤其历史很长、
// 那条已经滚出视口的时候，内容突然出现在底部输入框里，看着像凭空多了一段草稿。
// （gpui 侧 begin_edit 的文件头记着同一条，那边第一版就是塞回 composer，是错的。）
function EditForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  // 自动增高，手法和 composer 那个一样（先归零再读 scrollHeight，否则内容变短时
  // scrollHeight 被旧高度撑住，量不出「该缩回去」）。
  // 上下限对齐 gpui 的 auto_grow(2, 6)：min 2 行让短消息的编辑框和原气泡差不多大，
  // max 6 行而不是 composer 的 10 —— 那会让长消息的编辑框把整个对话区顶开。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const line = 18
    el.style.height = '0px'
    const h = el.scrollHeight
    el.style.height = `${Math.min(Math.max(h, line * 2), line * 6)}px`
    el.style.overflowY = h > line * 6 ? 'auto' : 'hidden'
  }, [text])

  // 挂载时聚焦并把光标放到末尾 —— 用户点编辑就是要接着改，
  // 不该再点一下输入框
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const submit = () => {
    const trimmed = text.trim()
    // 清空了就当取消 —— 发一条空消息没有意义
    if (trimmed.length === 0) {
      onCancel()
      return
    }
    onSubmit(trimmed)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={ref}
        aria-label="编辑消息"
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 回车发送、Shift+回车换行：和 composer 同一套手势，
          // 不用让用户在两个输入框之间切换习惯
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
          // Esc 放弃。这是内联编辑的常规出口，比只能点「取消」快
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-full resize-none rounded-control bg-field px-2 py-1 font-[inherit] text-[13px] leading-[18px] text-ink shadow-inset-field outline-none [overflow-wrap:anywhere] focus:outline-2 focus:outline-offset-[-1px] focus:outline-accent"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-6 cursor-pointer items-center rounded-chip border-none bg-transparent px-2.5 text-[11.5px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          className="flex h-6 cursor-pointer items-center rounded-chip border-none bg-accent px-2.5 text-[11.5px] font-medium text-page transition-opacity duration-150 hover:opacity-90"
        >
          发送
        </button>
      </div>
    </div>
  )
}

export function MessageBubble({
  message,
  onEditResend,
  canEdit = false,
}: {
  message: ChatMessage
  /**
   * 编辑重发：把这条消息换成新内容，砍掉它之后的历史，重新提问。
   * 不传就没有编辑入口（只读场景）。
   */
  onEditResend?: (text: string) => void
  /** 正在跑的时候不许编辑：那一轮还在往 messages 里写，之后的截断会和它打架 */
  canEdit?: boolean
}) {
  const groups = groupByTurn(message.tools)
  const [editing, setEditing] = useState(false)

  // 编辑只给用户消息，且要有落点、且不在跑
  const editable = message.role === 'user' && Boolean(onEditResend) && canEdit

  // 跑起来时正开着的编辑框要收掉 —— 留着它用户会以为还能提交，
  // 而提交会和正在写 messages 的那一轮打架
  if (editing && !editable) setEditing(false)

  return (
    // wrapper 只管对齐和「悬浮范围」，气泡的皮肤在里面那层。
    //
    // group 挂在 wrapper 上：悬浮气泡任意位置都要让下面那条操作栏显形，
    // 而操作栏现在是气泡的**兄弟**（不在气泡内部，见 MessageActions 的说明）。
    // 操作栏常驻但透明（不是 hover 时才挂进 DOM）—— 后者会让这一块在悬浮瞬间
    // 变高，下面所有消息跟着跳一下。常驻占位 + 改 opacity 布局是稳的。
    <div className={`group flex max-w-[76%] min-w-0 flex-col ${ALIGN[message.role]}`}>
      <div className={`bubble ${SKIN[message.role]} min-w-0 max-w-full rounded-card px-3 py-2`}>
        {groups.map((events) => (
          // 同一轮内所有工具调用共享一个 elapsedMs（agent-runner 按轮测量，见那边的注释），
          // 取第一条就是这一组的耗时。
          <ToolCallGroup key={events[0].turn} events={events} elapsedMs={events[0].elapsedMs} />
        ))}

        {editing && onEditResend ? (
          <EditForm
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSubmit={(text) => {
              setEditing(false)
              onEditResend(text)
            }}
          />
        ) : (
          <>
            {/* bubble__text 有样式（styles.css 里给 Markdown 生成的 pre/code 用后代选择器）。
                流式消息用 StreamingText 渲染（打字机出现 + 来源标注），非流式走普通 Markdown。 */}
            {message.streaming ? (
              // StreamingText 里自带 .cursor 光标
              <StreamingText message={message} />
            ) : (
              <div className="bubble__text text-[13px] leading-relaxed">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}

            {/* 徽章行**有徽章才渲染**。原来是无条件的，于是绝大多数消息
                （既没缓存命中也没核查结论）在正文下面挂着一个带 mt-1.5 的
                空 flex 盒子 —— 那是「气泡底部空一块」的另一半原因。 */}
            {(message.cacheHit || message.verdict) && (
              <div className="bubble__badges mt-1.5 flex flex-wrap items-center gap-1.5">
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
            )}
          </>
        )}
      </div>

      {/* 编辑态不显示操作栏：那两个按钮（复制/编辑）在编辑框下面会和
          「取消/发送」挤成四个，而且编辑时要的动作只有后两个 */}
      {!editing && (
        <MessageActions
          message={message}
          onEdit={editable ? () => setEditing(true) : undefined}
        />
      )}
    </div>
  )
}
