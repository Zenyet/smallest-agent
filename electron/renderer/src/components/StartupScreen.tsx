import { useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { BrandMark } from './BrandMark'
import type { RuntimeStatusEvent } from '../../../shared/channels'

const STEPS = [
  { phase: 'embedding', label: '加载 embedding 模型' },
  { phase: 'indexing', label: '索引笔记' },
  { phase: 'mcp', label: '连接 MCP 工具' },
] as const

export function StartupScreen({
  status,
  onRetry,
}: {
  status: RuntimeStatusEvent
  onRetry: () => void
}) {
  const [restarting, setRestarting] = useState(false)

  // 三个分支渲染的都是 `.startup` 主体，drag 条统一包在最外层一次即可，
  // 见函数末尾的 return。这里只算出 body，不提前 return，否则每个分支都要
  // 重复一遍 drag 条的 JSX。
  let body: ReactNode

  if (status.phase === 'failed') {
    body = (
      <div className="startup flex flex-1 flex-col items-center justify-center gap-2.5 bg-page px-8">
        <h1 className="m-0 mb-1 text-[17px] font-semibold tracking-tight text-ink">启动失败</h1>
        <p id="startup-error" className="startup__error m-0 max-w-[420px] text-center text-[12.5px] text-red">
          {status.detail}
        </p>
        <button
          className="mt-2 flex h-7 cursor-pointer items-center rounded-control border-none bg-ink px-4 text-[12.5px] font-medium text-surface shadow-btn transition-[background-color,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            setRestarting(true)
            onRetry()
          }}
          disabled={restarting}
          aria-describedby="startup-error"
        >
          重启应用
        </button>
      </div>
    )
  } else if (status.phase === 'starting') {
    body = (
      <div role="status" className="startup flex flex-1 flex-col items-center justify-center gap-3 bg-page px-8">
        <BrandMark size={72} />
        <h1 className="m-0 text-[17px] font-semibold tracking-tight text-ink">Smallest Agent</h1>
        <p className="m-0 text-[12.5px] text-ink-3">{status.detail}</p>
      </div>
    )
  } else if (status.phase === 'ready') {
    // ready 表示所有阶段已完成，但 App.tsx 正常流程下不会传 ready 给这个组件
    // （它会直接渲染主 UI）。这里兜底处理以防渲染竞态或未来重构时传入。
    body = (
      <div className="startup flex flex-1 flex-col items-center justify-center gap-2.5 bg-page px-8">
        <h1 className="m-0 mb-2 text-[17px] font-semibold tracking-tight text-ink">Smallest Agent</h1>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {STEPS.map((step) => (
            <li key={step.phase} className="step step--done flex items-center gap-1.5 text-[12.5px] text-green">
              <Icon name="verified" size={12} /> {step.label}
            </li>
          ))}
        </ul>
        <p className="m-0 mt-2 text-[12.5px] text-green">就绪</p>
      </div>
    )
  } else {
    const currentIndex = STEPS.findIndex((s) => s.phase === status.phase)
    body = (
      <div className="startup flex flex-1 flex-col items-center justify-center gap-2.5 bg-page px-8">
        <h1 className="m-0 mb-2 text-[17px] font-semibold tracking-tight text-ink">Smallest Agent</h1>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {STEPS.map((step, i) => {
            const isDone = i < currentIndex
            const isActive = i === currentIndex
            const state = isDone
              ? 'step--done text-green'
              : isActive
                ? 'step--active text-accent'
                : 'text-ink-3'
            return (
              <li key={step.phase} className={`step ${state} flex items-center gap-1.5 text-[12.5px]`}>
                {/* dot 是实心圆点（in-progress），circle 是空心圆（pending），verify 是完成勾 */}
                <Icon name={isDone ? 'verified' : isActive ? 'dot' : 'circle'} size={12} />
                {step.label}
              </li>
            )
          })}
        </ul>
        <p className="m-0 mt-2 text-[12.5px] text-ink-2">{status.detail}</p>
        <p className="m-0 mt-1 max-w-[360px] text-center text-[11.5px] text-ink-3">
          首次运行需要下载 embedding 模型，可能要等几十秒。
        </p>
      </div>
    )
  }

  return (
    // 启动阶段 App.tsx 直接渲染这个组件，此时侧边栏（拖拽区所在处）还没挂载，
    // 所以这里必须自己补一条，否则启动/失败画面期间窗口完全拖不动。
    // 用 absolute 浮在顶部而不是 flex 里的一行：那样它不占布局高度，
    // 下面的内容照旧在整个视口里居中，不会被压下去 36px。
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-9 [-webkit-app-region:drag]"
      />
      {body}
    </div>
  )
}
