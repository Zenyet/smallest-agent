// ============================================================================
// cli.ts —— 项目主入口（pnpm dev "你的问题"）
// ----------------------------------------------------------------------------
// 把所有模块「装配」成一个完整 agent 并运行一次。
// 整体分三段：
//   【装配阶段】加载配置 → 构建 RAG 索引 → 连接 MCP → 拼工具注册表
//              → 给 callModel 套上 withRetry / withFallback / withCache
//              → 准备记忆/压缩/流式回调
//   【核心】    runAgent：真正跑 ReAct 循环
//   【收尾】    打印/流式换行 → verifier 核查答案是否有证据支撑 → mcp.close
// 这种「装配 → 运行 → 收尾」的分层让每个子模块独立可测，cli 只负责把它们粘起来。
// ============================================================================

import 'dotenv/config'
import { loadConfig } from './src/config'
import type { Message, CallModel } from './src/types'
import { makeSearchNotesTool } from './src/tools/searchNotes'
import { makeEmbedder } from './src/rag/embed'
import { buildNotesIndex } from './src/rag/index'
import { makeCallModel } from './src/llm'
import { withRetry, withFallback } from './src/resilience'
import { createDiskCache, withCache } from './src/cache'
import { runAgent, type TurnInfo } from './src/agent'
import { printTurn } from './src/trace'
import { createJsonSessionStore } from './src/memory/store'
import { makeSummarizer } from './src/memory/summarize'
import { compactMessages } from './src/memory/compact'
import { loadMcpToolsFromServers } from './src/mcp/client'
import { makeVerifier } from './src/verify'
import { makeRememberTool } from './src/tools/remember'
import { makeRecallTool } from './src/tools/recall'
import { makeForgetTool } from './src/tools/forget'
import { makeExtractor, rememberSucceeded, resolveScope } from './src/memory/extract'
import { getFacts, rememberFact, forgetFactByKey } from './src/memory/facts-store'
import { factsFor, renderFacts, scopeFor } from './src/memory/facts'

