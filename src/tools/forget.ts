// ============================================================================
// forget.ts —— 工具：忘掉一条记错的事实
// ----------------------------------------------------------------------------
// 和 remember 配对。设置面板里也能删（那是用户的入口），这个是**模型的**入口。
//
// ## 为什么模型也需要能删
//
// 事实会过期，而过期往往是在对话中暴露的：
//
//   用户：我搬到杭州了
//   → 这时系统提示里还写着「用户住在深圳」
//
// 没有这个工具的话模型只能 remember 一条新的，而如果它选了不同的 key
// （比如 user-city 而不是 user-location），两条矛盾的事实会同时留在记忆里，
// 之后每一轮都注入进去 —— 模型自己也不知道该信哪条。
//
// 有了它，模型可以「先忘掉旧的，再记新的」。更常见的是它会直接用同一个 key
// 覆盖（upsert 的语义），那时候不需要这个工具 —— 所以描述里要说清楚
// 什么时候该用哪个。
// ============================================================================

import { z } from 'zod'
import type { Tool } from '../types'
import type { Fact, FactScope } from '../memory/facts'

interface Deps {
  /** 删一条。main 进程注入（facts-store.ts 的 forgetFactByKey）。 */
  forget: (key: string, scope: FactScope) => void
  /** 读出所有事实 —— 要用它校验「这个 key 真的存在吗」。 */
  getAllFacts: () => Fact[]
  /** 当前项目作用域（null = 未分组会话）。 */
  projectScope: FactScope | null
}

export function makeForgetTool(deps: Deps): Tool {
  return {
    name: 'forget',
    description: `删掉一条记错了或已经过期的事实。

**大多数时候你不需要这个** —— 事实变了直接用**同一个 key** 调 remember 就行，
那是覆盖不是新增。「用户从深圳搬到杭州」→ remember({key:"user-location",
value:"用户住在杭州"})，旧的自动没了。

**真正需要 forget 的两种情况**：

  • 这条事实**不该存在**了，而不是「变了」。比如用户说「我不用那个框架了，
    别再记着」—— 没有新值来覆盖它。
  • 你发现记忆里有两条矛盾的事实（不同 key 说着同一件事），要删掉过时那条。

**key 从哪来**：系统提示里列出的事实不带 key。要先调 recall 看到 key，
再用它来删 —— 不要猜。

删错了没法撤销，所以只在用户明确表示某条信息作废时才用。`,
    parameters: z.object({
      key: z.string().describe('要删的那条事实的 key。从 recall 的输出里取，不要猜。'),
      scope: z
        .enum(['global', 'project'])
        .describe('那条事实的作用域。recall 的输出里标了「全局」还是「当前项目」。'),
    }),
    run: async (args) => {
      const key = String(args.key ?? '').trim().toLowerCase()
      if (!key) return '要删哪条？key 不能为空。'

      const wantProject = args.scope === 'project'
      // 未分组会话没有项目作用域 —— 那种情况下只可能删全局的
      const scope: FactScope = wantProject && deps.projectScope ? deps.projectScope : 'global'

      // 先确认它存在。不确认的话「删一个不存在的 key」会静默成功，
      // 而模型会以为自己删掉了什么 —— 下一轮发现那条还在，可能反复重试。
      const exists = deps.getAllFacts().some((f) => f.key === key && f.scope === scope)
      if (!exists) {
        return `没有找到 key 为「${key}」的${scope === 'global' ? '全局' : '项目'}事实。先调 recall 看看现在记着哪些。`
      }

      deps.forget(key, scope)
      return `已忘掉「${key}」这条事实。`
    },
  }
}
