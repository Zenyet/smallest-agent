// App 级装配：把「贵」的资源建好长驻。
// cli.ts 是「装配 → 跑一次 → 退出」，桌面端长驻，所以装配线要拆两段：
//   这里（启动一次）：embedding 模型、笔记索引、MCP 子进程
//   agent-runner（每条消息一次）：callModel 装饰链 —— 因为流式回调要绑当前 sessionId
import { makeEmbedder as realMakeEmbedder } from '../../src/rag/embed'
import { buildNotesIndex as realBuildNotesIndex } from '../../src/rag/index'
import { makeSearchNotesTool as realMakeSearchNotesTool } from '../../src/tools/searchNotes'
import { loadMcpToolsFromServers as realLoadMcpToolsFromServers } from '../../src/mcp/client'
import {
  makeWebSearchTool as realMakeWebSearchTool,
  makeFetchUrlTool as realMakeFetchUrlTool,
  type WebSearchKeys,
} from '../../src/tools/web'
import { connectMcpWithEnv } from './mcp-connect'
import type { McpServerSpec } from './mcp-paths'
import type { RuntimeStatusEvent } from '../shared/channels'
import type { Config, ToolRegistry } from '../../src/types'

export interface AgentRuntime {
  /**
   * 和会话无关的全局工具：Skills（自建 server）+ 笔记检索。
   *
   * **不含文件工具** —— 那些按会话所属项目的目录懒建，见 fs-tools.ts。
   * agent-runner 每轮把两者合起来。
   */
  registry: ToolRegistry
  close(): Promise<void>
}

// 全部做成可注入的：测试里塞假实现，就不用真的下载模型 / 起子进程。
export interface RuntimeDeps {
  makeEmbedder: typeof realMakeEmbedder
  buildNotesIndex: typeof realBuildNotesIndex
  makeSearchNotesTool: typeof realMakeSearchNotesTool
  loadMcpToolsFromServers: typeof realLoadMcpToolsFromServers
  makeWebSearchTool: typeof realMakeWebSearchTool
  makeFetchUrlTool: typeof realMakeFetchUrlTool
}

const defaultDeps: RuntimeDeps = {
  makeEmbedder: realMakeEmbedder,
  buildNotesIndex: realBuildNotesIndex,
  makeSearchNotesTool: realMakeSearchNotesTool,
  loadMcpToolsFromServers: realLoadMcpToolsFromServers,
  makeWebSearchTool: realMakeWebSearchTool,
  makeFetchUrlTool: realMakeFetchUrlTool,
}

export async function createRuntime(
  config: Config,
  // fs server 移出去了（按项目目录建），所以这里只要自建那个
  specs: { own: McpServerSpec },
  onStatus: (event: RuntimeStatusEvent) => void,
  deps: Partial<RuntimeDeps> = {},
  /**
   * 搜索后端的 key 从哪儿读。
   *
   * 是个**函数**而不是值：用户可能在应用跑起来之后才去设置里填 key，
   * 传值的话这个 runtime 会一直拿着启动那一刻的空 key，用户填完得重启
   * 才生效 —— 而设置里其它项都是即时生效的，这一项特殊会让人以为没保存。
   *
   * 默认返回空：两个 key 都没有时 web_search 退到维基百科（那一档不要
   * key），所以「读不到设置」不等于「这个工具坏了」。见 src/tools/web.ts。
   */
  searchKeys: () => WebSearchKeys = () => ({}),
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

    // fs server **不在这里建了**。
    //
    // 它的允许目录就是沙箱边界，而边界要跟着「这个会话属于哪个项目」变 ——
    // 在这里建一次意味着全应用共用一个固定边界（原来就是那样：写死成
    // 一个全局 notesDir）。现在按项目目录懒建 + 缓存，见 fs-tools.ts。
    //
    // 留在这里的都是**和会话无关**的全局资源：embedding 模型、笔记索引、
    // 自建 server（Skills，它不碰用户的文件）。
    const searchTool = d.makeSearchNotesTool({ store, embed })
    // 联网这两个是**和会话无关**的全局能力（不像文件工具那样有边界要跟着
    // 项目走），所以留在这里，不进 fs-tools 那个池子。
    const webSearch = d.makeWebSearchTool(searchKeys)
    const fetchUrl = d.makeFetchUrlTool()
    const registry: ToolRegistry = {
      ...own.tools,
      [searchTool.name]: searchTool,
      [webSearch.name]: webSearch,
      [fetchUrl.name]: fetchUrl,
    }

    onStatus({ phase: 'ready', detail: `就绪（${Object.keys(registry).length} 个工具）` })

    return {
      registry,
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
