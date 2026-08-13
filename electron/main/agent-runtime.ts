// App 级装配：把「贵」的资源建好长驻。
// cli.ts 是「装配 → 跑一次 → 退出」，桌面端长驻，所以装配线要拆两段：
//   这里（启动一次）：embedding 模型、笔记索引、MCP 子进程
//   agent-runner（每条消息一次）：callModel 装饰链 —— 因为流式回调要绑当前 sessionId
import { makeEmbedder as realMakeEmbedder } from '../../src/rag/embed'
import { buildNotesIndex as realBuildNotesIndex } from '../../src/rag/index'
import { makeSearchNotesTool as realMakeSearchNotesTool } from '../../src/tools/searchNotes'
import { loadMcpToolsFromServers as realLoadMcpToolsFromServers } from '../../src/mcp/client'
import { connectMcpWithEnv } from './mcp-connect'
import type { McpServerSpec } from './mcp-paths'
import type { RuntimeStatusEvent } from '../shared/channels'
import type { Config, ToolRegistry } from '../../src/types'

export interface AgentRuntime {
  registry: ToolRegistry
  fsToolsAvailable: boolean
  close(): Promise<void>
}

// 全部做成可注入的：测试里塞假实现，就不用真的下载模型 / 起子进程。
export interface RuntimeDeps {
  makeEmbedder: typeof realMakeEmbedder
  buildNotesIndex: typeof realBuildNotesIndex
  makeSearchNotesTool: typeof realMakeSearchNotesTool
  loadMcpToolsFromServers: typeof realLoadMcpToolsFromServers
}

const defaultDeps: RuntimeDeps = {
  makeEmbedder: realMakeEmbedder,
  buildNotesIndex: realBuildNotesIndex,
  makeSearchNotesTool: realMakeSearchNotesTool,
  loadMcpToolsFromServers: realLoadMcpToolsFromServers,
}

export async function createRuntime(
  config: Config,
  specs: { own: McpServerSpec; fs: McpServerSpec },
  onStatus: (event: RuntimeStatusEvent) => void,
  deps: Partial<RuntimeDeps> = {},
): Promise<AgentRuntime> {
  const d = { ...defaultDeps, ...deps }
  const closers: (() => Promise<void>)[] = []

  try {
    onStatus({ phase: 'embedding', detail: '正在加载 embedding 模型…' })
    const embed = await d.makeEmbedder(config)

    onStatus({ phase: 'indexing', detail: '正在索引笔记…' })
    const store = await d.buildNotesIndex({ notesDir: config.notesDir, embed })

    onStatus({ phase: 'mcp', detail: '正在连接 MCP 工具…' })
    // 自建 server 是必需的（get_weather + Skills 都在里面），失败即致命
    const own = await d.loadMcpToolsFromServers([specs.own], connectMcpWithEnv)
    closers.push(own.close)

    // fs server 依赖 npx 联网拉包，打包环境不可靠 —— 失败就跳过，不阻塞启动
    let fsTools: ToolRegistry = {}
    let fsToolsAvailable = false
    try {
      const fs = await d.loadMcpToolsFromServers([specs.fs], connectMcpWithEnv)
      closers.push(fs.close)
      fsTools = fs.tools
      fsToolsAvailable = true
    } catch {
      fsToolsAvailable = false
    }

    const searchTool = d.makeSearchNotesTool({ store, embed })
    const registry: ToolRegistry = {
      ...own.tools,
      ...fsTools,
      [searchTool.name]: searchTool,
    }

    onStatus({ phase: 'ready', detail: `就绪（${Object.keys(registry).length} 个工具）` })

    return {
      registry,
      fsToolsAvailable,
      close: async () => {
        for (const close of closers) await close().catch(() => {})
      },
    }
  } catch (err) {
    // 已经建好的连接要关掉，否则子进程会挂着不退出
    for (const close of closers) await close().catch(() => {})
    onStatus({
      phase: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
