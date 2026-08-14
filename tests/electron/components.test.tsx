// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolCallIndicator } from '../../electron/renderer/src/components/ToolCallIndicator'
import { ToolCallGroup } from '../../electron/renderer/src/components/ToolCallGroup'
import { SourceList } from '../../electron/renderer/src/components/SourceList'
import { ApprovalCard } from '../../electron/renderer/src/components/ApprovalCard'
import { MessageBubble } from '../../electron/renderer/src/components/MessageBubble'
import { ChatWindow } from '../../electron/renderer/src/components/ChatWindow'
import { SessionList } from '../../electron/renderer/src/components/SessionList'
import { UNGROUPED_ID } from '../../electron/main/projects'
import type { ChatMessage } from '../../electron/renderer/src/chat-reducer'
import type { ApprovalRequestEvent, SessionGroup } from '../../electron/shared/channels'

const toolEvent = {
  sessionId: 's1',
  turn: 1,
  toolName: 'get_weather',
  args: { city: '北京' },
  output: '{"temp":25}',
}

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'assistant',
  content: '答案',
  tools: [],
  streaming: false,
  ...over,
})

describe('ToolCallIndicator', () => {
  it('显示工具名', () => {
    render(<ToolCallIndicator event={toolEvent} />)
    expect(screen.getByText(/get_weather/)).toBeTruthy()
  })

  it('默认折叠，详情不渲染', () => {
    render(<ToolCallIndicator event={toolEvent} />)
    expect(screen.queryByText(/"temp"/)).toBeNull()
  })

  it('点击后展开显示参数和结果', () => {
    render(<ToolCallIndicator event={toolEvent} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/"temp"/)).toBeTruthy()
    expect(screen.getByText(/北京/)).toBeTruthy()
  })

  it('工具返回 error 时标红（runTool 把异常包成 JSON，不走顶层错误）', () => {
    const failed = { ...toolEvent, output: '{"error":"unknown tool"}' }
    const { container } = render(<ToolCallIndicator event={failed} />)
    expect(container.querySelector('.tool--failed')).toBeTruthy()
  })
})

describe('MessageBubble', () => {
  it('用户消息和助手消息用不同的类名', () => {
    const { container: user } = render(<MessageBubble message={msg({ role: 'user' })} />)
    expect(user.querySelector('.bubble--user')).toBeTruthy()
    const { container: bot } = render(<MessageBubble message={msg()} />)
    expect(bot.querySelector('.bubble--assistant')).toBeTruthy()
  })

  it('渲染挂在消息上的工具调用，按 turn 分组成 ToolCallGroup', () => {
    const tools = [
      { ...toolEvent, turn: 1, toolName: 'search_notes' },
      { ...toolEvent, turn: 1, toolName: 'read_file' },
      { ...toolEvent, turn: 2, toolName: 'get_weather' },
    ]
    const { container } = render(<MessageBubble message={msg({ tools })} />)
    // 两个 turn → 两个 ToolCallGroup
    expect(container.querySelectorAll('.tool-group')).toHaveLength(2)
  })

  it('单个 turn 的工具调用折叠在一起', () => {
    render(<MessageBubble message={msg({ tools: [toolEvent] })} />)
    // 折叠时看不到工具名本身（被包在 ToolCallGroup 里），只看到"本轮 N 次"
    expect(screen.queryByText('get_weather')).toBeNull()
    expect(screen.getByText(/本轮 1 次工具调用/)).toBeTruthy()
  })

  it('流式中显示光标', () => {
    const { container } = render(<MessageBubble message={msg({ streaming: true })} />)
    expect(container.querySelector('.cursor')).toBeTruthy()
  })

  it('核查通过显示 ✅', () => {
    render(<MessageBubble message={msg({ verdict: { grounded: true, issues: [] } })} />)
    expect(screen.getByText(/答案被证据支撑/)).toBeTruthy()
  })

  it('核查存疑显示 ⚠️ 和问题列表', () => {
    render(<MessageBubble message={msg({ verdict: { grounded: false, issues: ['没依据'] } })} />)
    expect(screen.getByText(/可能有未被证据支撑的说法/)).toBeTruthy()
    expect(screen.getByText(/没依据/)).toBeTruthy()
  })

  it('缓存命中显示标记', () => {
    render(<MessageBubble message={msg({ cacheHit: true })} />)
    expect(screen.getByText(/缓存命中/)).toBeTruthy()
  })
})

