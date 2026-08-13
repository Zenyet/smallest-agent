import ReactMarkdown from 'react-markdown'
import { Icon } from './Icon'
import type { ChatMessage } from '../chat-reducer'

// 流式回答。跟普通 Markdown 块的区别：
//   - 光标：消息还在边接边出（streaming=true）时，在文本末尾放一个闪动的 .cursor
//   - 动作：hover 折起处出现复制按钮，一键把当前已累计的内容拷到剪贴板
//
// 渲染刻意「简单」：流式中间态不做渐进重排（这个上下文里逐字动画的成本 > 收益），
// 平时当纯文本打字机累积，等 streaming=false 后再跑一次完整的 ReactMarkdown。
// 这样切换副作用最小，也不会边输入边触发 markdown 反斜杠转义。
// （数据契约里没有"来源摘录 / 正在写入"字段，那些是 BUI 参考 demo 才有的 ——
// 我们只展示 ChatMessage 真实存在的字段，不为了对齐视觉而发明字段。）
export function StreamingText({ message }: { message: ChatMessage }) {
  const hasContent = message.content.length > 0

  return (
    <div className="bubble__text text-[13px] leading-relaxed">
      <ReactMarkdown>{message.content}</ReactMarkdown>
      {message.streaming && <span className="cursor" />}

      {/* 内容不是空壳时才给复制动作，避免连一个字符都没收到时冒出个假的空拷贝 */}
      {!message.streaming && hasContent && (
        <div className="mt-1.5">
          <button
            type="button"
            aria-label="复制回答"
            className="flex h-6 items-center gap-1 rounded-chip bg-field px-1.5 text-[11px] text-ink-2 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
            onClick={() => navigator.clipboard?.writeText(message.content)}
          >
            <Icon name="copy" size={11} /> 复制
          </button>
        </div>
      )}
    </div>
  )
}
