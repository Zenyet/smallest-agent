import { useEffect, useState } from 'react'
import { Icon } from './Icon'

// agent 正在跑、但还没有可显示的流式文字或思考轨迹时出现（刚发送、第一段
// 回答还在模型那边，或夹在两次工具调用之间的空洞里）。
//
// ## 形态：一行，图标在文字左边
//
// 原来是一张 76% 宽的卡片，里面塞了一个 4×4 的像素网格加载器 + 两行文字。
// 那个体量对「还没有任何内容」这件事来说太重了 —— 它比一条真实的短回答还
// 显眼，而它承载的信息只有「在跑」和「等了多久」。现在压成一行：
// 一个转动的图标 + 一句话 + 秒数，跟消息气泡对齐但不假装自己是气泡。
//
// ## 秒表为什么读 startedAt 而不是自己数
//
// 原来是 `useState(0)` + setInterval，从**组件挂载**起算。那把「这一轮开始
// 于何时」和「这个组件何时被创建」划了等号 —— 而后者会因为纯 UI 的原因反复
// 发生：切走再切回，ChatWindow 重新挂载，秒表归零。用户看到「等了 40 秒，
// 切个会话回来变成 2 秒」。
//
// 现在起点记在会话桶里（chat-reducer 的 startedAt），这里只负责每秒重算
// 一次「现在 - 起点」。跟组件生命周期彻底解耦。
export function LoadingState({ startedAt }: { startedAt?: number }) {
  // 存 now 而不是 elapsed：elapsed 那种写法是「每秒 +1」，本质上还是在自己
  // 计数，切走那段时间没跑的 tick 就永远补不回来（切回来接着从旧值 +1）。
  // 存时间戳则每次都从真实时钟重算，漏掉的 tick 自动补齐。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // startedAt 缺失时不显示秒数，而不是显示 0s 或 NaN。
  // 缺失是真实存在的情况：reload 之后主进程只知道「这个会话在跑」，
  // 不知道它是什么时候开始的。
  const elapsed = startedAt === undefined ? null : Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <div
      className="loading-state flex w-fit items-center gap-2 self-start px-1 py-1 text-[12.5px]"
      role="status"
      aria-live="off"
    >
      {/* 图标在最左，跟文字同一基线 —— 用户要的「文本左侧的 loading icon」 */}
      <Icon name="think" size={13} className="shrink-0 animate-spin-slow text-accent" />
      {/* shimmer 让这行字自己看着在动，比静态灰字更像「在干活」 */}
      <span className="animate-shimmer bg-[linear-gradient(90deg,var(--color-ink-2)_25%,var(--color-accent)_50%,var(--color-ink-2)_75%)] bg-[length:200%_100%] bg-clip-text text-transparent">
        Agent 正在处理
      </span>
      {elapsed !== null && (
        <span className="font-mono text-[11px] tabular-nums text-ink-3">{elapsed}s</span>
      )}
    </div>
  )
}
