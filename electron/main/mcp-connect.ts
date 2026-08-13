// connectMcp（src/mcp/client.ts）只传 command + args，没有 env 字段，
// 而生产环境启动自建 MCP server 必须带上 ELECTRON_RUN_AS_NODE=1。
// loadMcpToolsFromServers 的第二个参数（原本是留给测试的注入点）正好能用来换掉连接器，
// 所以这里复刻一份带 env 的版本 —— 代价是 6 行重复，换来 src/ 一行不改。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpConnection } from '../../src/mcp/client'
import type { McpServerSpec } from './mcp-paths'

// 抽成纯函数是为了能单测 env 合并逻辑 —— 真正 new Transport 的那步没法在单测里跑。
export function transportOptions(
  spec: McpServerSpec,
  baseEnv: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') env[key] = value
  }
  Object.assign(env, spec.env ?? {})
  return { command: spec.command, args: spec.args, env }
}

export async function connectMcpWithEnv(spec: McpServerSpec): Promise<McpConnection> {
  const transport = new StdioClientTransport(transportOptions(spec, process.env))
  const client = new Client({ name: 'smallest-agent-desktop', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}
