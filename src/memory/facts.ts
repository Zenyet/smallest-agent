// ============================================================================
// memory/facts.ts —— 跨会话的「事实」记忆（纯函数）
// ----------------------------------------------------------------------------
// 用户报的问题：「我之前回答过我在哪里了，但是换个 session 对话还是没有记住」。
//
// 那不是 bug 而是缺功能 —— 这个仓库里的「跨会话记忆」（memory/store.ts）
// 实际含义是「跨 app 重启还记得**这个**会话」，每个 sessionId 一个 JSON
// 文件，runTurn 只读当前那一个。会话之间从来不共享任何东西。
//
// ## 为什么是「事实」而不是「记忆」
//
// 「记忆」这个词把四件不同的事混在一起，混着做就是维护灾难的起点：
//
//   会话历史   这个会话说过什么      大、全量进上下文   —— 已有（memory/store.ts）
//   事实       「我在深圳」          小、有界、每轮注入 —— 这个文件
//   往事       「上周聊的那个 bug」  无界、要检索        —— 没做，见下面
//   项目知识   「这仓库怎么构建」    小                  —— 就是带作用域的事实
//
// 项目知识**刻意不做成独立系统**：它就是 scope='project:…' 的事实。多一套
// 就多一条写路径，而写路径的数量直接决定这套东西能不能活过半年。
//
// 往事检索（对历史会话做 RAG）不在这一版里。它是贵的那一半，而用户报的问题
// 完全落在事实层。基础设施（src/rag 的 Embedder/VectorStore）已经有了，
// 将来要做的话是新增一个 recall 工具，不用改这里。
//
// ## 为什么 key 是整个设计里最重要的一个决定
//
// 每条事实带一个 key（模型自己起的 slug，如 `user-location`）。同 key 同
// 作用域 = 覆盖，不是新增。
//
// 没有 key 的话：模型第 1 轮记「用户在深圳」，第 5 轮记「用户住深圳」——
// 两条。一个月后 200 条里 60 条是近义重复，全都在吃上下文预算。有了 key，
// 去重是**结构性**的：不需要 embedding 相似度，不需要额外的模型调用，
// 也不会误合并两条真的不同的事实。
// ============================================================================

import { estimateTokens } from './compact'

/**
 * 事实的作用域。
 *
 * 两级：全局的（「我在深圳」）和跟着项目走的（「这个仓库用 pnpm」）。
 * project 那一级用**工作目录**当标识，因为这个 app 的项目本来就是一个本地
 * 目录（见 electron/main/projects.ts），不需要再发明一套 id。
 */
export type FactScope = 'global' | `project:${string}`

export interface Fact {
  /**
   * 稳定标识，模型自己起。同 key 同 scope 视为同一条事实（覆盖而不是新增）。
   *
   * 让模型起而不是我们生成：它知道「这条讲的是什么」。实践中模型对
   * slug 命名相当稳定 —— 问它用户在哪，它会用 user-location 而不是随机串。
   */
  key: string
  /** 事实本身，一句话。 */
  value: string
  scope: FactScope
  /** 最后一次写入的时刻（Date.now()）。注入时按它排序，淘汰时按它取舍。 */
  updatedAt: number
  /** 哪个会话记下的。只给人看（排查「这条哪来的」），不发给模型。 */
  sourceSessionId?: string
}

/**
 * 一个作用域内最多留几条。超了淘汰最旧的（LRU）。
 *
 * 40 条 × 平均 15 字 ≈ 600 token，是个能接受的常驻开销。
 *
 * **刻意不做 TTL 自动过期**：「我在深圳」不该因为三个月没提就消失，而从
 * 外部无法分辨哪条是耐久事实、哪条是临时状态。宁可留着让用户删，
 * 也不要静默丢掉他以为还记着的东西。
 */
export const MAX_FACTS_PER_SCOPE = 40

/** 单条事实的长度上限。防止模型把一整段对话塞进一条。 */
export const MAX_VALUE_LEN = 200

/** 这个工作目录对应的作用域。没有工作目录（未分组会话）只有全局。 */
export function scopeFor(cwd: string | undefined): FactScope | null {
  const trimmed = cwd?.trim()
  return trimmed ? `project:${trimmed}` : null
}

/**
 * 写入一条事实。同 key 同 scope 覆盖，否则追加。
 *
 * 超出上限时淘汰这个作用域里最旧的 —— 只淘汰同作用域的，全局事实不会
 * 因为某个项目记太多而被挤掉。
 */