async function main() {
  const question = process.argv.slice(2).join(' ').trim()
  if (!question) {
    console.error('用法: pnpm dev "你的问题"')
    process.exit(1)
  }

  // ============================================================
  // 【装配阶段】把所有组件初始化并组合成 runAgent 需要的依赖
  // ============================================================

  const config = loadConfig()

  // --- RAG：构建向量索引 ---
  // makeEmbedder 是耗时操作（可能下载模型），buildNotesIndex 把 notesDir 下所有
  // .md 文件切块并向量化，结果存在内存 store 里供 searchNotes 工具检索。
  console.error('加载 embedding 模型并构建笔记索引…')
  const embed = await makeEmbedder(config)
  const store = await buildNotesIndex({ notesDir: config.notesDir, embed })
  console.error(`索引完成：${store.size} 个片段`)

  // --- MCP：动态发现外部工具 ---
  // loadMcpToolsFromServers 启动两个子进程（自定义 mcp-server + 官方 filesystem server），
  // 通过 MCP 协议 list_tools 发现它们暴露的工具，返回的 mcp.tools 已是 ToolRegistry 格式。
  // MCP_FS_DIR 决定 filesystem server 能访问哪个目录，默认指向 notes 目录。
  console.error('连接 MCP server，发现工具…')
  const fsDir = process.env.MCP_FS_DIR ?? './notes'
  const mcp = await loadMcpToolsFromServers([
    { command: 'npx', args: ['tsx', 'mcp-server.ts'] },
    { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', fsDir] },
  ])
  try {
    const mcpTools = mcp.tools
    console.error(`MCP 工具：${Object.keys(mcpTools).join(', ')}`)
    // 把本地 RAG 搜索工具和 MCP 工具合并成统一注册表。
    // 展开顺序：mcpTools 在前，searchTool 在后，同名时 searchTool 覆盖（通常不会冲突）。
    const searchTool = makeSearchNotesTool({ store, embed })

    // 注入跨会话事实记忆到系统提示。
    //
    // CLI 的「项目」就是它被调用时所在的目录 —— 在 ~/lab/x 里跑 pnpm dev，
    // 记下的项目事实就属于 ~/lab/x。原来这里硬编码成 undefined（等于没有
    // 项目作用域），于是模型选 scope:"project" 时会撞上「没有工作目录」。
    const projectScope = scopeFor(process.cwd())

    // 记忆工具：remember 写入事实，recall 读取事实
    const rememberTool = makeRememberTool({
      persist: (input) => rememberFact(input),
      sessionId: config.sessionId,
      projectScope,
    })
    const recallTool = makeRecallTool({
      getAllFacts: () => getFacts(),
      projectScope,
    })
    const forgetTool = makeForgetTool({
      forget: (key, scope) => {
        forgetFactByKey(key, scope)
      },
      getAllFacts: () => getFacts(),
      projectScope,
    })

    const registry = {
      ...mcpTools,
      [searchTool.name]: searchTool,
      [rememberTool.name]: rememberTool,
      [recallTool.name]: recallTool,
      [forgetTool.name]: forgetTool,
    }

    // --- 流式输出回调 ---
    // onText 在模型生成每个 token 时触发，直接写到 stdout。
    // streamed 标志位用于收尾时判断「是否需要补一个换行」——避免提示符和答案粘连。
    // 降延迟：流式打印（缓存命中时不会触发，base 不被调用）
    let streamed = false
    const onText = (delta: string) => {
      streamed = true
      process.stdout.write(delta)
    }

    // --- callModel 的多层装饰（限流降级 + 缓存）---
    // 用高阶函数逐层包装，每层只关心自己的关注点：
    //   withRetry   → 网络抖动时自动重试（最多 maxRetries 次）
    //   withCache   → 对相同 messages 命中磁盘缓存，省 token、省延迟
    //   withFallback → 主模型连续失败后自动切换 fallbackModel
    // buildCallModel 封装成工厂，主/备模型各调一次，避免重复。
    // 限流降级 + 缓存（每个模型各自缓存）
    const cache = config.cacheEnabled ? createDiskCache(config.cacheDir) : undefined
    const buildCallModel = (model: string): CallModel => {
      let cm: CallModel = withRetry(
        makeCallModel({ ...config, model }, registry, config.stream ? onText : undefined),
        { retries: config.maxRetries },
      )
      if (cache) cm = withCache(cm, cache, model, () => console.error('🟢 LLM 缓存命中（省 token）'))
      return cm
    }
    const primary = buildCallModel(config.model)
    // 主备模型相同时直接复用，不必再套一层 withFallback（减少不必要的 try/catch 开销）。
    const callModel: CallModel =
      config.fallbackModel === config.model
        ? primary
        : withFallback(primary, buildCallModel(config.fallbackModel), (err) =>
            console.error(
              `主模型失败，降级到 ${config.fallbackModel}：${err instanceof Error ? err.message : err}`,
            ),
          )

    // --- 记忆 + 压缩（Stage 2）---
    // sessions 持久化每次对话（按 sessionId 存 JSON 文件）。
    // compact 在开局前把过长的历史压缩成摘要，避免 context 窗口溢出。
    // onComplete 在 runAgent 返回后把本次完整对话（去掉 system 消息）存回文件。
    // 记忆 + 压缩
    const sessions = createJsonSessionStore(config.sessionsDir)
    const history = await sessions.load(config.sessionId)
    if (history.length) console.error(`已载入会话「${config.sessionId}」的 ${history.length} 条历史`)
    const summarize = makeSummarizer(makeCallModel(config, {}))

    const allFacts = getFacts()
    const relevantFacts = factsFor(allFacts, projectScope)
    const factsBudget = 600 // 给事实分配最多600 token
    const factsPrompt = renderFacts(relevantFacts, factsBudget)

    // 把事实追加到系统提示末尾
    const configWithFacts = {
      ...config,
      systemPrompt: factsPrompt ? `${config.systemPrompt}\n\n${factsPrompt}` : config.systemPrompt,
    }

    const compact = (messages: Message[]) =>
      compactMessages(messages, {
        maxTokens: config.maxContextTokens,
        keepRecent: config.keepRecent,
        summarize,
      })
    const onComplete = async (messages: Message[]) => {
      // 过滤掉 system 消息再存储：system prompt 由 config 决定，不需要进历史文件
      await sessions.save(config.sessionId, messages.filter((m) => m.role !== 'system'))
    }

    // --- onTurn 回调：trace 打印 + 证据收集 ---
    // evidence 数组在 runAgent 执行期间不断累积，最终交给 verifier 核查。
    // 流式模式下最终答案已逐字打出，trace 只打印有工具活动的轮次，避免重复输出。
    // 降幻觉：累积工具证据；流式时不在 trace 里重复打印答案文本
    const evidence: string[] = []
    /** 这一轮用过哪些工具。自动提取靠它短路（调过 remember 就不必再抽）。 */
    const toolsUsed = new Set<string>()
    const onTurn = (info: TurnInfo) => {
      // 流式时只打印有工具活动的轮次；最终答案轮已逐字流出，不再打印空的 trace 头
      if (!config.stream || info.toolResults.length > 0) printTurn(info, { showText: !config.stream })
      for (const tr of info.toolResults) {
        evidence.push(`${tr.name}: ${tr.output}`)
        // 只记**成功**的调用：失败的 remember 不该触发抽取的短路
        // （见 src/memory/extract.ts 的 rememberSucceeded）
        if (tr.name !== 'remember' || rememberSucceeded(tr.output)) toolsUsed.add(tr.name)
      }
    }

    // ============================================================
    // 【核心】runAgent：启动 ReAct 循环，把问题交给 agent 跑到底
    // ============================================================

    if (config.stream) console.error('（流式输出，最终答案逐字出现）')
    const answer = await runAgent(question, {
      callModel,
      tools: registry,
      config: configWithFacts,
      onTurn,
      history,
      compact,
      onComplete,
    })

    // ============================================================
    // 【收尾】打印答案（非流式）→ verifier 核查 → 关闭 MCP 连接
    // ============================================================

    // 流式模式下答案已逐字写到 stdout，只需补换行。
    // 非流式模式下 runAgent 同步返回完整文本，在这里打印。
    if (streamed) process.stdout.write('\n')
    else {
      console.log('\n=== 最终回答 ===')
      console.log(answer)
    }

    // verifier 是另一个 LLM-as-Judge 调用，专门检查「答案里有没有不被证据支撑的说法」。
    // 只在 agent 实际调用过工具（有证据）时才核查，纯聊天类问题无需核查。
    // 降幻觉：LLM-as-Judge 核查答案是否被证据支撑
    // 自动提取事实。放在核查之后 —— 核查的结论要打给用户看，提取只是写盘。
    //
    // 三道短路和 Electron 侧一致（见 electron/main/agent-runner.ts）：
    // 功能关了、模型已经自己调过 remember、用户这句话太短。
    if (
      config.autoExtractFacts !== false &&
      !toolsUsed.has('remember') &&
      question.trim().length >= 12
    ) {
      try {
        const found = await makeExtractor(makeCallModel(config, {}))({
          userMessage: question,
          answer,
          existing: getFacts(),
        })
        for (const f of found) {
          rememberFact({
            key: f.key,
            value: f.value,
            scope: resolveScope(f.scope, projectScope),
            sessionId: config.sessionId,
          })
        }
        if (found.length > 0) {
          console.error(`\n🧠 自动记下 ${found.length} 条：`)
          for (const f of found) console.error(`  - ${f.value}`)
        }
      } catch {
        // 静默 —— 提取是增强，坏掉不该影响这一轮
      }
    }

    if (evidence.length > 0) {
      const verdict = await makeVerifier(makeCallModel(config, {}))({ question, answer, evidence })
      if (verdict.grounded) {
        console.error('\n✅ 核查：答案被证据支撑')
      } else {
        console.error('\n⚠️ 核查：答案可能有未被证据支撑的说法：')
        for (const issue of verdict.issues) console.error(`  - ${issue}`)
      }
    }
  } finally {
    // 无论成功还是异常，都要关闭 MCP 子进程；否则进程会挂着不退出。
    await mcp.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
