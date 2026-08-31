import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../electron/main/agent-runtime'
import { loadConfig } from '../../src/config'
import type { RuntimeStatusEvent } from '../../electron/shared/channels'
import type { Tool, ToolRegistry } from '../../src/types'

const config = loadConfig({ DEEPSEEK_API_KEY: 'k', NOTES_DIR: '/notes' })
const specs = {
  own: { command: 'own', args: [] },
  fs: { command: 'fs', args: [] },
}

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  parameters: {},
  run: async () => name,
})

// 默认的假依赖：不碰网络、不起子进程
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    makeEmbedder: async () => async (texts: string[]) => texts.map(() => [1, 0]),
    buildNotesIndex: async () => ({ size: 3, search: () => [] }) as never,
    makeSearchNotesTool: () => fakeTool('search_notes'),
    loadMcpToolsFromServers: async (servers: { command: string }[]) => {
      const name = servers[0].command === 'own' ? 'get_weather' : 'read_file'
      return { tools: { [name]: fakeTool(name) } as ToolRegistry, close: async () => {} }
    },
    ...overrides,
  }
}

describe('createRuntime', () => {
  it('按 embedding → indexing → mcp → ready 的顺序播报进度', async () => {
    const phases: RuntimeStatusEvent['phase'][] = []
    await createRuntime(config, specs, (e) => phases.push(e.phase), makeDeps())
    expect(phases).toEqual(['embedding', 'indexing', 'mcp', 'ready'])
  })

  it('注册表 = 自建 server 的工具 + 笔记检索 + 联网那两个', async () => {
    const rt = await createRuntime(config, specs, () => {}, makeDeps())
    // fs server 不在这里（按项目目录懒建，见 fs-tools.ts）。
    // web_search / fetch_url 在这里：它们是全局能力，没有跟着项目走的边界。
    expect(Object.keys(rt.registry).sort()).toEqual([
      'fetch_url',
      'get_weather',
      'search_notes',
      'web_search',
    ])
  })

  // fs server 连不上的降级测试**移到 fs-tools.test.ts** 了 ——
  // createRuntime 不再碰 fs server（按项目目录建，见 fs-tools.ts）

  it('自建 server 连不上是致命错误：抛出并播报 failed', async () => {
    const phases: RuntimeStatusEvent['phase'][] = []
    const deps = makeDeps({
      loadMcpToolsFromServers: async (servers: { command: string }[]) => {
        if (servers[0].command === 'own') throw new Error('boom')
        return { tools: {}, close: async () => {} }
      },
    })
    await expect(
      createRuntime(config, specs, (e) => phases.push(e.phase), deps),
    ).rejects.toThrow('boom')
    expect(phases.at(-1)).toBe('failed')
  })

  it('close 会关掉所有已建立的 MCP 连接', async () => {
    const closed: string[] = []
    const deps = makeDeps({
      loadMcpToolsFromServers: async (servers: { command: string }[]) => ({
        tools: {},
        close: async () => {
          closed.push(servers[0].command)
        },
      }),
    })
    const rt = await createRuntime(config, specs, () => {}, deps)
    await rt.close()
    // fs server 不再自动加入（只在有 cwd 时才加），所以只有用户配的 own
    expect(closed).toEqual(['own'])
  })
})