export function upsertFact(
  facts: readonly Fact[],
  input: { key: string; value: string; scope: FactScope; sessionId?: string },
  now: number,
): Fact[] {
  const key = input.key.trim().toLowerCase()
  const value = input.value.trim().slice(0, MAX_VALUE_LEN)
  // 空 key 或空 value 是无意义的写入，原样返回（调用方用引用比较跳过写盘）
  if (!key || !value) return facts as Fact[]

  const fresh: Fact = {
    key,
    value,
    scope: input.scope,
    updatedAt: now,
    ...(input.sessionId ? { sourceSessionId: input.sessionId } : {}),
  }

  const idx = facts.findIndex((f) => f.key === key && f.scope === input.scope)
  if (idx >= 0) {
    const next = [...facts]
    next[idx] = fresh
    return next
  }

  const next = [...facts, fresh]
  // 淘汰：只在这个作用域内部算，别的作用域不受影响
  const sameScope = next.filter((f) => f.scope === input.scope)
  if (sameScope.length <= MAX_FACTS_PER_SCOPE) return next
  const doomed = new Set(
    [...sameScope]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, sameScope.length - MAX_FACTS_PER_SCOPE),
  )
  return next.filter((f) => !doomed.has(f))
}

/** 删掉一条。不存在时**原样返回同一个对象**（调用方靠引用比较跳过写盘）。 */
export function forgetFact(facts: readonly Fact[], key: string, scope: FactScope): Fact[] {
  const k = key.trim().toLowerCase()
  const next = facts.filter((f) => !(f.key === k && f.scope === scope))
  return next.length === facts.length ? (facts as Fact[]) : next
}

/**
 * 这一轮该看见哪些事实：全局的 + 当前项目的。
 *
 * 别的项目的事实**不给** —— 「A 仓库用 pnpm」出现在 B 仓库的对话里是噪音，
 * 而且会误导模型。
 */
export function factsFor(facts: readonly Fact[], projectScope: FactScope | null): Fact[] {
  return facts.filter((f) => f.scope === 'global' || (projectScope && f.scope === projectScope))
}

/**
 * 渲染成系统提示的一段。空数组返回空串（调用方据此跳过拼接）。
 *
 * ## 为什么注入系统提示，而不是往 history 前面插一条消息
 *
 * 插 history 看起来更自然，但会引入一个真实的 bug：`onComplete` 把整个
 * messages 存回磁盘，下一轮它就在 history 里了，然后你再插一次 → 每轮
 * 重复一份，越滚越多。
 *
 * 这正是现有那个 `【之前对话摘要】` 的毛病 —— 它是 role:'user'，会被持久化，
 * 所以污染了标题推导（那个 bug 上一轮才修）。
 *
 * 而 builtin.ts 存盘时有 `filter(m => m.role !== 'system')`。走系统提示是
 * **自动免疫**的：一行代码不用改就不会被存进去。
 *
 * @param budgetTokens 允许占用的 token 上限。超了就按新鲜度截断 ——
 *   注入的东西要从压缩预算里扣掉（见 compact.ts 的 maxTokens），
 *   不设上限的话记忆会挤掉历史，两边加起来超窗。
 */
export function renderFacts(facts: readonly Fact[], budgetTokens: number): string {
  if (facts.length === 0) return ''

  // 新鲜的在前：截断时先丢最旧的，而不是随机丢
  const sorted = [...facts].sort((a, b) => b.updatedAt - a.updatedAt)

  const header = `## 你记得的事实

以下是之前对话中记下的信息，**请在回答时优先使用这些事实**：

`
  const lines: string[] = []
  for (const f of sorted) {
    const line = `- ${f.value}`
    // 每加一行量一次：用 estimateTokens 而不是自己数字符，
    // 那样和 compact.ts 的预算算法是同一套（CJK 按字计，其余 4 字符 1 token）
    const probe = [...lines, line].join('\n')
    if (estimateTokens([{ role: 'system', content: header + probe }]) > budgetTokens) break
    lines.push(line)
  }

  // 一条都放不下时返回空串，不返回只有标题的空壳
  if (lines.length === 0) return ''

  return `${header}${lines.join('\n')}

**重要提示**：
- 回答问题前，先检查上面的事实是否已经包含答案
- 如果用户问天气、时间、地点相关的问题，优先使用已知的位置信息
- 如果用户问偏好、习惯相关的问题，优先使用已记录的偏好信息
- 不要重复询问你已经知道的信息，除非用户明确要求更新`
}

/**
 * 规范化：磁盘上那份是**人可以手改的**（见 facts-store.ts 为什么不进
 * electron-store），所以任何一条畸形数据都不该让整个功能崩掉。
 *
 * 丢掉不合形状的条目而不是抛错 —— 用户手改坏一行，不该让他失去全部记忆。
 */
export function normalizeFacts(raw: unknown): Fact[] {
  if (!Array.isArray(raw)) return []
  const out: Fact[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key.trim().toLowerCase() : ''
    const value = typeof o.value === 'string' ? o.value.trim().slice(0, MAX_VALUE_LEN) : ''
    const scope = typeof o.scope === 'string' ? o.scope : ''
    if (!key || !value) continue
    if (scope !== 'global' && !scope.startsWith('project:')) continue
    out.push({
      key,
      value,
      scope: scope as FactScope,
      // 时间戳坏了当「很久以前」，那样它会排在最后、最先被截断，
      // 但不会丢 —— 内容本身还是有价值的
      updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
      ...(typeof o.sourceSessionId === 'string' ? { sourceSessionId: o.sourceSessionId } : {}),
    })
  }
  return out
}