describe('ChatWindow', () => {
  const idle = { messages: [msg({ role: 'user', content: '问题' })], running: false }

  it('渲染消息列表', () => {
    render(<ChatWindow chat={idle} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('问题')).toBeTruthy()
  })

  it('点发送时把输入内容交出去并清空输入框', () => {
    const sent: string[] = []
    render(<ChatWindow chat={idle} sessionId="s1" onSend={(t) => sent.push(t)} onDecide={() => {}} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '新问题' } })
    fireEvent.click(screen.getByRole('button', { name: /发送/ }))
    expect(sent).toEqual(['新问题'])
    expect(input.value).toBe('')
  })

  it('运行中禁用输入框和发送按钮（agent 是串行的）', () => {
    render(<ChatWindow chat={{ ...idle, running: true }} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /发送/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('空输入不触发发送', () => {
    const sent: string[] = []
    render(<ChatWindow chat={idle} sessionId="s1" onSend={(t) => sent.push(t)} onDecide={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /发送/ }))
    expect(sent).toEqual([])
  })

  it('显示错误提示', () => {
    render(
      <ChatWindow
        chat={{ ...idle, error: { code: 'API_KEY_MISSING', message: 'x' } }}
        sessionId="s1"
        onSend={() => {}}
        onDecide={() => {}}
      />,
    )
    expect(screen.getByText(/请在设置中配置 DeepSeek API Key/)).toBeTruthy()
  })

  it('有 pendingApproval 时渲染 ApprovalCard，点允许触发 onDecide("allow")', () => {
    const decisions: string[] = []
    const pendingApproval = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: { path: 'a.md' },
    }
    render(
      <ChatWindow
        chat={{ ...idle, pendingApproval }}
        sessionId="s1"
        onSend={() => {}}
        onDecide={(d) => decisions.push(d)}
      />,
    )
    expect(screen.getByText(/write_file/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /允许/ }))
    expect(decisions).toEqual(['allow'])
  })

  it('blockedBy 存在时禁用输入框并显示是哪个会话占着串行锁', () => {
    render(
      <ChatWindow
        chat={idle}
        sessionId="s1"
        onSend={() => {}}
        onDecide={() => {}}
        blockedBy={{ sessionId: 's2', title: '会话二', pendingApproval: false }}
      />,
    )
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText(/会话二/)).toBeTruthy()
  })

  it('消息数少于上限时不显示「显示更早」按钮', () => {
    const messages = Array.from({ length: 50 }, (_, i) => msg({ content: `消息${i}` }))
    render(<ChatWindow chat={{ messages, running: false }} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
    expect(screen.queryByText(/显示更早/)).toBeNull()
  })

  it('消息数超过上限时显示「显示更早的 N 条消息」按钮', () => {
    const messages = Array.from({ length: 150 }, (_, i) => msg({ content: `消息${i}` }))
    render(<ChatWindow chat={{ messages, running: false }} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText(/显示更早的 50 条消息/)).toBeTruthy()
  })

  it('点击按钮后显示所有消息，按钮消失', () => {
    const messages = Array.from({ length: 150 }, (_, i) => msg({ content: `消息${i}` }))
    render(<ChatWindow chat={{ messages, running: false }} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
    expect(screen.queryByText('消息0')).toBeNull() // 前 50 条被隐藏
    expect(screen.getByText('消息149')).toBeTruthy() // 最新的在
    fireEvent.click(screen.getByRole('button', { name: /显示更早/ }))
    expect(screen.getByText('消息0')).toBeTruthy() // 现在全部可见
    expect(screen.queryByText(/显示更早/)).toBeNull() // 按钮消失
  })

  it('最新的消息永远不被窗口裁掉', () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg({ content: `消息${i}` }))
    render(<ChatWindow chat={{ messages, running: false }} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
    expect(screen.getByText('消息199')).toBeTruthy() // 最新的第 200 条
    expect(screen.getByText('消息198')).toBeTruthy() // 倒数第 2 条
    expect(screen.queryByText('消息0')).toBeNull() // 最早的被隐藏了
  })

  it('pendingApproval 永远可见，即使消息超过上限（红线测试）', () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg({ content: `消息${i}` }))
    const pendingApproval = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: { path: 'test.md' },
    }
    render(
      <ChatWindow
        chat={{ messages, running: false, pendingApproval }}
        sessionId="s1"
        onSend={() => {}}
        onDecide={() => {}}
      />,
    )
    expect(screen.getByText(/write_file/)).toBeTruthy() // ApprovalCard 可见
    expect(screen.getByRole('button', { name: /允许/ })).toBeTruthy() // 按钮可点
  })

  it('切换会话时 showAll 状态重置（通过 sessionId 变化）', () => {
    const messages = Array.from({ length: 150 }, (_, i) => msg({ content: `消息${i}` }))
    const { rerender } = render(
      <ChatWindow chat={{ messages, running: false }} sessionId="s1" onSend={() => {}} onDecide={() => {}} />,
    )
    // 展开会话 s1
    fireEvent.click(screen.getByRole('button', { name: /显示更早/ }))
    expect(screen.getByText('消息0')).toBeTruthy() // 已展开
    // 切换到会话 s2（不同的 sessionId）
    rerender(<ChatWindow chat={{ messages, running: false }} sessionId="s2" onSend={() => {}} onDecide={() => {}} />)
    // showAll 应该重置，早期消息再次被隐藏
    expect(screen.queryByText('消息0')).toBeNull()
    expect(screen.getByText(/显示更早的 50 条消息/)).toBeTruthy() // 按钮重新出现
  })
})

