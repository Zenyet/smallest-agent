// ============================================================================
// client.ts —— 通用 MCP 客户端：连接 stdio 子进程并动态发现工具
// ----------------------------------------------------------------------------
// MCP（Model Context Protocol）是一套标准协议，让模型能调用外部「工具服务器」。
// 这个文件做 Stage 3 的核心：不再把工具写死到代码里，而是在运行时通过协议
// 向 MCP server 问「你有什么工具」，拿到描述后动态组装成 agent 能用的 ToolRegistry。
//
// 调用链：connectMcp（建连接）→ loadMcpTools（发现工具 + 包装 run）
//         → loadMcpToolsFromServers（多 server 合并，是给 cli 用的入口）
// ============================================================================

import { jsonSchema } from 'ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolRegistry } from '../types'

// 对 MCP client 能力的最小接口约束，方便在测试里注入假客户端，
// 而不必实例化完整的 Client 对象。
export interface McpToolClient {
  listTools(): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown }[]
  }>
  callTool(args: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>
}

// 封装「已建立的连接」：client 供后续调用，close 供程序退出时优雅断开。
export interface McpConnection {
  client: Client
  close: () => Promise<void>
}

// 起一个 stdio 子进程（命令 + 参数）并与之建立 MCP 连接。
// stdio 模式：父进程把子进程的 stdin/stdout 当管道，协议消息通过管道互传。
export async function connectMcp(opts: { command: string; args: string[] }): Promise<McpConnection> {
  const transport = new StdioClientTransport({ command: opts.command, args: opts.args })
  const client = new Client({ name: 'smallest-agent', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

// 向一个 MCP server 发 tools/list，把返回的每个工具描述转成 ToolRegistry 条目。
// 每个工具的 run 函数就是向同一个 server 发 tools/call，把结果拼成字符串。
export async function loadMcpTools(client: McpToolClient): Promise<ToolRegistry> {
  const { tools } = await client.listTools()
  const registry: ToolRegistry = {}
  for (const t of tools) {
    registry[t.name] = {
      name: t.name,
      description: t.description ?? '',
      // jsonSchema() 是 Vercel AI SDK 的包装器，它给 inputSchema 补上 SDK 期望的
      // 元数据字段（$schema 版本等）。MCP 返回的是裸 JSON Schema object（类型是
      // unknown），必须先强转 as Parameters<typeof jsonSchema>[0] 让 TS 编译通过，
      // 这是「类型体操过桥」而非真正的运行时类型校验。
      parameters: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      run: async (args: Record<string, unknown>) => {
        const res = await client.callTool({ name: t.name, arguments: args })
        // MCP 响应的 content 是数组（可能含图片等多种类型），这里只取 text 类型拼接，
        // 足以覆盖本项目所有工具的文本输出。
        const text = res.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n')
        if (res.isError) throw new Error(text || `MCP 工具 ${t.name} 执行失败`)
        return text
      },
    }
  }
  return registry
}

// 连接多个 MCP server，把各自的工具合并进同一个 ToolRegistry 交给 agent 使用。
// connect 参数默认是 connectMcp，允许测试注入假连接器——依赖注入让这里可测。
// 同名工具后面的 server 会覆盖前面的（Object.assign 语义），注意 server 顺序。
export async function loadMcpToolsFromServers(
  servers: { command: string; args: string[] }[],
  connect: (s: { command: string; args: string[] }) => Promise<McpConnection> = connectMcp,
): Promise<{ tools: ToolRegistry; close: () => Promise<void> }> {
  const conns: McpConnection[] = []
  const tools: ToolRegistry = {}
  for (const s of servers) {
    const conn = await connect(s)
    conns.push(conn)
    // conn.client 的静态类型是 Client，但我们只需要它满足 McpToolClient 接口；
    // Client 实现了这两个方法但 TS 类型定义不完全匹配，as unknown as 是"双跳"强转，
    // 意思是「我知道运行时它有这些方法，编译器不需要验证」。
    const t = await loadMcpTools(conn.client as unknown as McpToolClient)
    Object.assign(tools, t)
  }
  return {
    tools,
    close: async () => {
      // 并发关闭所有连接，而不是串行等待，避免关闭阶段多余延迟。
      await Promise.all(conns.map((c) => c.close()))
    },
  }
}
