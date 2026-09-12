import { TurnUsage } from './TokenUsage'
import { AttachmentStrip } from './AttachmentPicker'
import { memo, useLayoutEffect, useRef, useState } from 'react'
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
  // 助手气泡去掉背景色：它的内容已经通过字体和间距自成一体，
  // 一块 surface 底色在深色背景上反而像贴了一张卡片，视觉层级混乱。
  assistant: 'bubble--assistant',
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

// 行内显示：按「离现在多远」决定给到哪一级精度。
//
//   今天      14:32           日期是多余的 —— 用户知道今天是哪天
//   今年      9月2日 14:32     补到日
//   往年      2025/9/2 14:32   补到年
//
// 不带秒：气泡里秒级精度没有意义，而且会让这串比旁边两个按钮还宽。
// 需要精确到秒的场合走下面 fullTs 的 title 提示。
function formatTs(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// 悬停提示里的完整时刻：年月日 + 时分秒 + 星期。
// 行内那串为了不喧宾夺主省掉了日期/秒，这里补齐 —— 「这条到底是哪天说的」
// 是排查对话时真会问的问题，而省略的信息总得有个地方能拿回来。
function fullTs(ts: number): string {
  const d = new Date(ts)
  const p2 = (n: number) => n.toString().padStart(2, '0')
  const week = '日一二三四五六'[d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${week} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

// 气泡**下面**那条悬浮操作栏：复制（+ 用户消息的编辑）+ 时间戳。
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
    // w-full + justify-end：两侧的操作栏都贴各自气泡的**右边缘**。
    //
    // 助手侧原来是默认的左对齐。w-full 是必须的 —— 外层 wrapper 是
    // `items-start`，不给宽度的话这一行会收缩到内容宽度、贴在左边，
    // 光加 justify-end 没有任何效果（没有多余空间可分配）。
    //
    // mt 两侧不同：用户气泡有 bg-field 底色，操作栏紧贴着那个色块下沿会显得挤，
    // 给到 6px；助手气泡现在没有背景，2px 就够，再多会让它和正文脱开。
    <div
      className={`flex h-[18px] w-full items-center justify-end gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 ${
        message.role === 'user' ? 'mt-1.5' : 'mt-0.5'
      }`}
    >
      {/* 时间戳。没有 timestamp 就不渲染 —— 那是**旧会话文件**里的消息，
          我们确实不知道它们发生在什么时候（见 types.ts 里那个字段的注释），
          留空比编一个时刻诚实。
          用户侧靠右（父容器 justify-end），助手侧靠左（flex 默认顺序）。 */}
      {message.timestamp && (
        <span
          className="px-0.5 text-[11px] text-ink-3 tabular-nums"
          title={fullTs(message.timestamp)}
        >
          {formatTs(message.timestamp)}
        </span>
      )}

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

/**
 * 一个消息气泡。
 *
 * ## 为什么包了 memo
 *
 * 用户在输入框每敲一个字，ChatWindow 就重渲染一次（textarea 是受控的，
 * `value={text}` 那份 state 必须在那一层）。不 memo 的话几十个气泡跟着
 * 重渲染 —— 而它们的内容跟输入框里的字毫无关系。长会话下这是打字延迟的
 * 主要来源。
 *
 * memo 生效有个前提：props 必须稳定。所以 onEditResend 的签名改成了
 * `(index, text)` + 一个 useCallback 稳住的引用 —— 原来那里是
 * `(text) => onEditResend(start + i, text)`，每次渲染新建一个闭包，
 * memo 每次都会判定「props 变了」，等于没包。
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  index = 0,
  onEditResend,
  canEdit = false,
  live = false,
}: {
  message: ChatMessage
  /**
   * 这条消息在完整 messages 里的下标。编辑重发要用它定位截断点。
   * 只读场景（没有 onEditResend）用不到，所以可选。
   */
  index?: number
  /**
   * 编辑重发：把第 index 条消息换成新内容，砍掉它之后的历史，重新提问。
   * 不传就没有编辑入口（只读场景）。
   *
   * 收 index 而不是让调用方闭包捕获它：那样每个气泡每次渲染都会拿到一个
   * 新函数，把 memo 破掉（见上面）。
   */
  onEditResend?: (index: number, text: string) => void
  /** 正在跑的时候不许编辑：那一轮还在往 messages 里写，之后的截断会和它打架 */
  canEdit?: boolean
  /**
   * 这条消息的**最后一组**工具调用正在进行中。
   *
   * 只给最后一组：前面几组已经跑完了，它们的 turn 早就结束。
   * 由 ChatWindow 判断（它才知道 running 和「谁是最后一条」）。
   */
  live?: boolean
}) {
  const groups = groupByTurn(message.tools)
  // 有工具卡片就定宽 —— 它们展开/折叠会改变内容宽度，见下面 wrapper 的注释
  const hasTools = groups.length > 0
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
    // w-fit + max-w：气泡按内容收缩（短消息不该占满一行），但**上限固定**。
    //
    // 有工具卡片时改成定宽：那些卡片展开后里面是 <pre>（不换行，固有宽度
    // 等于最长那一行），会把气泡撑到上限；一折叠又缩回去 —— 表现出来就是
    // 每次点开/收起整个气泡都在抖。定宽之后展开只改变高度，宽度不动。
    <div
      className={`group flex ${hasTools ? 'w-[76%]' : 'w-fit'} max-w-[76%] min-w-0 flex-col ${ALIGN[message.role]}`}
    >
      <div className={`bubble ${SKIN[message.role]} min-w-0 max-w-full rounded-card px-3 py-2`}>
        {message.contentParts && <AttachmentStrip attachments={message.contentParts} />}
        {groups.map((events, gi) => (
          // 同一轮内所有工具调用共享一个 elapsedMs（agent-runner 按轮测量，见那边的注释），
          // 取第一条就是这一组的耗时。
          <ToolCallGroup
            key={events[0].turn}
            events={events}
            elapsedMs={events[0].elapsedMs}
            live={live && gi === groups.length - 1}
          />
        ))}

        {editing && onEditResend ? (
          <EditForm
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSubmit={(text) => {
              setEditing(false)
              onEditResend(index, text)
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
            <TurnUsage records={message.usages} />
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
})
