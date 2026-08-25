// ============================================================================
// session-titles.ts —— 用户改过的会话标题（纯逻辑，不碰 electron）
// ----------------------------------------------------------------------------
// 默认标题是从第一条用户消息推的（src/memory 的 sessionTitle）。用户重命名
// 之后要覆盖那个推导结果，而覆盖值没地方存 —— 会话文件的形状由 src/ 的
// createJsonSessionStore 决定（就是 `Message[]`），每答完一轮 onComplete
// 都会整体覆写它，塞进去的元数据活不过一轮。
//
// 所以跟项目映射同一个手法：单独存一份「src/ 不管但 UI 需要」的元数据。
// 对应 gpui 侧的 rs/ui/src/session_titles.rs。
//
// ## 为什么这个文件不 import electron-store
//
// 和 context-menu.ts、projects.ts 一样的分工：规范化/增删这些是会变的逻辑，
// 值得单测，而 `new Store()` 在模块顶层就要 app.getPath()，vitest 在纯 Node
// 下加载不了。所以持久化那一层放在 session-titles-store.ts，这里只做纯函数。
//
// ## 为什么不并进 projects 那个 key
//
// 两者都是「按 sessionId 索引的元数据」，看着能合。但生命周期不同：项目映射
// 在删项目时要批量清理，标题不需要；标题在改名时写，项目映射在新建会话时写。
// 合在一起意味着任何一边的写操作都要读-改-写另一边的数据，多一处出错机会。
// （gpui 那边记的是同一条理由。）
// ============================================================================

/** sessionId → 用户起的标题 */
export type SessionTitles = Record<string, string>

/**
 * 标题最大长度。
 *
 * 和 gpui 侧的 TITLE_MAX 一致 —— 侧边栏那点宽度放不下更长的，
 * 而截断显示（省略号）比让用户以为自己起的名字被完整保留了要诚实。
 */
export const TITLE_MAX = 60

/**
 * 规范化：磁盘上的 JSON 可能是手改的或旧版本写的，一个畸形值不该让整个
 * 侧边栏渲染时炸掉。非字符串的项直接丢掉，空白标题也丢（等于没改名）。
 */
export function normalizeTitles(raw: unknown): SessionTitles {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: SessionTitles = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim().slice(0, TITLE_MAX)
    if (trimmed) out[id] = trimmed
  }
  return out
}

/**
 * 改名，返回新表（不改原表）。
 *
 * 空字符串 = 恢复成自动推导的标题（删掉这条覆盖）。
 */
export function withTitle(titles: SessionTitles, id: string, title: string): SessionTitles {
  const next = { ...titles }
  const trimmed = title.trim().slice(0, TITLE_MAX)
  if (trimmed) {
    next[id] = trimmed
  } else {
    delete next[id]
  }
  return next
}

/**
 * 会话删了，它的标题覆盖也是垃圾了。
 *
 * 不清的话会在存储里越攒越多，而且将来某个新会话万一拿到同样的 id（进程内
 * 计数器保证不会，但跨重启时间戳可能重合）会莫名带上一个它从没被起过的名字。
 * 跟 ipc-handlers 里 forgetSession 的理由一样。
 *
 * 没这一条时**原样返回同一个对象**：调用方可以用引用比较跳过写盘
 * （projects 那边的 forgetSession 是同一个约定）。
 */
export function forgetTitle(titles: SessionTitles, id: string): SessionTitles {
  if (!(id in titles)) return titles
  const next = { ...titles }
  delete next[id]
  return next
}
