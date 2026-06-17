# smallest-agent Stage 3 (MCP + Skills) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 的工具注册表不再硬编码——启动时从一个真实的 stdio MCP server 动态发现工具（`get_weather` 迁进去，外加 `list_skills` / `get_skill`）。Skills 做成 `skills/*.md`，通过 MCP 两个工具渐进披露。`runAgent` 循环一行不改，只有「工具从哪来」变了。

**Architecture:** 做一个真的最小 MCP（`@modelcontextprotocol/sdk`）：`mcp-server.ts`（stdio server，暴露 get_weather / list_skills / get_skill），`src/mcp/client.ts`（`connectMcp` 起子进程连上、`loadMcpTools` 把 `tools/list` 转成我们的 `ToolRegistry`，每个工具 `run` 走 `tools/call`）。本地写死的 `get_weather` 删掉、搬进 server；`search_notes` 因为要进程内向量库留本地。`loadMcpTools` 用假 client 做确定性单测；另加一个真集成测试派生真实 server、list+call 跑通整个往返（纯本地 stdio，无需网络/无需 DeepSeek key）。

**Tech Stack:** 新增 `@modelcontextprotocol/sdk`。复用 `ai` 的 `jsonSchema()` 把 MCP 的 JSON-Schema 包成 SDK 的 tool inputSchema。其余沿用 Stage 0-2。

---

## 文件结构（Stage 3）

| 文件 | 职责 | 测试 |
|------|------|------|
| `src/tools/weather.ts` | **删除**（逻辑搬进 mcp-server） | — |
| `src/tools/index.ts`（改） | 去掉硬编码 weather；只留 `runTool` | tools.test.ts 重写 |
| `mcp-server.ts`（新，根目录） | stdio MCP server：get_weather / list_skills / get_skill | 由集成测试验证 |
| `skills/summarize-notes.md` / `skills/code-review.md`（新） | 示例技能（frontmatter: name/description + 正文） | — |
| `src/mcp/client.ts`（新） | `connectMcp` + `loadMcpTools` + `McpToolClient` 类型 | mcp-client.test.ts（假 client） |
| `cli.ts`（改） | 连 MCP、合并 `{...mcpTools, search_notes}`、退出关闭 | 真机验证 |
| `README.md`（改） | 勾选 Stage 3 概念 | — |
| `tests/mcp-client.test.ts`（新） | loadMcpTools 单测 | ✓ |
| `tests/mcp-integration.test.ts`（新） | 真实 server 往返 | ✓ |

---

## Task 1: 依赖

**Files:** Modify `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: 安装**
Run（从 `/Users/royzeng/lab/smallest-agent`）:
```bash
pnpm add @modelcontextprotocol/sdk
```

- [ ] **Step 2: Commit**
```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @modelcontextprotocol/sdk"
```

---

## Task 2: 删除本地 weather，重写 tools 测试

**Files:** Delete `src/tools/weather.ts`; Modify `src/tools/index.ts`; Rewrite `tests/tools.test.ts`

- [ ] **Step 1: 用以下完整内容替换 `tests/tools.test.ts`**（不再依赖 weather；只测 runTool）
```ts
import { describe, it, expect } from 'vitest'
import { runTool } from '../src/tools/index'
import type { ToolRegistry } from '../src/types'

const reg: ToolRegistry = {
  echo: {
    name: 'echo',
    description: '',
    parameters: {},
    run: (a: { msg: string }) => ({ echoed: a.msg }),
  },
}

describe('runTool', () => {
  it('runs a known tool and returns a JSON string', async () => {
    const out = await runTool(reg, 'echo', { msg: 'hi' })
    expect(JSON.parse(out)).toEqual({ echoed: 'hi' })
  })

  it('returns error JSON for an unknown tool', async () => {
    expect(JSON.parse(await runTool(reg, 'nope', {}))).toHaveProperty('error')
  })

  it('catches errors thrown inside a tool and returns them as JSON', async () => {
    const boom: ToolRegistry = {
      boom: { name: 'boom', description: '', parameters: {}, run: () => { throw new Error('kaboom') } },
    }
    expect(JSON.parse(await runTool(boom, 'boom', {})).error).toMatch(/kaboom/)
  })
})
```

- [ ] **Step 2: 用以下完整内容替换 `src/tools/index.ts`**（移除 weather 与 `tools` 导出，只留 `runTool`）
```ts
import type { ToolRegistry } from '../types'

