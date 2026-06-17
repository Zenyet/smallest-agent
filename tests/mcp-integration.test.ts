import { describe, it, expect } from 'vitest'
import { connectMcp, loadMcpTools, type McpToolClient } from '../src/mcp/client'

describe('MCP integration (real stdio server)', () => {
  it('discovers and calls tools from mcp-server.ts', async () => {
    const conn = await connectMcp({ command: 'npx', args: ['tsx', 'mcp-server.ts'] })
    try {
      const tools = await loadMcpTools(conn.client as unknown as McpToolClient)
      const names = Object.keys(tools)
      expect(names).toContain('get_weather')
      expect(names).toContain('list_skills')
      expect(names).toContain('get_skill')

      const skills = await tools.list_skills.run({})
      expect(skills).toContain('summarize-notes')

      const weather = await tools.get_weather.run({ city: '北京' })
      expect(weather).toContain('北京')
    } finally {
      await conn.close()
    }
  }, 60000)
})
