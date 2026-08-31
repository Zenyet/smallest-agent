import { describe, it, expect } from 'vitest'
import { runAgent } from '../src/agent'
import { loadConfig } from '../src/config'
import type { ModelResult, ToolRegistry } from '../src/types'
import type { TurnInfo } from '../src/agent'

const config = loadConfig({ DEEPSEEK_API_KEY: 'k' })

/** 跑一轮，收集 onTurn 报告出来的东西 */
async function turnsFrom(results: ModelResult[], tools: ToolRegistry = {}) {
  const turns: TurnInfo[] = []
  let i = 0
  await runAgent('问题', {
    callModel: async () => results[i++] ?? { text: '完', toolCalls: [] },
    tools,
    config,
    onTurn: (info) => turns.push(info),
  })
  return turns
}

describe('服务端执行的工具要报告给界面', () => {
  // ## 这一条锁的是一个真 bug
  //
  // DeepSeek 的 web_search 在服务端跑完，结果直接进响应。原来 llm.ts 把它
  // 从 toolCalls 里滤掉（否则 runTool 会拿这个名字去本地注册表查，查不到就
  // 返回 "unknown tool" 喂回模型），但滤掉之后它也不进 toolResults ——
  // 于是界面上什么都不显示，用户看到的是凭空多出来的时效性答案。
  it('serverToolCalls 进 toolResults，onTurn 报告得出去', async () => {
    const turns = await turnsFrom([
      {
        text: '今天的新闻是……',
        toolCalls: [],
        serverToolCalls: [{ name: 'web_search', args: { query: '今天新闻' }, output: '搜到三条' }],
      },
    ])
    expect(turns[0].toolResults).toEqual([
      { name: 'web_search', args: { query: '今天新闻' }, output: '搜到三条' },
    ])
  })

  // 它已经跑完了，再跑一次既没意义、本地也没有这个工具
  it('服务端工具不进本地执行循环', async () => {
    let ran = 0
    const tools: ToolRegistry = {
      web_search: {
        name: 'web_search',
        description: 'd',
        parameters: undefined,
        run: async () => {
          ran++
          return 'x'
        },
      },
    }
    await turnsFrom(
      [
        {
          text: '答案',
          toolCalls: [],
          serverToolCalls: [{ name: 'web_search', args: {}, output: '服务端的结果' }],
        },
      ],
      tools,
    )
    expect(ran).toBe(0)
  })

  // output 两边形状要一致：本地工具那条路是 runTool 的 JSON 字符串，
  // 消费方（trace 打印、UI 卡片）不该分两种情况处理
  it('结构化 output 序列化成字符串', async () => {
    const turns = await turnsFrom([
      {
        text: '答案',
        toolCalls: [],
        serverToolCalls: [{ name: 'web_search', args: {}, output: { hits: 3 } }],
      },
    ])
    expect(turns[0].toolResults[0].output).toBe('{"hits":3}')
  })

  it('字符串 output 原样保留，不多包一层引号', async () => {
    const turns = await turnsFrom([
      {
        text: '答案',
        toolCalls: [],
        serverToolCalls: [{ name: 'web_search', args: {}, output: '纯文本' }],
      },
    ])
    expect(turns[0].toolResults[0].output).toBe('纯文本')
  })

  // 服务端搜完之后模型直接给答案（没有本地工具要调），走的是 agent 循环的
  // 提前返回那条路 —— 那条路也得报告，否则最常见的情况反而看不见
  it('模型没要调本地工具时也报告（提前返回那条路）', async () => {
    const turns = await turnsFrom([
      {
        text: '直接答了',
        toolCalls: [],
        serverToolCalls: [{ name: 'web_search', args: {}, output: 'r' }],
      },
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].toolResults).toHaveLength(1)
  })

  // 服务端搜索 + 本地工具可以在同一轮里都发生
  it('和本地工具并存，两者都出现在 toolResults 里', async () => {
    const tools: ToolRegistry = {
      read_file: { name: 'read_file', description: 'd', parameters: undefined, run: async () => 'ok' },
    }
    const turns = await turnsFrom(
      [
        {
          text: '',
          toolCalls: [{ id: '1', name: 'read_file', args: { path: 'a' } }],
          serverToolCalls: [{ name: 'web_search', args: {}, output: 'r' }],
        },
      ],
      tools,
    )
    expect(turns[0].toolResults.map((t: { name: string }) => t.name)).toEqual([
      'web_search',
      'read_file',
    ])
  })

  it('没有服务端工具时行为不变', async () => {
    const turns = await turnsFrom([{ text: '答案', toolCalls: [] }])
    expect(turns[0].toolResults).toEqual([])
  })
})
