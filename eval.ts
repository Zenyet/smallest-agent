// ============================================================================
// eval.ts —— 评估入口（pnpm eval）
// ----------------------------------------------------------------------------
// 搭建「评估专用运行时」，对 cases.ts 里的每个用例真跑 agent，
// 用 runEvalSuite + LLM-as-Judge 打分，最后输出成绩单并写 eval-results.json。
//
// 与 cli.ts 的关键差异：
//   - 不套 withRetry / withFallback / withCache——要测的是 agent 的真实能力，
//     缓存会让相同输入永远命中旧结果，破坏复现性。
//   - temperature=0——让每次跑的分数可对比（确定性输出）。
//   - 不做流式输出——eval 需要拿到完整 answer 后再打分，无法流式。
//   - 结果写入 eval-results.json，可作为 RL / 微调的种子数据积累。
// ============================================================================

import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import { loadConfig } from './src/config'
import { makeSearchNotesTool } from './src/tools/searchNotes'
import { makeEmbedder } from './src/rag/embed'
import { buildNotesIndex } from './src/rag/index'
import { makeCallModel } from './src/llm'
import { runAgent, type TurnInfo } from './src/agent'
import { loadMcpToolsFromServers } from './src/mcp/client'
import { runEvalSuite, type RunCase } from './src/eval/harness'
import { makeJudge } from './src/eval/scorers'
import { cases } from './evals/cases'

async function main() {
  const config = loadConfig()

  // --- 评估运行时：embedding + MCP（和 cli.ts 相同的基础设施）---
  // eval 里同样需要 RAG 和 MCP，因为用例本身会触发 search_notes / get_weather 等工具。
  console.error('构建 eval 运行时（embedding + MCP）…')
  const embed = await makeEmbedder(config)
  const store = await buildNotesIndex({ notesDir: config.notesDir, embed })
  const fsDir = process.env.MCP_FS_DIR ?? './notes'
  const mcp = await loadMcpToolsFromServers([
    { command: 'npx', args: ['tsx', 'mcp-server.ts'] },
    { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', fsDir] },
  ])
  try {
    const searchTool = makeSearchNotesTool({ store, embed })
    const registry = { ...mcp.tools, [searchTool.name]: searchTool }

    // temperature=0：让每次评估的模型输出确定性更高，分数可纵向对比
    // 不套缓存/重试/降级：真实跑，避免缓存掩盖回归；失败就失败，让数据说话
    // eval：每个用例真跑——用不带缓存/不流式、且 temperature=0 的 callModel，让分数可复现可对比
    const evalConfig = { ...config, temperature: 0 }
    const callModel = makeCallModel(evalConfig, registry)
    // judge 也用 temperature=0、不带工具（评分不需要检索）的独立 callModel，
    // 与被评估的 agent callModel 隔离，避免工具调用干扰裁判输出。
    const judge = makeJudge(makeCallModel(evalConfig, {}))

    // runCase 是 RunCase 类型（注入给 harness），内部包装了真实的 runAgent 调用，
    // 同时用 onTurn 收集 toolsUsed + evidence 供打分器使用。
    const runCase: RunCase = async (input) => {
      const toolsUsed: string[] = []
      const evidence: string[] = []
      const onTurn = (info: TurnInfo) => {
        // 从每轮的 toolCalls 收集工具名（用于 checkToolUsed 打分器）
        for (const call of info.result.toolCalls) toolsUsed.push(call.name)
        // 从每轮的 toolResults 收集原始输出（用于 LLM-as-Judge 的 evidence 字段）
        for (const tr of info.toolResults) evidence.push(`${tr.name}: ${tr.output}`)
      }
      const answer = await runAgent(input, { callModel, tools: registry, config, onTurn })
      return { answer, toolsUsed, evidence }
    }

    console.error(`跑 ${cases.length} 个用例…\n`)
    const report = await runEvalSuite(cases, runCase, judge)

    // 打印成绩单：每个用例一行总结，下面缩进列出各 check 的细节。
    for (const r of report.results) {
      console.log(`${r.pass ? '✅' : '❌'} ${r.name}`)
      for (const ch of r.checks) {
        console.log(`   ${ch.pass ? '·' : '✗'} ${ch.name}${ch.detail ? '：' + ch.detail : ''}`)
      }
    }
    console.log(`\n通过 ${report.passed}/${report.total}（${Math.round(report.passRate * 100)}%）`)

    // 写 eval-results.json：完整报告，包含每个用例的答案、check 细节和通过状态。
    // 可作为「会增值的测试集」持久化——随时间积累后可用作 RL / SFT 微调的种子数据。
    await writeFile('eval-results.json', JSON.stringify(report, null, 2), 'utf8')
    console.error('\n结果已写入 eval-results.json（可作 RL/微调的种子数据）')
  } finally {
    await mcp.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
