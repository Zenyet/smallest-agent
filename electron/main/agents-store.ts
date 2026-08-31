// 自定义 agent 的持久化。跟 providers-store.ts / projects-store.ts 同样的
// 手法（electron-store → userData），存在自己的顶层 key 下。
//
// 为什么不存进会话文件：见 agents.ts 的文件头 —— src/ 冻结，
// createJsonSessionStore 每轮整体覆写 Message[]，塞进去的元数据活不过一轮。
//
// 这里**不预置模板**（providers-store 那边预置了五家 CLI）。理由不同：
// 外部 CLI 的命令行是从各家 README 抄来的，预置能省用户一次查文档；
// 而自定义 agent 的内容（系统提示）只有用户自己知道要写什么，
// 预置一个「示例 agent」只会变成一条要手动删掉的垃圾。
import Store from 'electron-store'
import { emptyAgentsState, normalizeAgentsState, type AgentsState } from './agents'

const store = new Store<{ agents: AgentsState }>({
  defaults: { agents: emptyAgentsState() },
})

export function getAgentsState(): AgentsState {
  // 读的时候过一遍 normalize：这个文件是给人手改的（写系统提示比在小输入框里
  // 敲舒服），一个畸形条目不该让选择器渲染时炸掉
  return normalizeAgentsState(store.get('agents'))
}

export function setAgentsState(state: AgentsState): AgentsState {
  const normalized = normalizeAgentsState(state)
  store.set('agents', normalized)
  return normalized
}

/** 配置文件路径，给设置页显示「去哪儿改」。 */
export function agentsStorePath(): string {
  return store.path
}