describe('SessionList', () => {
  // 侧边栏改成「项目分组 + 嵌套会话」之后，它不再直接吃一个扁平的 sessions 数组，
  // 而是吃 groupSessions() 分好的 SessionGroup[]（分组规则本身在
  // projects.test.ts 里单测）。这些用例只管「给定分组，UI 渲染和回调对不对」。
  const groups: SessionGroup[] = [
    {
      id: 'p1',
      name: '我的项目',
      dir: '/Users/me/proj',
      collapsed: false,
      sessions: [
        { id: 's1', title: '会话一', updatedAt: 2, projectId: 'p1' },
        { id: 's2', title: '会话二', updatedAt: 1, projectId: 'p1' },
      ],
    },
  ]

  // 删除/移除的入口是原生右键菜单，组件只负责报告「哪一项被右键了」，
  // 所以这里的桩是 onSessionContextMenu / onProjectContextMenu，
  // 不再是直接的 onDelete / onRemoveProject。
  const noop = {
    onSelect: () => {},
    onCreate: () => {},
    onOpenSettings: () => {},
    onAddProject: () => {},
    onToggleCollapsed: () => {},
    onSelectProject: () => {},
    onSessionContextMenu: () => {},
    onProjectContextMenu: () => {},
  }

  it('列出所有会话', () => {
    render(<SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} />)
    expect(screen.getByText('会话一')).toBeTruthy()
    expect(screen.getByText('会话二')).toBeTruthy()
  })

  it('当前会话有选中样式', () => {
    const { container } = render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} />,
    )
    expect(container.querySelectorAll('.session--active')).toHaveLength(1)
  })

  it('点击会话触发 onSelect', () => {
    const picked: string[] = []
    render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} onSelect={(id) => picked.push(id)} />,
    )
    fireEvent.click(screen.getByText('会话二'))
    expect(picked).toEqual(['s2'])
  })

  it('新建按钮触发 onCreate', () => {
    let created = 0
    render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} onCreate={() => created++} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /新对话/ }))
    expect(created).toBe(1)
  })

  // 原来这里测的是行尾那个 ✕：点它触发 onDelete、且不冒泡到行的 onSelect。
  // 那个按钮已经去掉了，删除改走原生右键菜单，所以这条测试的前提整体换掉：
  // 现在要守的是「右键会话上报的是这一行的 id 和标题」，删除动作本身由
  // App.tsx 在菜单返回后调用（那部分是 App 的职责，不在这个组件里）。
  it('右键会话上报 id 和标题，供上层弹原生菜单', () => {
    const targets: [string, string][] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        onSessionContextMenu={(id, title) => targets.push([id, title])}
      />,
    )
    fireEvent.contextMenu(screen.getByText('会话二'))
    expect(targets).toEqual([['s2', '会话二']])
  })

  it('右键会话不触发 onSelect（右键是「对这一项做点什么」，不是打开它）', () => {
    const picked: string[] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        onSelect={(id) => picked.push(id)}
      />,
    )
    fireEvent.contextMenu(screen.getByText('会话二'))
    expect(picked).toEqual([])
  })

  it('项目名和「项目」区标签都画出来', () => {
    render(<SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} />)
    expect(screen.getByText('项目')).toBeTruthy()
    expect(screen.getByText('我的项目')).toBeTruthy()
  })

  it('点项目行触发 onSelectProject（新会话要落在这个项目下）', () => {
    const picked: string[] = []
    render(
      <SessionList groups={groups} currentId="s1" currentProjectId={null} {...noop} onSelectProject={(id) => picked.push(id)} />,
    )
    fireEvent.click(screen.getByText('我的项目'))
    expect(picked).toEqual(['p1'])
  })

  it('当前项目有选中样式', () => {
    const { container } = render(
      <SessionList groups={groups} currentId={null} currentProjectId="p1" {...noop} />,
    )
    expect(container.querySelectorAll('.project__row--active')).toHaveLength(1)
  })

  // 折叠不再是那个 11px 角标独占的动作 —— 整行点击即折叠/展开，
  // 同一次点击还会把这个项目标为选中（决定新会话落在哪）。
  // 这条测试守的正是「一次点击两个语义都发生」，别让谁把它拆回两个目标。
  it('点击项目行同时触发折叠和选中，且用 aria-expanded 表达状态', () => {
    const toggled: string[] = []
    const selected: string[] = []
    const { rerender } = render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        onToggleCollapsed={(id) => toggled.push(id)}
        onSelectProject={(id) => selected.push(id)}
      />,
    )
    const row = screen.getByRole('button', { name: /我的项目/ })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row)
    expect(toggled).toEqual(['p1'])
    expect(selected).toEqual(['p1'])

    const collapsed = [{ ...groups[0], collapsed: true }]
    rerender(<SessionList groups={collapsed} currentId="s1" currentProjectId="p1" {...noop} />)
    expect(screen.getByRole('button', { name: /我的项目/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('折叠时会话行不渲染，只留一个数量提示', () => {
    const collapsed = [{ ...groups[0], collapsed: true }]
    render(<SessionList groups={collapsed} currentId="s1" currentProjectId="p1" {...noop} />)
    expect(screen.queryByText('会话一')).toBeNull()
    // 折起来之后用户看不见里面有几条，这个数字让他不必展开就知道值不值得展开
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('添加项目按钮触发 onAddProject', () => {
    let added = 0
    render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} onAddProject={() => added++} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }))
    expect(added).toBe(1)
  })

  // 「移除项目」也从行尾的 ✕ 换成了右键菜单。
  it('右键项目行上报 id 和名字，供上层弹原生菜单', () => {
    const targets: [string, string][] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        onProjectContextMenu={(id, name) => targets.push([id, name])}
      />,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: /我的项目/ }))
    expect(targets).toEqual([['p1', '我的项目']])
  })

  it('右键项目行不触发折叠（右键不该改变展开状态）', () => {
    const toggled: string[] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        onToggleCollapsed={(id) => toggled.push(id)}
      />,
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: /我的项目/ }))
    expect(toggled).toEqual([])
  })

  it('「未分组」那一组不给移除按钮（它是兜底分类，不是用户建的东西）', () => {
    const ungrouped: SessionGroup[] = [
      { id: UNGROUPED_ID, name: '未分组', dir: null, collapsed: false, sessions: [{ id: 's9', title: '游离会话', updatedAt: 1 }] },
    ]
    render(<SessionList groups={ungrouped} currentId="s9" currentProjectId={null} {...noop} />)
    expect(screen.getByText('游离会话')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /移除项目/ })).toBeNull()
  })

  it('设置入口是个裸图标按钮（无文字标签，只有 aria-label）', () => {
    let opened = 0
    render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} onOpenSettings={() => opened++} />,
    )
    const gear = screen.getByRole('button', { name: '设置' })
    // 用户明确要求：只要图标，不要「设置」两个字、也不要那条占满宽度的按钮背景
    expect(gear.textContent).toBe('')
    fireEvent.click(gear)
    expect(opened).toBe(1)
  })

  it('空项目显示「还没有对话」，让「添加项目」这个动作有可见结果', () => {
    const empty: SessionGroup[] = [{ ...groups[0], sessions: [] }]
    render(<SessionList groups={empty} currentId={null} currentProjectId="p1" {...noop} />)
    expect(screen.getByText('还没有对话')).toBeTruthy()
  })

  it('一个项目都没有时给引导文案，而不是一片空白', () => {
    render(<SessionList groups={[]} currentId={null} currentProjectId={null} {...noop} />)
    expect(screen.getByText(/还没有项目/)).toBeTruthy()
  })

  it('侧边栏里没有 active:scale 微交互（用户明确要求去掉）', () => {
    const { container } = render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} />,
    )
    expect(container.querySelector('.sidebar')!.innerHTML).not.toMatch(/active:scale/)
  })
})

