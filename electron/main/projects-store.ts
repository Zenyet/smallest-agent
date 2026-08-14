// 项目分组的持久化。跟 settings-store.ts 同样的手法（electron-store → userData），
// 但存在自己的顶层 key 下，跟设置互不干扰。
//
// 为什么不存进会话文件：见 projects.ts 顶部的说明 —— src/ 冻结，
// createJsonSessionStore 每轮都整体覆写 Message[]，塞进去的元数据活不过一轮。
import Store from 'electron-store'
import { emptyProjectsState, normalizeProjectsState, type ProjectsState } from './projects'

const store = new Store<{ projects: ProjectsState }>({
  defaults: { projects: emptyProjectsState() },
})

// 读的时候过一遍 normalize：磁盘上的 JSON 可能是手改的、或者旧版本写的，
// 一个畸形的 collapsed 字段不该让整个侧边栏渲染时炸掉。
export function getProjectsState(): ProjectsState {
  return normalizeProjectsState(store.get('projects'))
}

export function setProjectsState(state: ProjectsState): ProjectsState {
  const normalized = normalizeProjectsState(state)
  store.set('projects', normalized)
  return normalized
}
