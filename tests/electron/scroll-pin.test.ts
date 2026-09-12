import { describe, it, expect } from 'vitest'
import {
  AT_BOTTOM_PX,
  COOLDOWN_MS,
  gapToBottom,
  initialPinState,
  onScrolled,
  onSessionSwitch,
  onUserIntent,
  type PinState,
} from '../../electron/renderer/src/scroll-pin'

// ============================================================================
// 「要不要跟着滚到底」的决策
//
// 用户先报「向上滚动打断不了自动滚底」，修完又报「向上滚动时会抖动」。
// 这一组锁两次修复的结果。为什么测纯函数而不是组件：见 scroll-pin.ts 的文件头
// （我写过两版组件级测试，都在验证空气 —— 逻辑改回旧版本测试照样全过）。
// ============================================================================

const T0 = 1_700_000_000_000

describe('gapToBottom', () => {
  it('算离底距离', () => {
    expect(gapToBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(0)
    expect(gapToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 500 })).toBe(300)
  })
})

describe('初始状态', () => {
  it('默认粘住底部 —— 打开对话时停在最新消息', () => {
    expect(initialPinState().pinned).toBe(true)
  })

  it('切换会话时重新粘住', () => {
    expect(onSessionSwitch().pinned).toBe(true)
  })
})

describe('用户上滚', () => {
  // ## 用户报的第一件事：向上滚动打断不了自动滚底
  it('上滚一次就解除粘附', () => {
    const after = onUserIntent(initialPinState(), true, 0, T0)
    expect(after.pinned).toBe(false)
  })

  it('上滚同时记下时刻（冷静期的起点）', () => {
    const after = onUserIntent(initialPinState(), true, 0, T0)
    expect(after.liftedAt).toBe(T0)
  })

  // 哪怕此刻还贴着底也要解除 —— 用户的动作就是意图，位置不重要
  it('贴着底往上滚也解除', () => {
    const after = onUserIntent(initialPinState(), true, 0, T0)
    expect(after.pinned).toBe(false)
  })
})

describe('用户下滚', () => {
  const lifted: PinState = { pinned: false, liftedAt: T0 }

  it('滚到底就恢复粘附', () => {
    expect(onUserIntent(lifted, false, 0, T0 + 1000).pinned).toBe(true)
  })

  it('8px 以内算到底（缩放比例会留零头）', () => {
    expect(onUserIntent(lifted, false, AT_BOTTOM_PX, T0 + 1000).pinned).toBe(true)
  })

  // ## 用户报的第二件事：抖动。宽容差是根因之一
  it('离底 40px 不算到底 —— 宽容差会在流式增高时误判', () => {
    expect(onUserIntent(lifted, false, 40, T0 + 1000).pinned).toBe(false)
  })

  it('离底很远时下滚不恢复', () => {
    expect(onUserIntent(lifted, false, 300, T0 + 1000).pinned).toBe(false)
  })
})

describe('scroll 事件（拖滚动条 / 惯性 / 程序滚动都走它）', () => {
  const lifted: PinState = { pinned: false, liftedAt: T0 }

  // ## 抖动的另一半根因：惯性滚动
  //
  // macOS 惯性在手离开后继续派发 scroll，而流式内容同时长高。没有冷静期的话
  // 某一帧算出「快到底了」就把粘附点亮，下个 chunk 又把用户拽回去。
  it('冷静期内不恢复，哪怕已经贴到底', () => {
    const after = onScrolled(lifted, 0, T0 + COOLDOWN_MS - 1)
    expect(after.pinned).toBe(false)
  })

  it('冷静期内离底 40px 也不恢复', () => {
    expect(onScrolled(lifted, 40, T0 + 100).pinned).toBe(false)
  })

  it('过了冷静期、真的贴到底才恢复', () => {
    expect(onScrolled(lifted, 0, T0 + COOLDOWN_MS).pinned).toBe(true)
  })

  it('过了冷静期但离底 40px 仍然不恢复（严格判据）', () => {
    expect(onScrolled(lifted, 40, T0 + COOLDOWN_MS + 100).pinned).toBe(false)
  })

  // 这一条保证「粘着的时候 scroll 事件不会把它弄掉」——
  // 程序自己的滚动也走这条通路，它不该有副作用
  it('已经粘着时保持粘着', () => {
    const pinned = initialPinState()
    expect(onScrolled(pinned, 0, T0).pinned).toBe(true)
  })

  it('从没上滚过（liftedAt=0）时不受冷静期影响', () => {
    const fresh: PinState = { pinned: false, liftedAt: 0 }
    expect(onScrolled(fresh, 0, T0).pinned).toBe(true)
  })
})

describe('完整的一轮交互', () => {
  it('上滚 → 惯性事件 → 内容继续长高，全程不被拽回底部', () => {
    let s = initialPinState()
    // 用户上滚
    s = onUserIntent(s, true, 0, T0)
    expect(s.pinned).toBe(false)

    // 惯性阶段派发好几次 scroll，位置逐渐接近底部（流式在长高）
    for (const [dt, gap] of [
      [50, 20],
      [120, 40],
      [200, 15],
      [350, 5], // 甚至一度贴到底 —— 旧逻辑到这里就被点亮了
    ] as const) {
      s = onScrolled(s, gap, T0 + dt)
      expect(s.pinned).toBe(false)
    }
  })

  it('用户真的滚回底部后，恢复跟随', () => {
    let s = onUserIntent(initialPinState(), true, 0, T0)
    // 冷静期过后，用户主动往下滚到底
    s = onUserIntent(s, false, 0, T0 + 1000)
    expect(s.pinned).toBe(true)
  })
})
