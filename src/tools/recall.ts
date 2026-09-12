// ============================================================================
// recall.ts —— 工具：回想起之前记下的事实
// ----------------------------------------------------------------------------
// 模型调这个来主动查看已有的记忆 —— 比如用户问「你记得我在哪吗」。
//
// 大部分时候模型不需要调这个：每轮 runTurn 都会把相关事实注入系统提示
// （见 agents.ts 里对 renderFacts 的调用），模型直接就能看见。
//
// 但有两个场景这个工具有用：
//   1. 用户明确问「你记得……吗」—— 模型想确认一下记忆里到底有没有。
//   2. 调试：模型怀疑自己看到的事实不对，想看完整列表。
//
// 这是个轻量查询（返回已经在内存里的事实列表），不涉及 embedding 检索 ——
// 对历史会话做 RAG（「上周聊的那个 bug」）是另一个工具，不在这一版里。
// ============================================================================

import { z } from 'zod'
import type { Tool } from '../types'
import type { Fact, FactScope } from '../memory/facts'

interface Deps {
  /** 读出所有事实（不分作用域）。main 进程注入（facts-store.ts 的 getFacts）。 */
  getAllFacts: () => Fact[]
  /** 当前项目作用域（用来过滤：只返回全局 + 当前项目的）。 */
  projectScope: FactScope | null
}

export function makeRecallTool(deps: Deps): Tool {
  return {
    name: 'recall',
    description: `查看你之前记下的事实。

大部分情况下你**不需要**调这个 —— 每轮对话开始时，相关的事实已经注入到系统提示里了，你能直接看见。

**什么时候用**：

  • 用户明确问「你还记得……吗」「你知不知道我……」—— 想确认记忆里到底有没有。
  • 你怀疑看到的事实过时了，想看完整的记忆列表做排查。

返回的是全局事实 + 当前项目的事实（别的项目的不给，避免串）。`,
    parameters: z.object({}),
    run: async () => {
      const all = deps.getAllFacts()
      // factsFor 的逻辑：全局 + 当前项目
      const relevant = all.filter(
        (f) => f.scope === 'global' || (deps.projectScope && f.scope === deps.projectScope),
      )

      if (relevant.length === 0) {
        return '目前还没有记下任何事实（全局和当前项目都没有）。'
      }

      // 按新鲜度排序，和 renderFacts 一致
      const sorted = [...relevant].sort((a, b) => b.updatedAt - a.updatedAt)
      const lines = sorted.map((f) => {
        const scopeLabel = f.scope === 'global' ? '全局' : '当前项目'
        const age = Math.floor((Date.now() - f.updatedAt) / 86400000) // 天数
        const when = age === 0 ? '今天' : age === 1 ? '昨天' : `${age} 天前`
        return `[${scopeLabel}] ${f.value}（${when}记下，key: ${f.key}）`
      })

      return `记得以下 ${relevant.length} 条事实：\n\n${lines.join('\n')}`
    },
  }
}
