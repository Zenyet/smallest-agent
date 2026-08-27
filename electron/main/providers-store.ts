// provider 状态的持久化。跟 projects-store.ts 同样的手法（electron-store →
// userData），但存在自己的顶层 key 下，跟设置和项目分组互不干扰。
//
// 为什么不存进会话文件：见 providers.ts 顶部的说明 —— src/ 冻结，
// createJsonSessionStore 每轮都整体覆写 Message[]，塞进去的元数据活不过一轮。
//
// ## 第一次读的时候写一份模板进去
//
// 空状态下选择器里只有内置 agent，用户不知道「这里本来能接外部 CLI」。
// 写一份五家都 disabled 的模板，他打开设置页就能看到有哪些、照着改。
// 只在**从来没写过**时写（用一个独立的标记位判断，不是看 external 是否为空）——
// 看空的话，用户特意把五家全删掉之后，下次启动它们又回来了。
import Store from 'electron-store'
import {
  emptyProvidersState,
  exampleProvidersState,
  normalizeProvidersState,
  type ProvidersState,
} from './providers'

interface Shape {
  providers: ProvidersState
  /** 模板是否已经写过。见文件头「第一次读的时候写一份模板进去」。 */
  providersSeeded: boolean
}

const store = new Store<Shape>({
  defaults: { providers: emptyProvidersState(), providersSeeded: false },
})

export function getProvidersState(): ProvidersState {
  if (!store.get('providersSeeded')) {
    store.set('providersSeeded', true)
    const seeded = normalizeProvidersState(exampleProvidersState())
    store.set('providers', seeded)
    return seeded
  }
  // 读的时候过一遍 normalize：磁盘上的 JSON 可能是手改的（这个文件就是给人改的）、
  // 或者旧版本写的，一个畸形条目不该让选择器渲染时炸掉
  return normalizeProvidersState(store.get('providers'))
}

export function setProvidersState(state: ProvidersState): ProvidersState {
  const normalized = normalizeProvidersState(state)
  // 显式写过就算 seeded，免得「用户删空 → 下次启动模板回来」
  store.set('providersSeeded', true)
  store.set('providers', normalized)
  return normalized
}

/** 配置文件路径，给设置页显示「去哪儿改」。 */
export function providersStorePath(): string {
  return store.path
}
