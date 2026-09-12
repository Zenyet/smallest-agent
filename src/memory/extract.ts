// ============================================================================
// memory/extract.ts —— 每轮结束后自动抽取值得记的事实
// ----------------------------------------------------------------------------
// 这是记忆可靠性的第二道保险。第一道是 remember 工具：模型自己判断该记什么。
// 那一道**是概率性的** —— 实测过，措辞和上下文都会影响它，同一句话在干净会话里
// 记得下、在有干扰历史的会话里就漏掉。
//
// 所以补一道事后的：那一轮答完之后，用一次单独的模型调用回看「用户刚说的话里
// 有没有值得跨会话记住的事实」。
//
// ## 为什么是两道而不是只留这一道
//
// 只留自动提取的话，每轮都要多一次模型调用 —— 而绝大多数轮次里用户什么
// 事实都没说（「帮我改这个文件」「这段代码什么意思」）。所以：
//
//   • 模型主动调 remember —— 零成本，但会漏
//   • 事后自动提取     —— 不漏，但每轮都花钱
//
// 两道叠起来，再加上「这一轮已经调过 remember 就跳过提取」这个短路，
// 常见情况下的成本接近第一道，可靠性接近第二道。
//
// ## 为什么它必须知道已有的事实
//
// 不给的话它会反复抽出同一件事：用户三次提到「我在深圳」，就抽三次
// user-location。给了之后 prompt 里能明确说「这些已经记着了，只报新的或
// 变了的」—— 而 key 相同时 upsert 会覆盖，所以「变了」这种情况也能正确处理。
// ============================================================================

import type { Message, ModelResult } from '../types'
import type { Fact, FactScope } from './facts'

/** 抽出来的一条候选事实。形状和 remember 工具的入参一致。 */
export interface ExtractedFact {
  key: string
  value: string
  /** 'global' 或 'project'。落到具体作用域由调用方翻译（它才知道 cwd）。 */
  scope: 'global' | 'project'
}

/**
 * 抽取器。给「用户说了什么 + 已经记着什么」，返回值得新记的事实。
 *
 * 返回空数组是**最常见**的结果 —— 绝大多数轮次里用户没说任何持久事实。
 */
export type Extract = (input: {
  /** 用户这一轮说的话。 */
  userMessage: string
  /** agent 的回答。给它是为了消解指代（「那我用它吧」里的「它」）。 */
  answer: string
  /** 已经记着的事实，用来避免重复抽取。 */
  existing: readonly Fact[]
}) => Promise<ExtractedFact[]>

const PROMPT = `你是一个事实抽取器。从下面的对话里找出**值得跨会话长期记住**的、关于用户或这个项目的事实。

## 该抽取的

- 关于用户本人：所在地、职业、使用的工具、技术偏好、习惯
- 关于这个项目：构建命令、测试框架、代码约定、部署方式、技术选型

## 不该抽取的

- 一次性任务和请求（「帮我改这个文件」「解释这段代码」）
- 临时状态（「现在报错了」「这次跑失败了」）
- 对话的中间过程、你的推测
- 已经在「已知事实」列表里且**没有变化**的

## 输出格式

严格输出 JSON 数组，不要任何解释文字、不要 markdown 代码块。每项三个字段：

  key    稳定的 slug（kebab-case），代表「这条讲的是什么」。
         同一类事实必须用同一个 key —— 用户位置永远是 user-location，
         不要一次用 user-city 一次用 location。
  value  事实本身，一句完整的话。要让不知道上下文的人也能看懂：
         「用户住在深圳」而不是「深圳」。
  scope  "global"（关于用户本人）或 "project"（关于当前这个项目/仓库）

没有任何值得记的事实时输出：[]

## 例子

对话里用户说「我最近在用 Rust 写命令行工具，遇到生命周期问题」：
[{"key":"current-work","value":"用户正在用 Rust 写一个命令行工具","scope":"global"}]

对话里用户说「帮我看看这个函数为什么报错」：
[]

对话里用户说「我们这个仓库用 pnpm，测试跑 vitest」：
[{"key":"package-manager","value":"这个项目用 pnpm 管理依赖","scope":"project"},{"key":"test-framework","value":"这个项目用 vitest 跑测试","scope":"project"}]`

