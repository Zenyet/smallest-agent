// ============================================================================
// verify.ts —— LLM-as-Judge：用另一个 LLM 判断答案有没有被证据支撑
// ----------------------------------------------------------------------------
// Stage 4b「降幻觉」的核心。agent 跑完一轮后，把「问题 + 工具返回的证据 +
// 模型最终答案」打包发给一个专职「裁判 LLM」，让它严格判断答案是否有据可查，
// 而不是靠模型自己声称「我有根据」。
//
// 关键设计：
//   • makeVerifier 接受 callModel（可以是另一个模型，也可以是同一个），
//     与 agent 循环解耦——你可以用便宜的小模型做裁判，省 token。
//   • parseVerdict 解析失败时保守地判为「未支撑」（grounded: false），
//     宁可误报也不放过幻觉。
//   • 证据严格来自工具/检索的实际返回，不允许裁判 LLM 用自己的知识补充。
// ============================================================================

import type { CallModel } from './types'

// 裁判的最终结论：grounded 表示「答案被证据支撑」，issues 列出未被支撑的具体说法。
export interface Verdict {
  grounded: boolean
  issues: string[]
}

// 从裁判 LLM 的文本输出中提取 JSON 结论。
// 裁判被要求只输出一个 JSON 对象，但模型偶尔会加前缀说明文字，
// 所以用贪婪正则 /\{[\s\S]*\}/ 提取最外层 {}，而不是直接 JSON.parse(text)。
export function parseVerdict(text: string): Verdict {
  try {
    // 贪婪匹配取最外层 {...}；裁判按要求只输出一个 JSON，故够用，
    // 解析失败时下面会安全地回退为「未支撑」。
    const m = text.match(/\{[\s\S]*\}/)
    const obj = JSON.parse(m ? m[0] : text) as { grounded?: unknown; issues?: unknown }
    return {
      grounded: Boolean(obj.grounded),
      // issues 可能是 string[]，也可能裁判误输出了对象，统一转成字符串。
      issues: Array.isArray(obj.issues)
        ? obj.issues.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
        : [],
    }
  } catch {
    // 任何解析错误都保守地判为「未支撑」，并标明原因。
    // 宁可让用户知道「验证失败了」，也不假装通过——这是设计上的「保守偏置」。
    return { grounded: false, issues: ['无法解析裁判输出'] }
  }
}

// 裁判接收的输入：原始问题、agent 最终答案、以及工具/检索实际返回的证据列表。
export interface VerifyInput {
  question: string
  answer: string
  evidence: string[]  // 每条是一次工具调用的原始返回，多条用 '---' 分隔
}

// 工厂函数：给定一个 callModel，返回一个「验证器」函数。
// 验证器把三者组装成裁判 prompt，调用模型，再解析 Verdict。
// 用工厂而不是直接导出函数，是为了让 callModel 可注入（测试 / 换模型）。
export function makeVerifier(callModel: CallModel): (input: VerifyInput) => Promise<Verdict> {
  return async ({ question, answer, evidence }) => {
    const prompt =
      `问题：${question}\n\n` +
      `证据（工具/检索返回，只能依据这些）：\n${evidence.join('\n---\n')}\n\n` +
      `待核查答案：\n${answer}\n\n` +
      `判断答案是否被上述证据支撑。只输出 JSON：{"grounded": true 或 false, "issues": ["未被证据支撑的说法", ...]}`
    const result = await callModel([
      {
        role: 'system',
        // system prompt 明确禁止裁判用自己的知识——这是防止裁判本身产生幻觉的关键约束。
        content: '你是严格的事实核查裁判。只依据给定证据判断，不要用自己的知识补充。只输出 JSON。',
      },
      { role: 'user', content: prompt },
    ])
    return parseVerdict(result.text)
  }
}
