import { describe, it, expect } from 'vitest'
import { loadMcpToolsFromServers } from '../src/mcp/client'

describe('MCP multi-server (our server + external filesystem server)', () => {
  it('merges tools from our server and the official filesystem server', async () => {
    const { tools, close } = await loadMcpToolsFromServers([
      { command: 'npx', args: ['tsx', 'mcp-server.ts'] },
      { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './notes'] },
    ])
    try {
      const names = Object.keys(tools)
      // our server's tool
      expect(names).toContain('get_weather')
      // the external server contributed tools we did not write
      expect(names.length).toBeGreaterThan(3)
      // confirmed fs tools from probe: read_file, list_directory, directory_tree, list_allowed_directories, etc.
      const fsToolCandidates = ['list_directory', 'list_allowed_directories', 'read_text_file', 'read_file', 'directory_tree']
      expect(fsToolCandidates.some((n) => names.includes(n))).toBe(true)
    } finally {
      await close()
    }
  }, 90000)
})
