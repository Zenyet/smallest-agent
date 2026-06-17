// ============================================================================
// mcp-server.ts —— 我们自己实现的 stdio MCP server
// ----------------------------------------------------------------------------
// 这个文件是「供 agent 连接的工具服务器」，作为独立子进程运行，通过 stdio
// 与父进程（MCP client）通信。它对外暴露三个工具：
//   • get_weather：演示用的写死桩，返回固定假数据（不真正联网）
//   • list_skills / get_skill：把 skills/*.md 做成「渐进披露」的技能库——
//     先只给名字和一句话描述，模型真正需要时再按名字取全文（省 token）
//
// 对应 Stage 3「工具从 MCP 动态发现」的服务端。
// client.ts 是与之配对的客户端。
// ============================================================================

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// ESM 下没有 __dirname，用 import.meta.url 还原出当前文件所在目录。
const here = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(here, 'skills')

// 从 Markdown 文件头的 YAML Front Matter 解析 name / description 字段。
// 格式：文件以 ---\n...\n--- 包围的 key: value 行开头。
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  return { name: meta.name, description: meta.description }
}

// 扫描 skills/ 目录，只返回「名字+描述」，不返回全文。
// 渐进披露的第一步：模型先知道有什么，再按需取详情，避免一次塞满上下文。
async function listSkills(): Promise<{ name: string; description: string }[]> {
  const files = (await readdir(SKILLS_DIR)).filter((f) => f.endsWith('.md')).sort()
  const out: { name: string; description: string }[] = []
  for (const f of files) {
    const fm = parseFrontmatter(await readFile(join(SKILLS_DIR, f), 'utf8'))
    out.push({ name: fm.name ?? f.replace(/\.md$/, ''), description: fm.description ?? '' })
  }
  return out
}

const server = new McpServer({ name: 'smallest-agent-skills', version: '0.0.0' })

// ⚠ 写死的桩（stub）：不真正联网，只返回硬编码的假天气数据。
// 目的是演示「agent 通过 MCP 调工具」这条路通了，而不是提供真实天气服务。
// 如需真实数据，把这里换成 fetch('https://...') 即可，agent 侧无需改动。
server.registerTool(
  'get_weather',
  {
    description: '查询某个城市的当前天气。当用户询问某地天气时调用。',
    inputSchema: { city: z.string().describe('城市名称，例如 北京') },
  },
  async ({ city }) => ({
    content: [
      { type: 'text', text: JSON.stringify({ city, temperature: 22, condition: '晴', unit: '°C' }) },
    ],
  }),
)

// 渐进披露第一层：只列出可用技能的名字和描述，不展开全文内容。
// 设计意图：让模型能「发现」有哪些技能，而不一开始就消耗大量 token。
server.registerTool(
  'list_skills',
  {
    description: '列出可用技能（名称 + 一句话描述）。需要某种能力时先调它看有哪些。',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await listSkills()) }],
  }),
)

// 渐进披露第二层：按名字读取某技能的完整 Markdown 说明。
// 用 replace(/[^a-zA-Z0-9_-]/g, '_') 净化文件名，防止路径穿越（../../../etc/passwd 类攻击）。
server.registerTool(
  'get_skill',
  {
    description: '按名称读取某个技能的完整说明。需要用某技能时调它拿到具体步骤。',
    inputSchema: { name: z.string().describe('技能名，来自 list_skills') },
  },
  async ({ name }) => {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    try {
      const md = await readFile(join(SKILLS_DIR, `${safe}.md`), 'utf8')
      return { content: [{ type: 'text', text: md }] }
    } catch {
      return { content: [{ type: 'text', text: `未找到技能：${name}` }], isError: true }
    }
  },
)

// 启动 stdio 传输层并等待连接——这是顶层 await，文件被执行时直接跑起来。
// 父进程（client）拿到子进程句柄后即可通过 stdin/stdout 发送 MCP 消息。
const transport = new StdioServerTransport()
await server.connect(transport)
