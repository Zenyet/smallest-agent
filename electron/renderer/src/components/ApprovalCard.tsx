import { Icon } from './Icon'
import type { ApprovalDecision, ApprovalRequestEvent } from '../../../shared/channels'

// 写操作的执行前确认。这个卡片是唯一一道闸门 —— main 进程的 approval gate
// 在等它给出决定前不会真的落盘，5 分钟没等到就自动 deny 超时。
//
// onDecide 是必填 prop（没有默认值，没有 `?`）：这里如果允许可选回调，
// 调用方一旦忘了传，点「允许」按钮就会静默什么都不发生 —— 相当于在 UI 层
// 绕开了审批闸口本身要求的确认动作，而且悬而不决的请求会一直占着 agent 的串行锁，
// 直到 5 分钟超时。让 TypeScript 在编译期堵住这个疏漏，比指望运行时不出错更可靠。
export function ApprovalCard({
  request,
  onDecide,
}: {
  request: ApprovalRequestEvent
  onDecide: (decision: ApprovalDecision) => void
}) {
  return (
    // 卡片用 shadow-card（hairline ring + 投影），不用 border —— 遵循站点视觉约定
    <div className="approval max-w-[76%] self-start overflow-hidden rounded-card bg-surface shadow-raised">
      <div className="primitive-card-pad">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-orange-tint text-orange">
            <Icon name="warn" size={12} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-[12.5px] font-semibold text-ink">Agent 想要执行写操作，需要你确认</p>
            <p className="mt-0.5 mb-0 text-[12px] text-ink-2">
              工具：<span className="approval__tool font-mono text-accent-ink">{request.toolName}</span>
            </p>
          </div>
        </div>
        {/* 限高 + 纵向滚动：write_file 的 content 可能是几 KB 的正文，不clamp的话
            卡片会被撑得很高，把允许/拒绝按钮挤到消息列表的可视区域之外。
            这是唯一一道写操作确认关卡，参数展示和决策按钮必须始终同屏可见。 */}
        <pre className="mt-2 max-h-[240px] overflow-x-auto overflow-y-auto rounded-chip bg-inset p-2 text-[11px] font-normal text-ink-2 shadow-inset-field">
          {JSON.stringify(request.args, null, 2)}
        </pre>
      </div>
      <div className="primitive-card-footer flex gap-1.5">
        <button
          type="button"
          className="approval__allow flex h-7 items-center rounded-control bg-ink px-3.5 text-[12px] font-medium text-surface shadow-btn transition-[background-color,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
          onClick={() => onDecide('allow')}
        >
          允许
        </button>
        <button
          type="button"
          className="approval__deny flex h-7 items-center rounded-control bg-surface px-3.5 text-[12px] font-medium text-ink shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.97]"
          onClick={() => onDecide('deny')}
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
