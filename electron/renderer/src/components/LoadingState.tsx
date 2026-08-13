import { useEffect, useState } from 'react'
import { Icon } from './Icon'

// 像素网格加载器：agent 正在跑、但还没有可显示的流式文字或思考轨迹时出现
// （比如刚发送、第一段回答还在模型输出，或夹在两次工具调用之间的空洞里）。
// 刻意做得"像在干活"而不是"像转圈等死"：一个 4×4 的像素格子在逐格点亮，
// 旁边附一个等宽字体的秒表，告诉用户已经等了多久、还在向前走。
const GRID = 4

// 每个格子的动画延迟做成蛇形递进（隔行反向），视觉上像光在一格一格扫过棋盘
function delayFor(row: number, col: number, size: number): number {
  const snake = row % 2 === 0 ? col : size - 1 - col
  return row * size * 90 + snake * 90
}

export function LoadingState() {
  // 秒表从挂载起计时：这个组件只在 running 且无输出时存在，挂载点就是"这段等待"的起点。
  // 数据契约里没有"这一轮从几点开始"，用本地计时更诚实，不发明字段。
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      className="flex max-w-[76%] flex-col gap-2 rounded-card bg-surface px-3 py-2.5 shadow-card"
      role="status"
      aria-live="off"
    >
      <div className="flex items-center gap-2">
        {/* 像素网格：static grid，每格一个会自己淡入淡出的方块 */}
        <div
          className="grid size-9 shrink-0 place-items-center self-start rounded-chip bg-inset shadow-inset-field"
          aria-hidden
        >
          <div className="grid grid-cols-4 gap-px p-2">
            {Array.from({ length: GRID * GRID }).map((_, i) => {
              const row = Math.floor(i / GRID)
              const col = i % GRID
              return (
                <span
                  key={i}
                  className="size-1 rounded-[1px] bg-accent"
                  style={{ animation: `pixel-on 1s ease-in-out infinite`, animationDelay: `${delayFor(row, col, 4)}ms` }}
                />
              )
            })}
          </div>
        </div>

        <div className="flex flex-col">
          {/* shimmer 占位文本：等宽基准，宽度贴合"小思考中…"这类短语 */}
          <span
            className="animate-shimmer bg-[linear-gradient(90deg,var(--color-ink-2)_25%,var(--color-accent)_50%,var(--color-ink-2)_75%)] bg-[length:200%_100%] bg-clip-text text-[12.5px] font-medium text-transparent"
          >
            Agent 正在处理…（思考、检索、加工具）
          </span>
          {/* 等宽秒表：精确到秒，让人一眼判断"这等待是否异常地久" */}
          <span className="mt-0.5 font-mono text-[11px] tabular-nums text-ink-3">
            <Icon name="think" size={11} className="mr-1 inline-block animate-spin-slow align-[-1.5px] text-accent" />
            已等待 {elapsed}s
          </span>
        </div>
      </div>
    </div>
  )
}