/**
 * 工厂：注入 callModel，返回抽取器。
 *
 * 注入而不是直接 import：调用方（agent-runner）手里那个 callModel 已经套过
 * 重试/降级，复用它比在这里重建一条链更对。makeSummarizer 是同一个手法。
 */
export function makeExtractor(
  callModel: (messages: Message[]) => Promise<ModelResult>,
): Extract {
  return async ({ userMessage, answer, existing }) => {
    // 已有事实压成一行一条，只给 key 和 value —— 作用域和时间戳对抽取
    // 没有帮助，反而占 token
    const known =
      existing.length > 0
        ? existing.map((f) => `- ${f.key}: ${f.value}`).join('\n')
        : '（还没有记住任何事实）'

    const result = await callModel([
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: `## 已知事实\n\n${known}\n\n## 这一轮的对话\n\n用户：${userMessage}\n\n助手：${answer}`,
      },
    ])
    return parseExtracted(result.text)
  }
}

/**
 * 解析模型输出。
 *
 * **必须容错**：模型会包 markdown 代码块、会加解释文字、偶尔会输出单个对象
 * 而不是数组。这些都不该让抽取整个失败 —— 抽取是增强，它坏掉不该有任何
 * 用户可见的后果。
 *
 * 导出是为了单测：这个函数的每条容错分支都对应一种实际见过的模型输出。
 */
export function parseExtracted(text: string): ExtractedFact[] {
  // 剥掉 ```json ... ``` 之类的包装
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')

  // 模型可能在 JSON 前后加解释文字。截取第一个 [ 到最后一个 ] ——
  // 比正则匹配整个数组更稳（value 里可能有方括号）
  const start = unfenced.indexOf('[')
  const end = unfenced.lastIndexOf(']')
  const json = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced.trim()

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }

  // 偶尔会输出单个对象。当成一条处理，而不是丢掉
  const items = Array.isArray(raw) ? raw : [raw]

  const out: ExtractedFact[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key.trim().toLowerCase() : ''
    const value = typeof o.value === 'string' ? o.value.trim() : ''
    if (!key || !value) continue
    // scope 只认这两个值，别的（包括缺失）都当 global —— 那是更安全的默认：
    // 全局事实在所有会话可见，最坏情况是多看到一条，而不是该看到却看不到
    const scope: ExtractedFact['scope'] = o.scope === 'project' ? 'project' : 'global'
    out.push({ key, value, scope })
  }
  return out
}

/**
 * 这次 remember 调用**成功**了吗。
 *
 * 自动提取的短路条件是「模型已经自己记上了」，而不是「模型试过」——
 * 失败的调用不能算。实测撞到过：remember 工具因为某种原因不可用，
 * 模型调了、拿到 `{"error":"unknown tool: remember"}`，而短路照样触发，
 * 于是抽取也被跳过 —— **两条路都没记上**，那条事实彻底丢了。
 *
 * runTool 把工具异常包成 `{"error": ...}` 返回（见 src/tools/index.ts），
 * 所以判据是「输出里有没有 error 字段」。解析失败时当成功：那说明输出
 * 不是我们那套错误信封，更可能是工具正常返回的什么东西。
 */
export function rememberSucceeded(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as unknown
    if (parsed && typeof parsed === 'object' && 'error' in parsed) return false
  } catch {
    // 不是 JSON —— 不是错误信封，当成功
  }
  return true
}

/**
 * 把抽出来的 scope 翻译成真实作用域。
 *
 * 要 project 但当前会话没有工作目录时降级到 global —— 和 remember 工具里
 * 同一个决定：作用域偏大好过直接丢掉这条事实。
 */
export function resolveScope(
  scope: ExtractedFact['scope'],
  projectScope: FactScope | null,
): FactScope {
  return scope === 'project' && projectScope ? projectScope : 'global'
}
