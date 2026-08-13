import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageBubble } from './MessageBubble'
import { ApprovalCard } from './ApprovalCard'
import { LoadingState } from './LoadingState'
import { ThinkingState } from './ThinkingState'
import { Icon } from './Icon'
import { visibleRange } from '../visible-window'
import type { SessionChat } from '../chat-reducer'
import type { ApprovalDecision, ErrorCode } from '../../../shared/channels'

const ERROR_TEXT: Record<ErrorCode, string> = {
  API_KEY_MISSING: '请在设置中配置 DeepSeek API Key',
  MODEL_ERROR: '模型调用失败，请检查网络或 API 配额',
  MAX_TURNS: 'Agent 反复调用工具未能收敛，已停止（可在设置中调大 MAX_TURNS）',
  BUSY: '上一个问题还在处理中，请稍候',
  // src/ 冻结、runAgent 没有取消机制，所以正在跑的会话不让删（删了那一轮还会继续跑完
  // 并把文件写回来，会话就"复活"了）。等它跑完再删。
  //
  // 措辞刻意不说"这个会话"：侧边栏的 ✕ 对任何会话都可点，而反馈显示在当前打开的会话上，
  // 两者常常不是同一个。具体是哪个由 error.message 点名（见 App.tsx 的 remove）。
  DELETE_BLOCKED: '删不掉：目标会话还在处理中',
  UNKNOWN: '出错了',
}

// agent 是全局串行的（一个进程一次只跑一个 session），所以「另一个会话正在跑」
// 会让*这个*会话的composer也被禁用。别只给个模糊的「正在思考…」——那是当前
// 会话自己在跑时的文案，用在别的会话头上会让用户以为卡死了，找不到原因也没法解开。
// blockedBy 由 App.tsx 算出「是不是别的会话占着串行锁」，连同去处一起交下来。
export interface BlockedBy {
  sessionId: string
  title: string
  pendingApproval: boolean
}

