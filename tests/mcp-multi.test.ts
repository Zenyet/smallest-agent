import { describe, it, expect, vi } from 'vitest'
import { loadMcpToolsFromServers, type McpConnection } from '../src/mcp/client'

function fakeConn(toolName: string, onClose: () => void): McpConnection {
  return {
    client: {
      listTools: async () => ({
        tools: [{ name: toolName, description: '', inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    } as unknown as McpConnection['client'],
    close: async () => onClose(),
  }
}

describe('loadMcpToolsFromServers', () => {
  it('connects to each server, merges tools, and closes them all', async () => {
    const closed: string[] = []
    const connect = vi.fn(async (s: { command: string; args: string[] }) =>
      fakeConn(s.args[0], () => closed.push(s.args[0])),
    )
    const { tools, close } = await loadMcpToolsFromServers(
      [
        { command: 'x', args: ['serverA'] },
        { command: 'x', args: ['serverB'] },
      ],
      connect,
    )
    expect(Object.keys(tools).sort()).toEqual(['serverA', 'serverB'])
    expect(connect).toHaveBeenCalledTimes(2)
    await close()
    expect(closed.sort()).toEqual(['serverA', 'serverB'])
  })
})