export async function runTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = registry[name]
  if (!tool) {
    return JSON.stringify({ error: `unknown tool: ${name}` })
  }
  try {
    const output = await tool.run(args)
    return JSON.stringify(output)
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
```

- [ ] **Step 3: 删除 `src/tools/weather.ts`**
Run: `git rm src/tools/weather.ts`

- [ ] **Step 4: 验证**
Run: `pnpm test tools && pnpm typecheck`
Expected: tools 测试 3 个通过；typecheck 干净（确认没有别处还 import `weatherTool` 或 `tools`——若 cli.ts 仍 import 会在 Task 6 替换，本步只要 `tsc` 报错仅来自 cli.ts 即可；若如此，本步先跳过 typecheck 的 cli 报错，Task 6 修复。优先确保 `pnpm test` 全绿）。
> 注：此时 `cli.ts` 仍是 Stage 2 版本、会 import 已删除的 `tools`，导致 typecheck 报错。这是预期的，Task 6 会替换 cli.ts。本步只需 `pnpm test`（vitest 不编译 cli.ts）全绿即可。

- [ ] **Step 5: Commit**
```bash
git add src/tools/index.ts tests/tools.test.ts
git commit -m "refactor: remove hardcoded weather tool (moving to MCP server)"
```

---

## Task 3: 技能文件 + MCP server

**Files:** Create `skills/summarize-notes.md`, `skills/code-review.md`, `mcp-server.ts`

- [ ] **Step 1: 写 `skills/summarize-notes.md`**
```
---
name: summarize-notes
description: 把一段笔记压成 TL;DR + 3-5 个标签
---
# 笔记总结技能

当用户给你一段笔记并希望总结时，按以下步骤：
1. 用一句话写出 TL;DR（不超过 30 字）。
2. 提取 3-5 个标签（小写、用连字符），覆盖主题与技术栈。
3. 如果笔记里有待办或疑问，单列「未决」。
输出用简洁中文，不要寒暄。
```

- [ ] **Step 2: 写 `skills/code-review.md`**
```
---
name: code-review
description: 对一段代码做要点式评审，聚焦正确性与可维护性
---
# 代码评审技能

评审一段代码时，按维度给出要点（每条一句话，标注严重度）：
- 正确性：bug、边界、错误处理。
- 可维护性：命名、职责单一、重复。
- 简洁：可删的复杂度。
只列真问题，没问题就说「未发现明显问题」。不要逐行复述代码。
```

- [ ] **Step 3: 写 `mcp-server.ts`（根目录）**
```ts
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(here, 'skills')

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

server.tool(
  'get_weather',
  '查询某个城市的当前天气。当用户询问某地天气时调用。',
  { city: z.string().describe('城市名称，例如 北京') },
  async ({ city }) => ({
    content: [
      { type: 'text', text: JSON.stringify({ city, temperature: 22, condition: '晴', unit: '°C' }) },
    ],
  }),
)

server.tool(
  'list_skills',
  '列出可用技能（名称 + 一句话描述）。需要某种能力时先调它看有哪些。',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(await listSkills()) }],
  }),
)

