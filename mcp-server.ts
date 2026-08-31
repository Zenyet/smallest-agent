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

// WMO 天气代码 → 中文描述。
//
// Open-Meteo 返回的是 WMO 标准代码（一个整数），不是文字。不映射的话模型
// 拿到的是 `weather_code: 61`，它得自己猜那是什么 —— 而它猜错了用户看不出来。
// 这张表是 WMO 4677 的常用子集，覆盖 Open-Meteo 实际会返回的那些。
const WMO: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴大冰雹',
}

// 真实天气查询，走 Open-Meteo。
//
// ## 为什么选 Open-Meteo
//
// **不需要 API key**。和 web_search 兜底选维基百科是同一条理由（见
// src/tools/web.ts 的文件头）：一个「要先去注册个 key 才能用」的工具，在
// 用户没配的时候只会反复报错，比没有这个工具更糟。OpenWeatherMap 更全，
// 但它要 key，那就得先做设置项、再做「没配 key 时怎么说」——而天气是个
// 谁都会顺手一问的功能，不该有这道门槛。
//
// ## 两次请求，因为模型给的是城市名
//
// 天气 API 要经纬度，模型只知道「北京」。所以先 geocoding 把名字换成坐标，
// 再查天气。两次网络往返是这个取舍的代价 —— 换来的是模型不用背经纬度。
//
// 地名重复（比如「Springfield」）时取第一个结果，并把 API 认定的
// 国家/行政区一起返回：让模型能在答案里说清「是美国伊利诺伊州那个」，
// 而不是给一个不知道在哪的温度。
server.registerTool(
  'get_weather',
  {
    description:
      '查询某个城市的当前天气（实时联网）。用户问天气、气温、下不下雨时调用。',
    inputSchema: { city: z.string().describe('城市名称，例如 北京 / Tokyo') },
  },
  async ({ city }) => {
    const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true })
    try {
      // 第一步：地名 → 坐标。language=zh 让它认中文地名
      const geoUrl =
        `https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json` +
        `&name=${encodeURIComponent(city)}`
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(10_000) })
      if (!geoRes.ok) return fail(`查地名失败：HTTP ${geoRes.status}`)
      const geo = (await geoRes.json()) as {
        results?: { latitude: number; longitude: number; name: string; country?: string; admin1?: string }[]
      }
      const place = geo.results?.[0]
      // 找不到就直说，不要退回一个默认城市 —— 那会让模型报告一个
      // 完全无关地点的天气，而用户看不出来
      if (!place) return fail(`没找到叫「${city}」的地方，换个说法或写全一点（比如加上省份/国家）`)

      // 第二步：坐标 → 当前天气
      const wxUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&timezone=auto`
      const wxRes = await fetch(wxUrl, { signal: AbortSignal.timeout(10_000) })
      if (!wxRes.ok) return fail(`查天气失败：HTTP ${wxRes.status}`)
      const wx = (await wxRes.json()) as {
        current?: Record<string, number>
        current_units?: Record<string, string>
      }
      const cur = wx.current
      if (!cur) return fail('天气接口没返回当前天气数据')

      const code = cur.weather_code
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                // 回显 API 认定的地点，让模型能说清是哪个「同名城市」
                location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
                temperature: cur.temperature_2m,
                feels_like: cur.apparent_temperature,
                humidity: cur.relative_humidity_2m,
                wind_speed: cur.wind_speed_10m,
                // 代码和文字都给：文字给模型读，代码留作它不认识这个描述时的依据
                condition: WMO[code] ?? `未知天气代码 ${code}`,
                weather_code: code,
                units: {
                  temperature: wx.current_units?.temperature_2m ?? '°C',
                  wind_speed: wx.current_units?.wind_speed_10m ?? 'km/h',
                },
                source: 'open-meteo.com',
              },
              null,
              2,
            ),
          },
        ],
      }
    } catch (err) {
      // 网络超时/断网也要给模型一句能读懂的话，而不是抛一个栈
      return fail(`查天气出错：${err instanceof Error ? err.message : String(err)}`)
    }
  },
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