export function ChatWindow({
  chat,
  sessionId,
  onSend,
  onDecide,
  blockedBy,
  onJumpToBlocking,
}: {
  chat: SessionChat
  sessionId: string
  onSend: (text: string) => void
  onDecide: (decision: ApprovalDecision) => void
  blockedBy?: BlockedBy
  onJumpToBlocking?: () => void
}) {
  const [text, setText] = useState('')
  const [showAll, setShowAll] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // showAll 是展开状态，属于"当前打开的那个会话"，不能泄露到切换后的新会话。
  // 不能用 key={sessionId} 让整个组件重挂，那会丢掉 text（用户打到一半的输入）。
  //
  // 必须是 useLayoutEffect 而不是 useEffect：useEffect 在 render 之后才跑，
  // 所以切到新会话的第一帧仍然带着上个会话的 showAll=true —— 长会话会把几百条
  // 消息全渲染出来、下一帧才收起来，用户看得见这一下闪动。
  // useLayoutEffect 在浏览器绘制前同步执行，把这一帧吃掉。
  // 注意：jsdom 里 act() 会同步跑 effect，两者表现一样，所以这个 bug 测试抓不到，
  // 只能靠这条注释守住 —— 别改回 useEffect。
  useLayoutEffect(() => {
    setShowAll(false)
  }, [sessionId])

  // 新消息到达时滚到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.messages])

  // 输入框随内容自动增高，封顶后转为内部滚动。手法抄自 bui-reference 的
  // PromptBar.tsx:326-330——高度先归零再读 scrollHeight，是因为不归零的话
  // 内容变短时 scrollHeight 会被旧高度撑住，量不出「应该缩回去」的真实值。
  // maxHeight=200：这是桌面窗口（760px 高），composer 不该吃掉对话区——
  // 200px 大约是 9-10 行折行文字，够粘一段长文本，占比不到窗口高度的三分之一，
  // 剩下的仍然主要留给消息列表。
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const minHeight = 28
    const maxHeight = 200
    el.style.height = '0px'
    const contentHeight = el.scrollHeight
    el.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`
    el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
  }, [text])

  const blocked = chat.running || Boolean(blockedBy)
  const canSend = !blocked && text.trim().length > 0

  const submit = () => {
    if (!canSend) return
    onSend(text.trim())
    setText('')
  }

  const placeholder = (): string => {
    if (chat.pendingApproval) return '等待你确认上方的写操作…'
    if (chat.running) return '正在思考…'
    if (blockedBy) {
      return blockedBy.pendingApproval
        ? `等待你确认「${blockedBy.title}」里的写操作…`
        : `「${blockedBy.title}」正在处理中，请稍候…`
    }
    return '问点什么（Enter 发送，Shift+Enter 换行）'
  }

  const { start, hiddenCount } = showAll
    ? { start: 0, hiddenCount: 0 }
    : visibleRange(chat.messages.length)

  // 实时区：agent 还在跑时，最后一条 assistant 消息身上的 live 状态决定了
  // 下面该渲染三种指示里的哪一种。数据契约里没有独立的"当前轮"字段，
  // live 就从 lastMsg 就地推导 —— running 是信号，tools/content/streaming 是素材。
  const lastMsg = chat.messages.at(-1)
  const liveThinking = chat.running && lastMsg?.role === 'assistant' && lastMsg.tools.length > 0
  // 已经有流式文字在往外冒时，交给 MessageBubble 里的 StreamingText；这里只补
  // "连文字都没有"的纯等待态，避免和气泡里的光标/打字机打架。
  const liveStreamingText = chat.running && lastMsg?.role === 'assistant' && lastMsg.streaming && lastMsg.content.length > 0
  const liveIdle = chat.running && !liveThinking && !liveStreamingText

  return (
    <section className="chat flex min-w-0 flex-1 flex-col">
      <div className="chat__scroll flex flex-1 flex-col gap-2.5 overflow-y-auto px-8 py-6">
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowAll(true)}
            className="flex h-7 cursor-pointer items-center self-center rounded-control border-none bg-surface px-3 text-[12.5px] text-ink-2 shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.97]"
          >
            显示更早的 {hiddenCount} 条消息
          </button>
        )}
        {/* 已知限制：点击「显示更早」会在上方插入消息，scrollTop 不变但 scrollHeight 增长，
            所以用户如果不在顶部会被甩进新插入历史的中段。这对聊天场景可接受 ——
            人们通常滚到顶部才点展开。要完全修正需要 useLayoutEffect 算 delta 调 scrollTop，
            对个人用桌面应用来说复杂度不值。 */}
        {chat.messages.slice(start).map((m, i) => (
          <MessageBubble key={start + i} message={m} />
        ))}
        {/* 实时指示：有可展开的工具轨迹就露 ThinkingState，否则（纯等待）用像素加载器。
            两者都在窗口化 slice 之外 —— 它们只属于"现在正在发生的这一轮"，不受
            「显示更早的消息」窗口影响（窗口折叠的是历史，不是当下） */}
        {liveThinking && <ThinkingState tools={lastMsg!.tools} />}
        {liveIdle && <LoadingState />}
        {chat.pendingApproval && <ApprovalCard request={chat.pendingApproval} onDecide={onDecide} />}
        {chat.error && (
          <p className="chat__error rounded-card bg-red-tint px-2.5 py-1.5 text-[12.5px] text-red shadow-hairline">
            {ERROR_TEXT[chat.error.code]}
            <span className="mt-0.5 block text-[11.5px] font-normal text-ink-2">{chat.error.message}</span>
          </p>
        )}
        <div ref={endRef} />
      </div>

      {blockedBy && (
        // 用户必须能从这里够到那个悬着的审批，否则只能干等最长 5 分钟的超时。
        <div className="chat__blocked mx-8 mb-2.5 flex items-center gap-2 rounded-card bg-orange-tint px-2.5 py-1.5 text-[12.5px] text-orange shadow-hairline">
          <span>
            {blockedBy.pendingApproval
              ? `等待你确认「${blockedBy.title}」里的写操作，agent 一次只能处理一个会话`
              : `「${blockedBy.title}」正在处理中，agent 一次只能处理一个会话`}
          </span>
          {onJumpToBlocking && (
            <button
              onClick={onJumpToBlocking}
              className="chat__blocked-jump ml-auto flex h-7 cursor-pointer items-center rounded-control border-none bg-surface px-3 text-[12px] font-medium text-ink shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.97]"
            >
              前往处理
            </button>
          )}
        </div>
      )}

      {/* composer 是一张卡片（rounded-card + shadow-card 的 hairline ring），
          不再是「输入框贴一个按钮」的裸拼接——文字区在上，控件行在下，跟
          目标截图的结构对齐。焦点态挪到卡片外框上（focus-within），呼应
          组件语言里「聚焦态用一圈柔和描边而非阴影加深」的建议。 */}
      <div className="border-t border-line px-8 pt-2.5 pb-5">
        <div className="flex flex-col gap-1 rounded-card bg-surface p-2 shadow-card transition-[outline-color] duration-150 focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-accent">
          <textarea
            ref={textareaRef}
            value={text}
            disabled={blocked}
            placeholder={placeholder()}
            rows={1}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            className="min-h-7 w-full resize-none bg-transparent px-1 py-1 font-[inherit] text-[13px] leading-[18px] text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 disabled:opacity-60"
          />
          {/* 左侧没有放「+」：截图里的附件入口对应不到任何现有功能，放一个
              点了没反应的按钮比空着更糟（见 task 说明）。右下角只留发送。 */}
          <div className="flex items-center justify-end">
            <button
              type="button"
              aria-label="发送"
              onClick={submit}
              disabled={!canSend}
              className={`flex size-7 shrink-0 items-center justify-center rounded-full transition-[background-color,transform] duration-150 enabled:active:scale-[0.94] disabled:cursor-not-allowed ${
                canSend ? 'bg-ink text-surface' : 'bg-line-strong text-ink-2'
              }`}
            >
              <Icon name="send" size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