server.tool(
  'get_skill',
  '按名称读取某个技能的完整说明。需要用某技能时调它拿到具体步骤。',
  { name: z.string().describe('技能名，来自 list_skills') },
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

const transport = new StdioServerTransport()
await server.connect(transport)
```
> 若安装的 SDK 版本里 `McpServer.tool(name, description, shape, cb)` 这个重载已弃用/改名（如改用 `server.registerTool(name, { description, inputSchema }, cb)`），按当前版本等价 API 调整——以 Task 5 的集成测试跑通为准。

- [ ] **Step 4: 类型检查**
Run: `pnpm typecheck`（cli.ts 仍是旧版会报错，属预期；确认 mcp-server.ts 本身无类型错误）。

- [ ] **Step 5: Commit**
```bash
git add skills/summarize-notes.md skills/code-review.md mcp-server.ts
git commit -m "feat: stdio MCP server exposing get_weather + skills (list/get)"
```

---

## Task 4: MCP client `src/mcp/client.ts`

**Files:** Create `src/mcp/client.ts`; Test `tests/mcp-client.test.ts`

- [ ] **Step 1: 写失败测试 `tests/mcp-client.test.ts`**
```ts
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
```

- [ ] **Step 2: 运行 `pnpm test mcp-client` 确认失败。**

- [ ] **Step 3: 写 `src/mcp/client.ts`**
```ts
import { jsonSchema } from 'ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolRegistry } from '../types'

export interface McpToolClient {
  listTools(): Promise<{
    tools: { name: string; description?: string; inputSchema: unknown }[]
  }>
  callTool(args: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<{ content: { type: string; text?: string }[] }>
}

export interface McpConnection {
  client: Client
  close: () => Promise<void>
}

export async function connectMcp(opts: { command: string; args: string[] }): Promise<McpConnection> {
  const transport = new StdioClientTransport({ command: opts.command, args: opts.args })
  const client = new Client({ name: 'smallest-agent', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

export async function loadMcpTools(client: McpToolClient): Promise<ToolRegistry> {
  const { tools } = await client.listTools()
  const registry: ToolRegistry = {}
  for (const t of tools) {
    registry[t.name] = {
      name: t.name,
      description: t.description ?? '',
      parameters: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      run: async (args: Record<string, unknown>) => {
        const res = await client.callTool({ name: t.name, arguments: args })
        return res.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n')
      },
    }
  }
  return registry
}
```
> 若 `jsonSchema` 在装的 `ai` v6 里改名/改签名，按实际调整（它是 SDK 边界）。若 `Client` 的 `listTools/callTool` 类型与 `McpToolClient` 不能直接赋值，集成测试/CLI 里用 `as unknown as McpToolClient` 过桥。

- [ ] **Step 4: 运行 `pnpm test mcp-client` 确认通过（2）。**

- [ ] **Step 5: Commit**
```bash
git add src/mcp/client.ts tests/mcp-client.test.ts
git commit -m "feat: MCP client — connectMcp + loadMcpTools (tools/list -> registry)"
```

---

## Task 5: 集成测试（真实 server 往返）

**Files:** Create `tests/mcp-integration.test.ts`

- [ ] **Step 1: 写 `tests/mcp-integration.test.ts`**
```ts
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
```

- [ ] **Step 2: 运行集成测试**
Run: `pnpm test mcp-integration`
Expected: PASS（1）。首次会让 tsx 冷启动子进程，故 60s 超时。
> 若失败：先 `npx tsx mcp-server.ts` 手动起一下看 server 是否能独立启动（它会等待 stdin、不打印东西是正常的，Ctrl-C 退出）；再看是不是 `McpServer.tool` 的 API 版本问题（回 Task 3 调整）或 skills 目录路径问题。改到通过。

- [ ] **Step 3: Commit**
```bash
git add tests/mcp-integration.test.ts
git commit -m "test: MCP end-to-end — spawn real server, discover and call tools"
```

---

## Task 6: CLI 接线 + README + 验证

**Files:** Modify `cli.ts`, `README.md`

- [ ] **Step 1: 用以下完整内容替换 `cli.ts`**
```ts
import 'dotenv/config'
import { loadConfig } from './src/config'
import type { Message } from './src/types'
import { makeSearchNotesTool } from './src/tools/searchNotes'
import { makeEmbedder } from './src/rag/embed'
import { buildNotesIndex } from './src/rag/index'
import { makeCallModel } from './src/llm'
import { runAgent } from './src/agent'
import { printTurn } from './src/trace'
import { createJsonSessionStore } from './src/memory/store'
import { makeSummarizer } from './src/memory/summarize'
import { compactMessages } from './src/memory/compact'
import { connectMcp, loadMcpTools, type McpToolClient } from './src/mcp/client'

async function main() {
  const question = process.argv.slice(2).join(' ').trim()
  if (!question) {
    console.error('用法: pnpm dev "你的问题"')
    process.exit(1)
  }
  const config = loadConfig()

  console.error('加载 embedding 模型并构建笔记索引…')
  const embed = await makeEmbedder(config)
  const store = await buildNotesIndex({ notesDir: config.notesDir, embed })
  console.error(`索引完成：${store.size} 个片段`)

  // 工具从 MCP server 动态发现（get_weather / list_skills / get_skill）
  console.error('连接 MCP server，发现工具…')
  const mcp = await connectMcp({ command: 'npx', args: ['tsx', 'mcp-server.ts'] })
  try {
    const mcpTools = await loadMcpTools(mcp.client as unknown as McpToolClient)
    console.error(`MCP 工具：${Object.keys(mcpTools).join(', ')}`)

    const searchTool = makeSearchNotesTool({ store, embed })
    const registry = { ...mcpTools, [searchTool.name]: searchTool }
    const callModel = makeCallModel(config, registry)

    const sessions = createJsonSessionStore(config.sessionsDir)
    const history = await sessions.load(config.sessionId)
    if (history.length) console.error(`已载入会话「${config.sessionId}」的 ${history.length} 条历史`)
    const summarize = makeSummarizer(makeCallModel(config, {}))
    const compact = (messages: Message[]) =>
      compactMessages(messages, {
        maxTokens: config.maxContextTokens,
        keepRecent: config.keepRecent,
        summarize,
      })
    const onComplete = async (messages: Message[]) => {
      await sessions.save(config.sessionId, messages.filter((m) => m.role !== 'system'))
    }

    const answer = await runAgent(question, {
      callModel,
      tools: registry,
      config,
      onTurn: printTurn,
      history,
      compact,
      onComplete,
    })
    console.log('\n=== 最终回答 ===')
    console.log(answer)
  } finally {
    await mcp.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: 更新 `README.md`**
（a）把「### 阶段 3 — MCP + Skills」整段替换为：
```
### 阶段 3 — MCP + Skills ✅
- [x] MCP（工具从 stdio MCP server 动态加载，agent 不写死工具）
- [x] Skills（skills/*.md，经 list_skills/get_skill 渐进披露）
```
（b）在「## Stage 2 在做什么」之后新增一节：
```
## Stage 3 在做什么

工具不再写死在代码里。`cli.ts` 启动时起一个 stdio MCP server（`mcp-server.ts`），`tools/list` 动态发现工具，转成注册表喂给 agent；`runTool` 对 MCP 工具走 `tools/call`。往 server 加个工具，agent 不改一行就能用。
`get_weather` 已搬进 MCP server；`search_notes` 因为要进程内向量库留本地——演示「本地 + MCP 两种来源合并成一个注册表」。
Skills 做成 `skills/*.md`：模型先 `list_skills` 看有哪些，需要时再 `get_skill` 拉全文——真实 Claude Skills 的「渐进披露」。

> 试试：`pnpm dev "用 code-review 技能评审：function add(a,b){return a-b}"`，看它先 list_skills、再 get_skill、按技能要点作答。
```
（c）「## 结构」代码块：把 `src/tools/` 那行改为 `src/tools/     runTool（工具执行器）`，并追加：
```
src/mcp/       MCP client（connectMcp + loadMcpTools）
mcp-server.ts  stdio MCP server（get_weather + skills）
skills/        技能 markdown（渐进披露）
```

- [ ] **Step 3: 全量测试 + 类型检查**
Run: `pnpm test && pnpm typecheck`
Expected: 之前 43 −（删掉的 weather 1 个：原 tools.test 的 weatherTool 用例）+ tools 重写后 3（原也是 3，净 0 变化处理见下）+ mcp-client 2 + mcp-integration 1 = **46 个测试通过**，typecheck 干净（cli.ts 现在也编译）。
> 说明：Stage 2 末是 43。Task 2 把 tools.test 从「weather 1 + runTool 3 = 4」重写为「runTool 3」（−1）。Task 4 +2，Task 5 +1。43 − 1 + 2 + 1 = 45。若你数到 45/46 视 weather 用例原数而定，以「全绿 + typecheck 干净」为准，不必纠结具体数字。

- [ ] **Step 4: Commit**
```bash
git add cli.ts README.md
git commit -m "feat: wire MCP tool discovery into CLI; stage 3 runnable"
```

- [ ] **Step 5: 真机端到端（留给用户，需 DeepSeek key）**
```bash
pnpm dev "北京天气怎么样"
pnpm dev "用 code-review 技能评审这段代码：function add(a,b){return a-b}"
```
Expected：第一条经 MCP 的 `get_weather` 作答；第二条 trace 里能看到 `🔧 调用 list_skills` → `🔧 调用 get_skill(code-review)` → 按技能要点指出 `add` 实际做了减法。

---

## Self-Review（已核对）

**Spec coverage：** Stage 3 = MCP + Skills。MCP = mcp-server(Task3) + client(Task4) + 集成验证(Task5) + cli 动态加载(Task6)；「把写死的改成 MCP」= 删本地 weather、搬进 server(Task2/3)。Skills = skills/*.md + list_skills/get_skill 渐进披露(Task3)。

**Placeholder scan：** 无 TBD/TODO。mcp-server / cli 标注「真机或集成测试验证」并给完整实现。两处版本相关的不确定（`McpServer.tool` 重载、`jsonSchema` 签名、`Client` 与 `McpToolClient` 赋值）都给了明确的回退做法，非占位。

**Type consistency：** `McpToolClient` 定义于 client.ts，被 loadMcpTools、两个测试、cli 统一使用（真 `Client` 用 `as unknown as McpToolClient` 过桥）。`connectMcp({command,args})→{client, close}`、`loadMcpTools(client)→ToolRegistry`、`runTool(registry,name,args)`（不变）、`runAgent` 不变。MCP 工具的 `parameters` 用 `jsonSchema(...)`，本地 `search_notes` 用 zod——两者都是 `ai` 的 `tool({inputSchema})` 合法入参，故 `llm.ts` 不改。删除 weather 只影响 tools.test.ts（已重写）与 cli.ts（Task6 替换）；agent.test.ts 用自带 `tools` fixture、不受影响。
