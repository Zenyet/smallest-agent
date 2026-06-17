// ============================================================================
// scorers.ts —— 评估打分器：程序化检查 + LLM-as-Judge
// ----------------------------------------------------------------------------
// Stage 5 的评估基础设施。对 agent 的一次回答，它决定「通过 / 不通过」。
// 分两层：
//   1. 程序化打分器（checkXxx）：快、确定性、零额外 token，适合明确可判的维度。
//   2. LLM-as-Judge（makeJudge + parseJudge）：用模型对照 rubric 打分，处理
//      「语义是否合理」等难以枚举的主观判断。两层互补；rubric 用例里 checkRefuses
//      已经过滤一轮，LLM-as-Judge 再做兜底，避免纯程序化的误判。
// ============================================================================

import type { CallModel } from '../types'

// 单次检查的结果，name 对应打分器标识，方便在报告里区分是哪一条失败的。
export interface CheckResult {
  name: string
  pass: boolean
  detail?: string
}

// 程序化检查：答案里是否出现了关键字列表中的任何一个。
// 适用于「答案必须包含具体数值/词汇」的确定性预期（如天气数字、城市名）。
export function checkContainsAny(answer: string, keywords: string[]): CheckResult {
  const hit = keywords.find((k) => answer.includes(k))
  return {
    name: 'containsAny',
    pass: Boolean(hit),
    detail: hit ? `命中「${hit}」` : `缺少 ${keywords.join('/')}`,
  }
}

// 程序化检查：agent 是否实际调用了指定工具。
// toolsUsed 由 harness 的 onTurn 回调从 TurnInfo 收集，能反映真实的工具调用序列。
export function checkToolUsed(toolsUsed: string[], expected: string): CheckResult {
  return {
    name: 'toolUsed',
    pass: toolsUsed.includes(expected),
    detail: `期望 ${expected}，实际用到 [${toolsUsed.join(', ')}]`,
  }
}

// 程序化检查：答案里是否注明了来源（"来源：" 前缀或 .md 文件名）。
// RAG 用例要求 agent 在回答里标出检索来源，否则很难排查「引用了哪个片段」。
export function checkCites(answer: string): CheckResult {
  const cited = /来源[:：]/.test(answer) || /[\w-]+\.md/.test(answer)
  return { name: 'cites', pass: cited, detail: cited ? '已注明来源' : '未注明来源' }
}

// 程序化检查：答案是否正确拒答（「不知道 / 笔记里没有」类措辞）。
// 这是「降幻觉」用例的第一道防线。
// 注意：这是宽松启发式——只匹配几种典型拒答措辞，刻意不枚举所有可能，
// 防止漏匹配把「编造答案里偶然出现的否定词」当成拒答。
// eval 里 rubric 的 LLM-as-Judge 作为兜底，对拒答质量做语义层判断。
export function checkRefuses(answer: string): CheckResult {
  // 宽松启发式：要求「缺信息」措辞，避免把编造答案里偶然出现的「没有」当成拒答。
  // eval 里这条由 rubric 的 LLM-as-Judge 兜底。
  const refused =
    /不确定|无法(回答|提供|找到|确定)|笔记(里|中)?(没有|未|不包含)|(没有|未|找不到|查不到|不包含)[^。！？\n]{0,8}(相关|记录|内容|笔记|信息|资料|提及|描述)/.test(
      answer,
    )
  return { name: 'refuses', pass: refused, detail: refused ? '正确拒答' : '可能编造' }
}

// makeJudge 的输入：问题、答案、工具检索返回的原始证据、以及评分标准（rubric）。
// evidence 至关重要——裁判模型必须只依据可查证的证据评分，而非自身知识，否则失去意义。
export interface JudgeInput {
  question: string
  answer: string
  evidence: string[]
  rubric: string
}
// JudgeFn 是 makeJudge 返回的函数类型，harness 通过依赖注入拿到它，方便单测替换假裁判。
export type JudgeFn = (input: JudgeInput) => Promise<{ pass: boolean; reason: string }>

// 从裁判模型的原始文本输出中解析 JSON 结果。
// 模型有时会在 JSON 前后夹杂解释文字，所以先用正则找到第一个 {...}，再解析。
// 若解析失败，保守地返回 pass=false，避免「静默通过」。
export function parseJudge(text: string): { pass: boolean; reason: string } {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    const obj = JSON.parse(m ? m[0] : text) as { pass?: unknown; reason?: unknown }
    return { pass: Boolean(obj.pass), reason: String(obj.reason ?? '') }
  } catch {
    return { pass: false, reason: '无法解析裁判输出' }
  }
}

// 工厂函数：接收 callModel（依赖注入），返回一个 JudgeFn。
// 分离「创建裁判」和「调用裁判」两步，让 eval.ts 可以用 temperature=0 的 callModel
// 构造确定性裁判，同时保持裁判逻辑自身的可测试性。
// 提示词明确要求「只依据评分标准与证据」，禁止裁判模型使用自身先验知识打分。
export function makeJudge(callModel: CallModel): JudgeFn {
  return async ({ question, answer, evidence, rubric }) => {
    const prompt =
      `评分标准：${rubric}\n\n` +
      `问题：${question}\n\n` +
      `证据（工具/检索返回）：\n${evidence.join('\n---\n') || '（无）'}\n\n` +
      `答案：\n${answer}\n\n` +
      `按评分标准判断答案是否合格。只输出 JSON：{"pass": true 或 false, "reason": "简短理由"}`
    const result = await callModel([
      { role: 'system', content: '你是严格的评测裁判。只依据评分标准与证据判断，只输出 JSON。' },
      { role: 'user', content: prompt },
    ])
    return parseJudge(result.text)
  }
}
