// ============================================================================
// remember.ts —— 工具：记下一条事实
// ----------------------------------------------------------------------------
// 模型调这个来写跨会话的记忆（「用户在深圳」「这个仓库用 pnpm」）。
// 和 searchNotes 是同一类：全局能力，不跟着项目走边界。
// ============================================================================

import { z } from 'zod'
import type { Tool } from '../types'
import type { FactScope } from '../memory/facts'

interface Deps {
  /**
   * 写盘。main 进程注入（facts-store.ts 的 rememberFact）。
   *
   * 不在这个文件里直接 import electron —— 保持 src/ 下的东西能被 vitest
   * 直接跑（不需要 @electron/remote 之类的 hack）。
   */
  persist: (input: { key: string; value: string; scope: FactScope; sessionId?: string }) => void
  /** 当前会话 ID（记进 sourceSessionId，给人排查「这条哪来的」）。 */
  sessionId: string
  /** 当前项目作用域（null = 未分组会话，只能记全局事实）。 */
  projectScope: FactScope | null
}

export function makeRememberTool(deps: Deps): Tool {
  return {
    name: 'remember',
    description: `记下一条事实，以便之后的对话能记得它 —— 换个会话窗口也依然记得。

**识别事实陈述句，立即调用此工具，然后再继续回答。**

当用户的消息包含这些模式时，**先**调用 remember，**再**回答他的问题：

  • "我在…" / "我住…" / "我用…" / "我一般…" / "我最近在…"
  • "这个项目…" / "这个仓库…" / "我们团队…"
  • 明确陈述一个持久的事实（不是疑问、不是请求）

**立即记下** —— 不要等、不要问、不要犹豫。他说完「我最近在用 Rust 写命令行工具」
的**同一轮**就该记，而不是等他再提一次。

记完之后在回答里自然带一句即可，或者什么都不说直接答他的问题。

**该记的例子**（即使他在问别的事，只要句子里带着这些事实，就记）：

  • "我最近在用 Rust 写一个命令行工具，遇到了生命周期的问题"
    → 先记「用户正在用 Rust 写命令行工具」，再回答生命周期问题
  • "我住深圳，想问一下这边有哪些技术社区"
    → 先记「用户住深圳」，再回答社区问题
  • "我们这个项目用 pnpm 管理依赖"
    → 记下来

**不该记的**：

  • 纯疑问句、纯请求、临时状态
  • 你推测的事（只记他真的说了的）
  • 系统提示里已经列出的事实（不重复记）

**作用域（scope）**：

  • "global" —— 关于用户本人的事实（「我在深圳」「我用 VS Code」）。
  • "project" —— 关于当前这个项目/仓库的事实（「这里用 pnpm build」「测试框架是 vitest」）。
    项目事实只在这个工作目录的对话里出现，换个项目就看不到。

**key（必选）**：

  稳定的 slug（kebab-case），代表「这条讲的是什么」。同 key 同作用域会覆盖旧值，
  而不是新增一条 —— 这样「用户在深圳」和「用户住深圳」不会变成两条重复记忆。

  好的 key：user-location, build-command, test-framework, preferred-editor
  坏的 key：fact-1, info, data, user-said-something

**value（必选）**：

  事实本身，一句话。要让「不知道这是哪次对话记下的」的你也能看懂。

  好的：用户在深圳 / 这个仓库用 pnpm build / 测试框架是 vitest
  坏的：在深圳（谁在？）/ 用 pnpm（干什么？）/ vitest（它是什么？）

**例子**：

  用户说「我在深圳工作」→ remember({key:"user-location", value:"用户在深圳", scope:"global"})
  用户说「这个项目跑测试用 npm test」→ remember({key:"test-command", value:"测试命令是 npm test", scope:"project"})
  用户说「我一般用 VS Code」→ remember({key:"preferred-editor", value:"用户偏好的编辑器是 VS Code", scope:"global"})
`,
    parameters: z.object({
      key: z.string().describe('稳定的 slug（kebab-case），代表这条事实的类别。同 key 同作用域会覆盖旧值。'),
      value: z.string().describe('事实本身，一句话。要完整（「用户在深圳」而不是「在深圳」）。'),
      scope: z.enum(['global', 'project']).describe(
        '"global" = 关于用户本人；"project" = 关于当前这个项目（只在这个工作目录的对话里看见）。',
      ),
    }),
    run: async (args) => {
      const { key, value, scope: rawScope } = args
      const k = String(key ?? '').trim()
      const v = String(value ?? '').trim()
      if (!k || !v) return '参数不完整（key 和 value 都必须有内容）'

      // ## 要 project 作用域但没有工作目录时，退到 global 而不是拒绝
      //
      // 原来这里返回一条错误、什么都不记。那个行为在实测里造成了静默丢失：
      // 用户说「我最近在用 Rust 写命令行工具」，模型合理地判断这是项目信息、
      // 选了 scope:"project"，而未分组会话没有工作目录 —— 于是这条事实
      // **消失了**，而用户以为记住了。
      //
      // 退到全局是更好的失败模式：「记在全局」和「完全不记」相比，前者最多
      // 让一条项目事实的作用域偏大（下次在别的地方也会看到它），后者是
      // 直接丢数据。而且模型拿到的返回值会说明这件事，它可以在回答里提一句。
      const wantProject = rawScope === 'project'
      const scope: FactScope = wantProject && deps.projectScope ? deps.projectScope : 'global'
      const downgraded = wantProject && !deps.projectScope

      deps.persist({ key: k, value: v, scope, sessionId: deps.sessionId })

      if (downgraded) {
        return `已记下：${v}（记为全局事实 —— 当前会话没有关联项目目录，所以项目作用域不可用）`
      }
      return `已记下：${v}（${scope === 'global' ? '全局' : '当前项目'}）`
    },
  }
}
