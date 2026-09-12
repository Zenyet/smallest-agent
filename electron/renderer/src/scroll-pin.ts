// ============================================================================
// scroll-pin.ts —— 「要不要跟着滚到底」的决策
// ----------------------------------------------------------------------------
// 从 ChatWindow 里提出来是为了**能测**。这套逻辑全是时序和阈值的判断，而
// 在 jsdom 里从组件外面测它极难可信：布局尺寸恒为 0，造假要劫持原型；
// 事件监听器还会因为改属性描述符而失效。我为它写过两版组件级测试，两版都
// 在验证空气 —— 把逻辑改回有 bug 的旧版本，测试照样全过。
//
// 纯函数就没这个问题：进去几个数，出来一个决定。
//
// ## 这套逻辑修的是什么
//
// 用户先报「向上滚动打断不了自动滚底」，修完又报「向上滚动时会抖动」。
// 两次的根子都在**判据**上：
//
//   1. 拿 scroll 事件当「用户意图」。程序滚和用户滚派发的是同一个事件，
//      分不清谁滚的 —— 于是自动滚动被当成用户想回底部，粘附永远解不开。
//
//   2. 恢复粘附的容差太宽（离底 80px 就算「到底了」）。macOS 惯性滚动在
//      手离开后继续派发 scroll，而流式内容同时在长高：某一帧算出「离底
//      60px」就把粘附点亮，下一个 chunk 把用户拽回底部，用户继续上滚，
//      wheel 又解除。一秒内来回好几次，就是那个抖动。
// ============================================================================

/** 恢复粘附要求几乎真的贴到底。见文件头第 2 点 —— 宽容差会在流式增高时误判。 */
export const AT_BOTTOM_PX = 8

/**
 * 用户上滚之后的冷静期（毫秒）。
 *
 * 惯性滚动的事件集中在手离开后的几百毫秒里，这段时间一律不恢复粘附 ——
 * 用户此刻的意图明确是「我要往上看」，任何自动恢复都是在跟他抢方向盘。
 */
export const COOLDOWN_MS = 400

export interface PinState {
  /** 跟住底部吗。 */
  pinned: boolean
  /** 上一次「用户主动上滚」的时刻（Date.now()）。0 = 从没上滚过。 */
  liftedAt: number
}

export function initialPinState(): PinState {
  // 打开一个对话时预期停在最新消息处
  return { pinned: true, liftedAt: 0 }
}

/** 离底还有多少像素。 */
export function gapToBottom(m: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight
}

/**
 * 用户表达了一个明确的滚动意图（wheel / 触摸拖动 / 方向键）。
 *
 * 只有这些事件能作为判据 —— 它们**只可能**由用户产生，程序滚动不派发。
 *
 * @param up 是往上滚吗
 * @param gap 当前离底距离
 */
export function onUserIntent(state: PinState, up: boolean, gap: number, now: number): PinState {
  if (up) {
    // 上滚一次就解除，并开始冷静期
    return { pinned: false, liftedAt: now }
  }
  // 往下滚**到底**才恢复。判据和 onScrolled 一致
  if (gap <= AT_BOTTOM_PX) return { ...state, pinned: true }
  return state
}

/**
 * 收到一个 scroll 事件（可能是用户拖滚动条，也可能是惯性或程序滚动）。
 *
 * 这条通路只做「滚回底部时重新粘上」一个方向 —— 反方向（判定用户上滚）
 * 交给 onUserIntent，因为 scroll 分不清是谁滚的（文件头第 1 点）。
 */
export function onScrolled(state: PinState, gap: number, now: number): PinState {
  // 冷静期内不恢复（文件头第 2 点）
  if (now - state.liftedAt < COOLDOWN_MS) return state
  if (gap <= AT_BOTTOM_PX) return { ...state, pinned: true }
  return state
}

/** 切换会话：回到「跟住底部」。 */
export function onSessionSwitch(): PinState {
  return initialPinState()
}
