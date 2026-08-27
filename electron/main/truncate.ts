// ============================================================================
// truncate.ts —— 按「第几条用户消息」截断磁盘历史
// ----------------------------------------------------------------------------
// 编辑重发要砍历史，而**界面的下标和磁盘的下标不是一一对应的**：
// 磁盘上一轮对话是「带 toolCalls 的 assistant → 若干条 tool 结果 → 有正文的
// assistant」好几条消息（见 hydrate.ts 的说明），界面上它们被压成一个气泡。
// 所以不能拿界面下标直接 truncate 磁盘数组 —— 那会砍在一轮的中间，
// 留下一条「调了工具但没有结果」的残缺历史，下一轮模型读到它会懵。
//
// 能对齐两边的锚点是**用户消息**：它在磁盘和界面上都是一条、顺序一致、
// 不会被折叠。所以按「第几条 user」定位。
//
// 单独一个文件是为了能测：纯函数（Message[] 进、Message[] 出），
// 不需要 electron 环境。gpui 侧同一个算法内联在 submit_edit 里
// （rs/ui/src/chat.rs），那边没有单独测它。
// ============================================================================

import type { Message } from '../../src/types'

/**
 * 砍到第 `nthUser` 条用户消息（0-based）**之前**，那一条本身也砍掉。
 *
 * `nthUser` 就是「界面上这条消息之前有几条用户消息」—— 编辑第一条用户消息时
 * 传 0，编辑第二条时传 1。
 *
 * 越界（`nthUser` 大于历史里的用户消息条数）时原样返回：这不该发生，
 * 但真发生了的话「什么都不砍」比「砍掉全部」安全 —— 后者会静默清空历史。
 */
export function truncateAtNthUser(history: Message[], nthUser: number): Message[] {
  if (nthUser < 0) return history
  let seen = 0
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'user') continue
    if (seen === nthUser) return history.slice(0, i)
    seen += 1
  }
  // 没找到第 nthUser 条 user
  return history
}