describe('ToolCallGroup', () => {
  const events = [toolEvent, { ...toolEvent, toolName: 'search_notes', args: { query: 'x' } }]

  it('无 elapsedMs 时不渲染耗时，只显示调用次数', () => {
    render(<ToolCallGroup events={events} />)
    expect(screen.getByText(/本轮 2 次工具调用/)).toBeTruthy()
    expect(screen.queryByText(/\d\.\ds/)).toBeNull()
  })

  it('传入 elapsedMs 时显示耗时', () => {
    render(<ToolCallGroup events={events} elapsedMs={2345} />)
    expect(screen.getByText(/2\.3s/)).toBeTruthy()
  })

  it('默认折叠，单个 ToolCallIndicator 不渲染', () => {
    render(<ToolCallGroup events={events} />)
    expect(screen.queryByText('get_weather')).toBeNull()
  })

  it('点击后展开，显示每个工具调用', () => {
    render(<ToolCallGroup events={events} />)
    fireEvent.click(screen.getByRole('button', { name: /本轮/ }))
    expect(screen.getByText('get_weather')).toBeTruthy()
    expect(screen.getByText('search_notes')).toBeTruthy()
  })

  it('空数组不渲染', () => {
    const { container } = render(<ToolCallGroup events={[]} />)
    expect(container.querySelector('.tool-group')).toBeNull()
  })

  it('组内有失败工具时标记 tool-group--failed 并显示失败比例', () => {
    const failed = [
      { ...toolEvent, output: '{"error":"boom"}' },
      { ...toolEvent, toolName: 'read_file', output: '{"content":"ok"}' },
    ]
    const { container } = render(<ToolCallGroup events={failed} />)
    expect(container.querySelector('.tool-group--failed')).toBeTruthy()
    // 失败计数现在分离：icon + 独立的 "1/2" span，不再紧挨着 emoji
    expect(screen.getByText(/1\/2/)).toBeTruthy()
  })
})

