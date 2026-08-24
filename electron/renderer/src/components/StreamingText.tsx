import ReactMarkdown from 'react-markdown'
import type { ChatMessage } from '../chat-reducer'

// 流式回答：正文 + 末尾那个闪动的光标。
//
// 渲染刻意「简单」：流式中间态不做渐进重排（这个上下文里逐字动画的成本 > 收益），
// 平时当纯文本打字机累积，等 streaming=false 后再跑一次完整的 ReactMarkdown。
// 这样切换副作用最小，也不会边输入边触发 markdown 反斜杠转义。
//
// ## 复制按钮不在这里（原来在，但那是个永远不显示的死分支）
//
// 原来这个组件里有一个 `!message.streaming && hasContent` 的复制按钮。
// 它**从来没出现过**：MessageBubble 只在 `streaming === true` 时渲染本组件
// （false 走 else 分支的纯 ReactMarkdown），而按钮的条件是 streaming 为 false ——
// 两个条件互斥。message-complete 把 streaming 置 false 之后这个组件就被换掉了，
// 所以那个按钮的代码路径不可达。
//
// 复制现在是**气泡级**的悬浮操作栏，见 MessageBubble。放在那一层才对：
// 它对流式和非流式两种状态都要可用，而这个组件只覆盖其中一种。
export function StreamingText({ message }: { message: ChatMessage }) {
  return (
    <div className="bubble__text text-[13px] leading-relaxed">
      <ReactMarkdown>{message.content}</ReactMarkdown>
      {message.streaming && <span className="cursor" />}
    </div>
  )
}
