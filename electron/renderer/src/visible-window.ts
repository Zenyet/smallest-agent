// 长会话只渲染最近 N 条。不引虚拟滚动库 —— 对聊天这种「几乎总是看底部」的场景，
// 截断 + 一个「显示更早」按钮就够了，代码量和依赖都小得多。
const DEFAULT_LIMIT = 100

export function visibleRange(
  total: number,
  limit: number = DEFAULT_LIMIT,
): { start: number; hiddenCount: number } {
  const start = Math.max(0, total - limit)
  return { start, hiddenCount: start }
}
