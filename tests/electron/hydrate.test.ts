// 会话历史还原。对应 rs/ui/src/history.rs 那组测试 ——
// 两边是同一个算法（turn 从消息顺序重建），所以用例也对应。
import { describe, it, expect } from 'vitest'
import { hydrateMessages } from '../../electron/renderer/src/hydrate'
import type { Message } from '../../electron/shared/channels'

const S = 's1'

// 一轮完整的工具调用：assistant 声明 → tool 结果 → assistant 给答案。
// 这就是 src/agent.ts 往 messages 里 push 的真实顺序。
const oneTurn = (): Message[] => [
  { role: 'user', content: '看看有什么文件' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'list_directory', args: { path: '.' } }],
  },
  { role: 'tool', content: '{"entries":[]}', toolCallId: 'c1', name: 'list_directory' },
  { role: 'assistant', content: '目录是空的' },
]

describe('hydrateMessages', () => {
  it('工具调用能撑过一次重载', () => {
    // 这是要修的核心问题：数据本来在磁盘上，但 hydrate 把它丢了，
    // 重开 app 之后历史里只剩正文
    const out = hydrateMessages(oneTurn(), S)
    expect(out).toHaveLength(2) // 用户一条 + 助手一条

    const answer = out[1]
    expect(answer.content).toBe('目录是空的')
    expect(answer.tools).toHaveLength(1)
    expect(answer.tools[0].toolName).toBe('list_directory')
    // 参数也要还原 —— 只有名字的话看不出它到底做了什么
    expect(answer.tools[0].args).toEqual({ path: '.' })
    expect(answer.tools[0].output).toContain('entries')
  })

  it('turn 号从消息顺序重建', () => {
    // turn 不需要持久化，它由消息顺序唯一决定。
    // 分组靠它，两轮不能被并成一组
    const h: Message[] = [
      ...oneTurn(),
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'a.md' } }],
      },
      { role: 'tool', content: '{"content":"hi"}', toolCallId: 'c2', name: 'read_file' },
      { role: 'assistant', content: '读到了' },
    ]
    const out = hydrateMessages(h, S)
    expect(out[1].tools[0].turn).toBe(1)
    expect(out[2].tools[0].turn).toBe(2)
  })

  it('同一轮的并行调用共享 turn 号', () => {
    // 模型一次可以要调好几个工具。它们必须同号，
    // 否则界面上会显示成「本轮 1 次」重复几遍
    const h: Message[] = [
      { role: 'user', content: '并行' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', args: { path: '1' } },
          { id: 'b', name: 'read_file', args: { path: '2' } },
        ],
      },
      { role: 'tool', content: '{}', toolCallId: 'a', name: 'read_file' },
      { role: 'tool', content: '{}', toolCallId: 'b', name: 'read_file' },
      { role: 'assistant', content: '都读完了' },
    ]
    const out = hydrateMessages(h, S)
    const tools = out[1].tools
    expect(tools).toHaveLength(2)
    expect(tools[0].turn).toBe(tools[1].turn)
  })

  it('被中断的那轮仍然显示它的工具', () => {
    // 调了工具但没来得及回答就被中断 —— 这一轮不能从历史里消失，
    // 那正是用户最想回看的情况（「上次干到哪儿了」）
    const h: Message[] = [
      { role: 'user', content: '跑一下' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'ls' } }],
      },
      { role: 'tool', content: '{"exit_code":0}', toolCallId: 'c1', name: 'run_command' },
      // 没有收尾的 assistant
    ]
    const out = hydrateMessages(h, S)
    expect(out).toHaveLength(2) // 该补出一条承载工具的助手消息
    expect(out[1].tools).toHaveLength(1)
  })

  it('工具不会跨用户消息串台', () => {
    const h: Message[] = [
      { role: 'user', content: '第一问' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', args: {} }],
      },
      { role: 'tool', content: '{}', toolCallId: 'c1', name: 'read_file' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '答第二问' },
    ]
    const out = hydrateMessages(h, S)
    const last = out[out.length - 1]
    expect(last.content).toBe('答第二问')
    expect(last.tools).toHaveLength(0)
  })

  it('system 消息不显示', () => {
    // 它是我们注入的，不是对话内容
    const out = hydrateMessages(
      [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: 'hi' },
      ],
      S,
    )
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('hi')
  })

  it('孤儿工具结果仍然显示', () => {
    // 历史被手改过、或者上游丢了那条 assistant —— 仍然要显示，
    // 只是参数空着。整条丢掉的话用户不知道调过什么
    const out = hydrateMessages(
      [{ role: 'tool', content: '{"ok":1}', toolCallId: 'missing', name: 'read_file' }],
      S,
    )
    expect(out).toHaveLength(1)
    expect(out[0].tools[0].toolName).toBe('read_file')
  })

  it('磁盘上的时间戳被带进界面消息', () => {
    // 时间戳是**持久化**的：存盘时打的戳，读盘后界面要能拿到，
    // 否则重开 app 之后所有历史消息都没有时间（这正是最初的 bug）。
    const out = hydrateMessages(
      [
        { role: 'user', content: '你好', timestamp: 1000 },
        { role: 'assistant', content: '在的', timestamp: 2000 },
      ],
      S,
    )
    expect(out.map((m) => m.timestamp)).toEqual([1000, 2000])
  })

  it('旧会话没有时间戳时留空，不编一个', () => {
    // 旧会话文件里没有这个字段。我们确实不知道那些消息何时发生，
    // 留 undefined 让界面不显示，而不是拿「现在」冒充。
    const out = hydrateMessages(
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在的' },
      ],
      S,
    )
    expect(out.every((m) => m.timestamp === undefined)).toBe(true)
  })

  it('纯文本对话不受影响', () => {
    // 最常见的情况：没有任何工具调用
    const out = hydrateMessages(
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你' },
      ],
      S,
    )
    expect(out).toHaveLength(2)
    expect(out.every((m) => m.tools.length === 0)).toBe(true)
    expect(out.every((m) => m.streaming === false)).toBe(true)
  })
})
