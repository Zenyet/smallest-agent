import { describe, it, expect, vi } from 'vitest'
import { createRuntime, type RuntimeDeps } from '../../electron/main/agent-runtime'
import { loadConfig } from '../../src/config'
import type { RuntimeStatusEvent } from '../../electron/shared/channels'
import type { Tool, ToolRegistry } from '../../src/types'

const config = loadConfig({ DEEPSEEK_API_KEY: 'k', NOTES_DIR: '/notes' })
const specs = { own: { command: 'own', args: [] } }
const fakeTool = (name: string): Tool => ({ name, description: name, parameters: {}, run: async () => name })
const makeDeps = (overrides: Partial<RuntimeDeps> = {}): RuntimeDeps => ({
  makeEmbedder: async () => async (texts) => texts.map(() => [1, 0]),
  buildNotesIndex: async () => ({ size: 3, search: () => [] }) as never,
  makeSearchNotesTool: () => fakeTool('search_notes'),
  loadMcpToolsFromServers: async () => ({ tools: { get_weather: fakeTool('get_weather') }, close: async () => {} }),
  makeWebSearchTool: () => fakeTool('web_search'), makeFetchUrlTool: () => fakeTool('fetch_url'),
  ...overrides,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('独立能力的运行时', () => {
  it('MCP 未连接、检索未下载时，基础工具已经可用', async () => {
    const mcp = deferred<{ tools: ToolRegistry; close: () => Promise<void> }>()
    const embed = vi.fn(makeDeps().makeEmbedder)
    const statuses: RuntimeStatusEvent[] = []
    const rt = await createRuntime(config, specs, (s) => statuses.push(s), makeDeps({
      makeEmbedder: embed, loadMcpToolsFromServers: () => mcp.promise,
    }))
    expect(statuses[0].phase).toBe('ready')
    expect(embed).not.toHaveBeenCalled()
    await expect(rt.registry.web_search.run({ query: 'q' })).resolves.toBe('web_search')
    const close = vi.fn(async () => {})
    mcp.resolve({ tools: { get_weather: fakeTool('get_weather') }, close })
    await vi.waitFor(() => expect(rt.registry.get_weather).toBeDefined())
    await rt.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('首次检索才加载，多个会话共享同一次初始化', async () => {
    const ready = deferred<Awaited<ReturnType<RuntimeDeps['makeEmbedder']>>>()
    const embed = vi.fn(() => ready.promise)
    const index = vi.fn(makeDeps().buildNotesIndex)
    const rt = await createRuntime(config, specs, () => {}, makeDeps({ makeEmbedder: embed, buildNotesIndex: index }))
    const first = rt.registry.search_notes.run({ query: 'one' })
    const second = rt.registry.search_notes.run({ query: 'two' })
    expect(embed).toHaveBeenCalledOnce()
    expect(index).not.toHaveBeenCalled()
    ready.resolve(async (texts) => texts.map(() => [1, 0]))
    await Promise.all([first, second])
    expect(index).toHaveBeenCalledOnce()
    await rt.registry.search_notes.run({ query: 'three' })
    expect(embed).toHaveBeenCalledOnce()
    await rt.close()
  })

  it('检索失败不影响聊天状态或其他工具，后续调用可重试', async () => {
    const embed = vi.fn(makeDeps().makeEmbedder).mockRejectedValueOnce(new Error('download unavailable'))
    const states: RuntimeStatusEvent[] = []
    const rt = await createRuntime(config, specs, (s) => states.push(s), makeDeps({ makeEmbedder: embed }))
    await expect(rt.registry.search_notes.run({ query: 'q' })).rejects.toThrow(/笔记检索暂不可用/)
    expect(states.at(-1)?.phase).toBe('ready')
    expect(states.at(-1)?.capabilities?.find((c) => c.id === 'notes')?.state).toBe('failed')
    await expect(rt.registry.fetch_url.run({ url: 'x' })).resolves.toBe('fetch_url')
    await expect(rt.registry.search_notes.run({ query: 'q' })).resolves.toBe('search_notes')
    expect(embed).toHaveBeenCalledTimes(2)
    await rt.close()
  })

  it('扩展连接失败只改变对应能力的状态', async () => {
    const states: RuntimeStatusEvent[] = []
    const rt = await createRuntime(config, specs, (s) => states.push(s), makeDeps({
      loadMcpToolsFromServers: async () => { throw new Error('unavailable') },
    }))
    await vi.waitFor(() => expect(states.at(-1)?.capabilities?.find((c) => c.id === 'skills')?.state).toBe('failed'))
    expect(states.every((s) => s.phase === 'ready')).toBe(true)
    await expect(rt.registry.search_notes.run({ query: 'q' })).resolves.toBe('search_notes')
    await rt.close()
  })

  it('退出后才完成的 MCP 连接也被关闭，不重新发布就绪状态', async () => {
    const mcp = deferred<{ tools: ToolRegistry; close: () => Promise<void> }>()
    const status = vi.fn()
    const close = vi.fn(async () => {})
    const rt = await createRuntime(config, specs, status, makeDeps({ loadMcpToolsFromServers: () => mcp.promise }))
    await rt.close()
    const count = status.mock.calls.length
    mcp.resolve({ tools: {}, close })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(status).toHaveBeenCalledTimes(count)
    await expect(rt.registry.search_notes.run({ query: 'q' })).rejects.toThrow(/退出/)
  })

  it('桌面启动允许未配置密钥，模型请求仍要求有效配置', () => {
    expect(loadConfig({}, { allowMissingApiKey: true }).apiKey).toBe('')
    expect(() => loadConfig({})).toThrow(/API_KEY/)
  })
})