describe('SourceList', () => {
  const hits = [
    { source: '01-rag.md', score: 0.87, chars: 120 },
    { source: '02-agent.md', score: 0.65, chars: 84 },
  ]

  it('hits 为空时不渲染任何东西', () => {
    const { container } = render(<SourceList hits={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('折叠状态显示文件数和片段数，且不夸大成"来源"', () => {
    render(<SourceList hits={hits} />)
    expect(screen.getByText(/2 个文件/)).toBeTruthy()
    expect(screen.getByText(/2 个片段/)).toBeTruthy()
    expect(screen.queryByText('01-rag.md')).toBeNull()
  })

  it('点击展开显示文件名、相似度和片段字符数', () => {
    render(<SourceList hits={hits} />)
    fireEvent.click(screen.getByRole('button', { name: /个文件/ }))
    expect(screen.getByText('01-rag.md')).toBeTruthy()
    expect(screen.getByText(/0\.87/)).toBeTruthy()
    // 断言「片段」前缀本身：这个词是在说清楚 chars 是命中片段的长度、不是整份文件的长度，
    // 只匹配 /120 字/ 的话，前缀被误删了测试也照样绿。
    expect(screen.getByText(/片段 120 字/)).toBeTruthy()
  })

  it('同一文件命中多个片段时，标题按去重后的文件数计数，不是片段数', () => {
    const repeated = [
      { source: 'a.md', score: 0.9, chars: 50 },
      { source: 'a.md', score: 0.7, chars: 60 },
      { source: 'a.md', score: 0.5, chars: 70 },
    ]
    render(<SourceList hits={repeated} />)
    // 3 次命中都来自同一个文件 → 标题应该是「1 个文件」，不是「3 个文件」
    expect(screen.getByText(/1 个文件/)).toBeTruthy()
    expect(screen.getByText(/3 个片段/)).toBeTruthy()
  })

  it('同一文件的多个片段展开后分组展示在该文件名下，不是三条并列的独立来源行', () => {
    const repeated = [
      { source: 'a.md', score: 0.9, chars: 50 },
      { source: 'a.md', score: 0.7, chars: 60 },
    ]
    const { container } = render(<SourceList hits={repeated} />)
    fireEvent.click(screen.getByRole('button', { name: /个文件/ }))
    // 文件名只出现一次（分组），而不是跟着每个片段重复出现两次
    expect(screen.getAllByText('a.md')).toHaveLength(1)
    expect(container.querySelectorAll('.sources__group')).toHaveLength(1)
  })
})

describe('ApprovalCard', () => {
  const request: ApprovalRequestEvent = {
    sessionId: 's1',
    requestId: 'r1',
    toolName: 'write_file',
    args: { path: 'a.md', content: 'hi' },
  }

  it('显示工具名和参数', () => {
    render(<ApprovalCard request={request} onDecide={() => {}} />)
    expect(screen.getByText(/write_file/)).toBeTruthy()
    expect(screen.getByText(/a\.md/)).toBeTruthy()
  })

  it('点击允许触发 onDecide("allow")', () => {
    const decisions: string[] = []
    render(<ApprovalCard request={request} onDecide={(d) => decisions.push(d)} />)
    fireEvent.click(screen.getByRole('button', { name: /允许/ }))
    expect(decisions).toEqual(['allow'])
  })

  it('点击拒绝触发 onDecide("deny")', () => {
    const decisions: string[] = []
    render(<ApprovalCard request={request} onDecide={(d) => decisions.push(d)} />)
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }))
    expect(decisions).toEqual(['deny'])
  })

  it('参数展示区限高且可滚动，避免超长 payload 把允许/拒绝按钮挤出屏幕外', () => {
    const bigRequest: ApprovalRequestEvent = {
      ...request,
      args: { path: 'a.md', content: 'x'.repeat(5000) },
    }
    const { container } = render(<ApprovalCard request={bigRequest} onDecide={() => {}} />)
    const pre = container.querySelector('pre')!
    expect(pre.className).toMatch(/max-h-/)
    expect(pre.className).toMatch(/overflow-y-auto/)
  })
})
