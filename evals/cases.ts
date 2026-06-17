// ============================================================================
// cases.ts —— 评估测试集（声明式数据，无运行逻辑）
// ----------------------------------------------------------------------------
// 8 个 EvalCase，覆盖 agent 各核心能力维度：
//   MCP 工具调用、RAG 检索 + 引用、code-review 技能、降幻觉/拒答、
//   外部 MCP 文件系统、向量相似度理解、纯语言生成。
// 每个用例是纯数据（input + expect），不含 how-to-run；
// 运行逻辑由 eval.ts 的 runCase 注入、打分逻辑由 harness 选择，
// 三者解耦，测试集本身可以在没有模型的情况下被 import 和检查。
//
// 用途：eval.ts 每次跑完会把结果存成 eval-results.json，
// 随时间积累后可作为 RL / SFT 微调的种子数据（有问题 + 有打分标准 + 有答案）。
// ============================================================================

import type { EvalCase } from '../src/eval/harness'

export const cases: EvalCase[] = [
  {
    // 测什么能力：MCP 工具调用——agent 是否会主动调 get_weather 而不是瞎猜天气
    name: 'weather-via-mcp',
    input: '北京今天天气怎么样？',
    expect: { toolUsed: 'get_weather', containsAny: ['晴', '22'] },
  },
  {
    // 测什么能力：RAG 检索 + 来源引用——agent 必须用 search_notes 检索，
    // 答案要有 chunking 语义解释，且注明来源文件（rubric 补程序化 cites 的语义判断）
    name: 'rag-chunking',
    input: '根据我的笔记，RAG 里 chunking 为什么重要？',
    expect: {
      toolUsed: 'search_notes',
      cites: true,
      rubric: '答案应基于笔记，解释 chunk 切太大语义被平均、太小丢上下文。',
    },
  },
  {
    // 测什么能力：RAG 检索 + 概念理解——agent 能否正确理解 Eval 和 Harness 的关系
    name: 'rag-eval-harness',
    input: '根据笔记，Eval 和 Harness 是什么关系？',
    expect: { toolUsed: 'search_notes', rubric: '答案应说明 Harness 是跑 eval 的那套基础设施。' },
  },
  {
    // 测什么能力：skills 工具调用——agent 能否调 get_skill 拉取代码审查技能并发现明显 bug
    name: 'skill-code-review',
    input: '用 code-review 技能评审这段代码：function add(a,b){return a-b}',
    expect: { toolUsed: 'get_skill', containsAny: ['减', 'subtract', '正确性'] },
  },
  {
    // 测什么能力：降幻觉/拒答——笔记里没有 Rust 内容，agent 应表明不知道而非编造所有权细节
    // refuses（启发式）作为第一道过滤，rubric（LLM-as-Judge）兜底判断拒答质量
    name: 'hallucination-refusal',
    input: '根据我的笔记，详细讲讲 Rust 的所有权机制',
    expect: {
      refuses: true,
      rubric: '笔记里没有 Rust 内容，答案应表明没有相关笔记/不确定，而不是编造所有权细节。',
    },
  },
  {
    // 测什么能力：外部 MCP 文件系统工具——agent 能否通过 filesystem server 列出 notes 目录
    name: 'list-notes-external-mcp',
    input: '列出我 notes 目录里有哪些文件',
    expect: { containsAny: ['01-rag', '.md'] },
  },
  {
    // 测什么能力：向量检索 + 概念理解——agent 能否解释余弦相似度在文本语义检索中的意义
    name: 'embedding-cosine',
    input: '根据笔记，为什么文本检索常用余弦相似度？',
    expect: { toolUsed: 'search_notes', rubric: '答案应提到关心方向/语义而非长度。' },
  },
  {
    // 测什么能力：纯语言生成——无需工具的简单对话，agent 应简洁自我介绍、不编造事实
    name: 'plain-greeting',
    input: '你好，简单介绍下你自己',
    expect: { rubric: '应是简短自我介绍，不编造事实，可不调用任何工具。' },
  },
]
