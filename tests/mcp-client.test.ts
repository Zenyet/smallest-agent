import { describe, it, expect, vi } from 'vitest'
import { loadMcpTools, type McpToolClient } from '../src/mcp/client'

function fakeClient(): McpToolClient {
  return {
    listTools: async () => ({
      tools: [
        {
          name: 'get_skill',
          description: '读取技能',
          inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      ],
    }),
    callTool: vi.fn(async ({ name, arguments: args }) => ({
      content: [{ type: 'text', text: `called ${name} with ${JSON.stringify(args)}` }],
    })),
  }
}

describe('loadMcpTools', () => {
  it('MCP 错误不能被当成成功的文件内容返回', async () => {
    const client = fakeClient()
    client.callTool = async () => ({ isError: true, content: [{ type: 'text', text: 'Permission denied' }] })
    const reg = await loadMcpTools(client)
    await expect(reg.get_skill.run({ name: 'x' })).rejects.toThrow('Permission denied')
  })

  it('builds a registry from tools/list', async () => {
    const reg = await loadMcpTools(fakeClient())
    expect(Object.keys(reg)).toEqual(['get_skill'])
    expect(reg.get_skill.description).toBe('读取技能')
    expect(reg.get_skill.parameters).toBeDefined()
  })

  it('run() calls tools/call and returns the joined text content', async () => {
    const reg = await loadMcpTools(fakeClient())
    const out = await reg.get_skill.run({ name: 'x' })
    expect(out).toContain('called get_skill')
    expect(out).toContain('"name":"x"')
  })
})
