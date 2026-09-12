// 基础聊天立即就绪。笔记检索首次使用时加载；扩展工具在后台连接。
import type { makeEmbedder } from '../../src/rag/embed'
import { buildNotesIndex as realBuildNotesIndex } from '../../src/rag/index'
import { makeSearchNotesTool as realMakeSearchNotesTool } from '../../src/tools/searchNotes'
import { loadMcpToolsFromServers as realLoadMcpToolsFromServers } from '../../src/mcp/client'
import { makeWebSearchTool as realMakeWebSearchTool, makeFetchUrlTool as realMakeFetchUrlTool, type WebSearchKeys } from '../../src/tools/web'
import { z } from 'zod'
import { connectMcpWithEnv } from './mcp-connect'
import type { McpServerSpec } from './mcp-paths'
import type { RuntimeStatusEvent, RuntimeCapability } from '../shared/channels'
import type { Config, Tool, ToolRegistry } from '../../src/types'

export interface AgentRuntime {
  registry: ToolRegistry
  close(): Promise<void>
}

export interface RuntimeDeps {
  makeEmbedder: typeof makeEmbedder
  buildNotesIndex: typeof realBuildNotesIndex
  makeSearchNotesTool: typeof realMakeSearchNotesTool
  loadMcpToolsFromServers: typeof realLoadMcpToolsFromServers
  makeWebSearchTool: typeof realMakeWebSearchTool
  makeFetchUrlTool: typeof realMakeFetchUrlTool
}

const defaultDeps: RuntimeDeps = {
  // transformers 的模块也延迟加载，避免聊天启动依赖本地推理运行时。
  makeEmbedder: async (config) => (await import('../../src/rag/embed')).makeEmbedder(config),
  buildNotesIndex: realBuildNotesIndex,
  makeSearchNotesTool: realMakeSearchNotesTool,
  loadMcpToolsFromServers: realLoadMcpToolsFromServers,
  makeWebSearchTool: realMakeWebSearchTool,
  makeFetchUrlTool: realMakeFetchUrlTool,
}

export async function createRuntime(
  config: Config,
  specs: { own: McpServerSpec },
  onStatus: (event: RuntimeStatusEvent) => void,
  deps: Partial<RuntimeDeps> = {},
  searchKeys: () => WebSearchKeys = () => ({}),
): Promise<AgentRuntime> {
  const d = { ...defaultDeps, ...deps }
  let closed = false
  let closeOwn: (() => Promise<void>) | undefined
  let notes: Promise<Tool> | undefined
  const capabilities: RuntimeCapability[] = [
    { id: 'notes', label: '笔记检索', state: 'idle', detail: '首次使用时加载' },
    { id: 'skills', label: '扩展工具', state: 'loading', detail: '正在连接' },
  ]
  const publish = () => {
    if (!closed) onStatus({ phase: 'ready', detail: '可以开始对话', capabilities: capabilities.map((c) => ({ ...c })) })
  }
  const update = (id: RuntimeCapability['id'], state: RuntimeCapability['state'], detail: string) => {
    Object.assign(capabilities.find((c) => c.id === id)!, { state, detail })
    publish()
  }
  const ensureNotes = (): Promise<Tool> => {
    if (closed) return Promise.reject(new Error('应用正在退出'))
    if (notes) return notes
    update('notes', 'loading', '正在加载检索模型；其他对话仍可使用')
    notes = (async () => {
      const embed = await d.makeEmbedder(config)
      if (closed) throw new Error('应用正在退出')
      update('notes', 'loading', '正在索引笔记')
      const store = await d.buildNotesIndex({ notesDir: config.notesDir, embed })
      if (closed) throw new Error('应用正在退出')
      const tool = d.makeSearchNotesTool({ store, embed })
      update('notes', 'ready', '已就绪')
      return tool
    })().catch((err: unknown) => {
      notes = undefined // 下次使用可以重试，不缓存一次临时失败。
      const reason = err instanceof Error ? err.message : String(err)
      update('notes', 'failed', `暂不可用：${reason}`)
      throw new Error(`笔记检索暂不可用：${reason}。请检查检索设置，其他工具仍可使用。`)
    })
    return notes
  }
  const search: Tool = {
    name: 'search_notes',
    description: '在用户的笔记库里做语义检索。首次使用时加载本地检索模型。',
    parameters: z.object({ query: z.string(), k: z.number().int().positive().optional() }),
    run: async (args) => (await ensureNotes()).run(args),
  }
  const web = d.makeWebSearchTool(searchKeys)
  const fetch = d.makeFetchUrlTool()
  const registry: ToolRegistry = { [search.name]: search, [web.name]: web, [fetch.name]: fetch }
  publish()

  // 不 await：连接失败只影响扩展能力。退出后才完成的连接也必须关闭。
  void d.loadMcpToolsFromServers([specs.own], connectMcpWithEnv).then(async (own) => {
    if (closed) {
      await own.close().catch(() => {})
      return
    }
    closeOwn = own.close
    for (const [name, tool] of Object.entries(own.tools)) {
      if (!(name in registry)) registry[name] = tool
    }
    update('skills', 'ready', '已就绪')
  }).catch((err: unknown) => {
    update('skills', 'failed', `暂不可用：${err instanceof Error ? err.message : String(err)}`)
  })

  return {
    registry,
    close: async () => {
      if (closed) return
      closed = true
      await closeOwn?.().catch(() => {})
    },
  }
}
