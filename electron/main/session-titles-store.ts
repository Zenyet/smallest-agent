// 会话标题的持久化。跟 projects-store.ts 同样的手法（electron-store → userData），
// 但存在自己的顶层 key 下，跟设置和项目映射互不干扰。
//
// 纯逻辑（规范化、增删）在 session-titles.ts —— 那个文件不 import electron，
// 所以能单测。这里只负责读写。
import Store from 'electron-store'
import {
  forgetTitle,
  normalizeTitles,
  withTitle,
  type SessionTitles,
} from './session-titles'

const store = new Store<{ sessionTitles: SessionTitles }>({
  defaults: { sessionTitles: {} },
})

// 读的时候过一遍 normalize：磁盘上的 JSON 可能是手改的、或者旧版本写的，
// 一个畸形值不该让整个侧边栏渲染时炸掉。
export function getSessionTitles(): SessionTitles {
  return normalizeTitles(store.get('sessionTitles'))
}

/**
 * 改名。空字符串 = 恢复自动推导的标题。
 *
 * 返回写完之后的完整表，renderer 不自己推算 —— 和 projects 那几个 IPC
 * 的约定一致（那样两个窗口会各推算一份，迟早分叉）。
 */
export function setSessionTitle(id: string, title: string): SessionTitles {
  const next = withTitle(getSessionTitles(), id, title)
  store.set('sessionTitles', next)
  return next
}

/** 会话删了，清掉它的标题覆盖。理由见 session-titles.ts 的 forgetTitle。 */
export function forgetSessionTitle(id: string): SessionTitles {
  const before = getSessionTitles()
  const after = forgetTitle(before, id)
  // 引用比较：没这一条就不写盘（forgetTitle 保证原样返回同一个对象）
  if (after !== before) store.set('sessionTitles', after)
  return after
}
