import ReactMarkdown from 'react-markdown'
import { Icon } from './Icon'
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
    // 类名必须和 MessageBubble 里非流式那个 bubble__text 容器**逐字一致**
    // （只多一个 relative，它不影响盒模型）。差一个 padding，回答写完的瞬间
    // 整段文字就会横向跳一下 —— 见下面 icon 的注释。
    <div className="bubble__text relative text-[13px] leading-relaxed">
      {/* 正在生成的指示放在正文**左侧**（缩进腾出来的那 20px 里）。
       *
       * 为什么需要它：流式文字一出来，ChatWindow 那边的 liveIdle 就变 false、
       * 整个「Agent 正在处理」指示消失，只剩一个闪动光标。而光标停在一段文字
       * 末尾时很难和「答完了」区分开 —— 用户盯着一段话，不知道它还会不会长。
       *
       * 放左侧而不是末尾跟着光标走：位置固定，不随文字长度到处跑，
       * 扫一眼就能确认「这条还在写」。它和光标是两个信号，不冲突 ——
       * 一个说「这条消息在生长」，一个指出「长到这里了」。 */}
      {/* ## 为什么是负偏移，而不是 pl-5 给它腾位
       *
       * 原来这里是「容器 pl-5 + icon left-0」：icon 自己确实脱离了文档流，
       * 但那条 pl-5 是**专门为它预留的空位**，而它只在 streaming 时存在。
       * 回答一写完这个组件被换成 MessageBubble 里那个没有 pl-5 的容器，
       * 20px 内距凭空消失，整段正文横向跳一格。
       *
       * 改成负偏移之后 icon 落在气泡**左侧的外边距**里：聊天区有 px-8 的
       * 32px 空档，气泡贴着它的内容边起始，-18px 把 icon 推到距滚动容器
       * 边框 26px 处 —— 仍在容器内，不会触发横向滚动条
       * （.chat__scroll 是 overflow-y-auto，overflow-x 会跟着变成 auto）。
       * 助手气泡现在没有背景色，所以「在气泡外」这件事视觉上不存在，
       * 看起来就是左边距里的一个状态位。 */}
      {message.streaming && (
        <span className="absolute top-[3px] -left-[18px]" aria-label="正在生成">
          <Icon name="think" size={12} className="animate-spin-slow text-accent" />
        </span>
      )}
      <ReactMarkdown>{message.content}</ReactMarkdown>
      {message.streaming && <span className="cursor" />}
    </div>
  )
}
