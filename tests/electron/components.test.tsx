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

  // ## 这几条锁的是一个真 bug
  //
  // 复制按钮原来写在 StreamingText 里，条件是 `!message.streaming`，
  // 而那个组件只在 streaming 为 true 时被渲染 —— 两个条件互斥，
  // 所以那个按钮**从来没出现过**。没有测试覆盖，所以它悄悄存在了很久。
  it('答完的助手消息有复制按钮', () => {
    render(<MessageBubble message={msg()} />)
    expect(screen.getByLabelText('复制')).toBeTruthy()
  })

  it('流式中的消息也有复制按钮', () => {
    // 这是原来那个死分支覆盖不到的另一半：流式时也该能复制已收到的部分
    render(<MessageBubble message={msg({ streaming: true, content: '半截' })} />)
    expect(screen.getByLabelText('复制')).toBeTruthy()
  })

  it('用户消息也有复制按钮', () => {
    render(<MessageBubble message={msg({ role: 'user', content: '我的提问' })} />)
    expect(screen.getByLabelText('复制')).toBeTruthy()
  })

  it('空内容不给复制按钮', () => {
    // 一个字符都没收到时冒出个空拷贝按钮是假的
    expect(
      render(<MessageBubble message={msg({ content: '' })} />).container.querySelector(
        '[aria-label="复制"]',
      ),
    ).toBeNull()
  })

  it('点复制写入剪贴板并给出已复制反馈', async () => {
    const written: string[] = []
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
    })
    render(<MessageBubble message={msg({ content: '要复制的正文' })} />)
    fireEvent.click(screen.getByLabelText('复制'))
    expect(written).toEqual(['要复制的正文'])
    // 反馈：按钮的 aria-label 变成「已复制」，用户才知道点生效了
    expect(await screen.findByLabelText('已复制')).toBeTruthy()
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

  // ## 这一条锁的是「气泡底部空了一块」
  //
  // 徽章行原来是无条件渲染的，于是绝大多数消息（既没缓存命中、也没核查结论）
  // 在正文下面挂着一个带 mt-1.5 的空 flex 盒子 —— 白占一截高度。
  it('没有徽章时不渲染徽章行（空容器会让气泡底部白空一块）', () => {
    const { container } = render(<MessageBubble message={msg()} />)
    expect(container.querySelector('.bubble__badges')).toBeNull()
  })

  it('有徽章时才渲染徽章行', () => {
    const { container } = render(<MessageBubble message={msg({ cacheHit: true })} />)
    expect(container.querySelector('.bubble__badges')).toBeTruthy()
  })

  // 操作栏是气泡的**兄弟**，不在气泡内部 —— 在里面的话气泡的 py-2 会在它
  // 下面再垫一层 padding（「底部像空了」的另一半原因）。gpui 侧也是气泡下面
  // 那一行，见 chat.rs 的 render_message_actions。
  it('操作栏在气泡外面，不在气泡内部', () => {
    const { container } = render(<MessageBubble message={msg()} />)
    const bubble = container.querySelector('.bubble')!
    expect(bubble.querySelector('[aria-label="复制"]')).toBeNull()
    expect(container.querySelector('[aria-label="复制"]')).toBeTruthy()
  })

  // --- 编辑重发 ---
  //
  // 编辑只给用户消息：改模型说过的话没有意义 —— 它不是「我想说的」，
  // 改了也不会让模型重新想。

  it('用户消息有编辑按钮', () => {
    render(<MessageBubble message={msg({ role: 'user' })} onEditResend={() => {}} canEdit />)
    expect(screen.getByLabelText('编辑')).toBeTruthy()
  })

  it('助手消息没有编辑按钮', () => {
    render(<MessageBubble message={msg()} onEditResend={() => {}} canEdit />)
    expect(screen.queryByLabelText('编辑')).toBeNull()
  })

  // 正在跑的时候那一轮还在往 messages 里写，之后的截断会和它打架
  it('正在跑时不给编辑入口', () => {
    render(
      <MessageBubble message={msg({ role: 'user' })} onEditResend={() => {}} canEdit={false} />,
    )
    expect(screen.queryByLabelText('编辑')).toBeNull()
  })

  it('没有 onEditResend 时不给编辑入口（只读场景）', () => {
    render(<MessageBubble message={msg({ role: 'user' })} canEdit />)
    expect(screen.queryByLabelText('编辑')).toBeNull()
  })

  // 气泡**原地**变输入框，而不是把内容塞回底部 composer —— 后者会让用户
  // 失去「我在改哪一条」的位置感（历史长、那条已滚出视口时尤其明显）
  it('点编辑后气泡原地变成输入框，带原内容', () => {
    render(
      <MessageBubble message={msg({ role: 'user', content: '原问题' })} onEditResend={() => {}} canEdit />,
    )
    fireEvent.click(screen.getByLabelText('编辑'))
    const box = screen.getByLabelText('编辑消息') as HTMLTextAreaElement
    expect(box.value).toBe('原问题')
  })

  it('编辑态下不显示复制/编辑，改成取消/发送', () => {
    render(<MessageBubble message={msg({ role: 'user' })} onEditResend={() => {}} canEdit />)
    fireEvent.click(screen.getByLabelText('编辑'))
    expect(screen.queryByLabelText('复制')).toBeNull()
    expect(screen.queryByLabelText('编辑')).toBeNull()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy()
  })

  it('点发送交出新内容', () => {
    const sent: string[] = []
    render(
      <MessageBubble
        message={msg({ role: 'user', content: '旧' })}
        onEditResend={(t) => sent.push(t)}
        canEdit
      />,
    )
    fireEvent.click(screen.getByLabelText('编辑'))
    fireEvent.change(screen.getByLabelText('编辑消息'), { target: { value: '新问题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(sent).toEqual(['新问题'])
  })

  it('回车发送、Shift+回车不发送（和 composer 同一套手势）', () => {
    const sent: string[] = []
    render(
      <MessageBubble message={msg({ role: 'user' })} onEditResend={(t) => sent.push(t)} canEdit />,
    )
    fireEvent.click(screen.getByLabelText('编辑'))
    const box = screen.getByLabelText('编辑消息')
    fireEvent.change(box, { target: { value: '改完了' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(sent).toEqual([])
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sent).toEqual(['改完了'])
  })

  it('点取消回到原样，不交出内容', () => {
    const sent: string[] = []
    render(
      <MessageBubble
        message={msg({ role: 'user', content: '原样' })}
        onEditResend={(t) => sent.push(t)}
        canEdit
      />,
    )
    fireEvent.click(screen.getByLabelText('编辑'))
    fireEvent.change(screen.getByLabelText('编辑消息'), { target: { value: '改了但不发' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(sent).toEqual([])
    expect(screen.queryByLabelText('编辑消息')).toBeNull()
    expect(screen.getByLabelText('编辑')).toBeTruthy()
  })

  it('Esc 放弃编辑', () => {
    render(<MessageBubble message={msg({ role: 'user' })} onEditResend={() => {}} canEdit />)
    fireEvent.click(screen.getByLabelText('编辑'))
    fireEvent.keyDown(screen.getByLabelText('编辑消息'), { key: 'Escape' })
    expect(screen.queryByLabelText('编辑消息')).toBeNull()
  })

  // 清空了就当取消 —— 发一条空消息没有意义
  it('清空内容后发送等于取消', () => {
    const sent: string[] = []
    render(
      <MessageBubble message={msg({ role: 'user' })} onEditResend={(t) => sent.push(t)} canEdit />,
    )
    fireEvent.click(screen.getByLabelText('编辑'))
    fireEvent.change(screen.getByLabelText('编辑消息'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(sent).toEqual([])
    expect(screen.queryByLabelText('编辑消息')).toBeNull()
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

  it('运行中禁用输入框；没给 onCancel 时发送键仍在但不可点', () => {
    // 不传 onCancel 的场景（比如设置窗口那类只读用法）：退回原来的行为，
    // 发送键还在、禁用。传了 onCancel 才换成停止键，见下一条。
    render(<ChatWindow chat={{ ...idle, running: true }} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /发送/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  // 跑起来时右下角**换成**停止键，不是并排再加一个 —— composer 那行右下角
  // 只有一个控件位，两个键并排会同时有一个是灰的，占位又不可点。
  it('运行中把发送键换成停止键', () => {
    render(
      <ChatWindow
        chat={{ ...idle, running: true }}
        sessionId="s1"
        onSend={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /发送/ })).toBeNull()
  })

  it('点停止键回调 onCancel', () => {
    let stopped = 0
    render(
      <ChatWindow
        chat={{ ...idle, running: true }}
        sessionId="s1"
        onSend={() => {}}
        onCancel={() => {stopped += 1}}
        onDecide={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停止/ }))
    expect(stopped).toBe(1)
  })

  it('没在跑时没有停止键', () => {
    render(
      <ChatWindow chat={idle} sessionId="s1" onSend={() => {}} onCancel={() => {}} onDecide={() => {}} />,
    )
    expect(screen.queryByRole('button', { name: /停止/ })).toBeNull()
    expect(screen.getByRole('button', { name: /发送/ })).toBeTruthy()
  })

  // 别的会话占着串行锁时不给停止键 —— 那时该点的是横幅上的「去看看」。
  // 在这里放停止键等于让用户从 A 会话去停 B 会话，而 runner.cancel 也只认
  // 正在跑的那个 sessionId，点了不会有任何效果。
  it('被别的会话阻塞时不给停止键', () => {
    render(
      <ChatWindow
        chat={idle}
        sessionId="s1"
        onSend={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        blockedBy={{ sessionId: 's2', title: '另一个会话', pendingApproval: false }}
      />,
    )
    expect(screen.queryByRole('button', { name: /停止/ })).toBeNull()
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

  // 删除/移除/改名的入口是右键菜单（现在是自绘的，见 components/ContextMenu.tsx），
  // 组件只负责报告「哪一项被右键了 + 光标在哪」，所以这里的桩是
  // onSessionContextMenu / onProjectContextMenu，不是直接的 onDelete。
  const noop = {
    onSelect: () => {},
    onCreate: () => {},
    onOpenSettings: () => {},
    onAddProject: () => {},
    onToggleCollapsed: () => {},
    onSelectProject: () => {},
    onSessionContextMenu: () => {},
    onProjectContextMenu: () => {},
    renamingId: null,
    onRename: () => {},
    onCancelRename: () => {},
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
  // 那个按钮已经去掉了，删除改走右键菜单（现在是自绘的，见 ContextMenu.tsx），
  // 所以这条测试的前提整体换掉：现在要守的是「右键会话上报这一行的 id、标题
  // 和光标坐标」，删除动作本身由 App.tsx 在拿到菜单项后调用。
  //
  // 坐标必须一起上报：菜单要钉在右键那一下的位置，而 App 收不到那个事件。
  it('右键会话上报 id、标题和光标坐标', () => {
    const targets: [string, string, { x: number; y: number }][] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        onSessionContextMenu={(id, title, at) => targets.push([id, title, at])}
      />,
    )
    fireEvent.contextMenu(screen.getByText('会话二'), { clientX: 120, clientY: 88 })
    expect(targets).toEqual([['s2', '会话二', { x: 120, y: 88 }]])
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

  // --- 就地改名 ---
  // 就地编辑而不是弹对话框：改名是个轻动作，弹窗要用户先看清标题再点确定，
  // 反而多两步（gpui 侧 sidebar.rs 记的是同一条理由）。

  it('renamingId 指向的那一行换成输入框，标题不再显示', () => {
    render(<SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} renamingId="s2" />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('会话二')
    // 那一行的标题文字被输入框顶掉了
    expect(screen.queryByText('会话二')).toBeNull()
    // 别的行不受影响
    expect(screen.getByText('会话一')).toBeTruthy()
  })

  it('回车提交新标题', () => {
    const renamed: [string, string][] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        renamingId="s2"
        onRename={(id, title) => renamed.push([id, title])}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '改过的名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renamed).toEqual([['s2', '改过的名字']])
  })

  // 空标题 = 恢复自动推导的名字（主进程侧 withTitle 会删掉那条覆盖）
  it('提交空标题也交出去，由主进程决定恢复默认名', () => {
    const renamed: [string, string][] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        renamingId="s2"
        onRename={(id, title) => renamed.push([id, title])}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renamed).toEqual([['s2', '']])
  })

  it('Esc 放弃改名，不提交', () => {
    const renamed: string[] = []
    let cancelled = 0
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        renamingId="s2"
        onRename={(id) => renamed.push(id)}
        onCancelRename={() => {cancelled += 1}}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '不想要的名字' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(cancelled).toBe(1)
    expect(renamed).toEqual([])
  })

  // 失焦按放弃而不是提交：点到别处通常是「算了」，静默改掉名字会让人
  // 不确定自己刚干了什么
  it('失焦放弃改名，不提交', () => {
    const renamed: string[] = []
    let cancelled = 0
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        renamingId="s2"
        onRename={(id) => renamed.push(id)}
        onCancelRename={() => {cancelled += 1}}
      />,
    )
    fireEvent.blur(screen.getByRole('textbox'))
    expect(cancelled).toBe(1)
    expect(renamed).toEqual([])
  })

  // 和主进程的 TITLE_MAX 一致，免得用户敲了一长串、回车之后被静默截断
  it('输入框限长 60', () => {
    render(<SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} renamingId="s2" />)
    expect((screen.getByRole('textbox') as HTMLInputElement).maxLength).toBe(60)
  })

  it('改名中的那一行点了不触发 onSelect', () => {
    const picked: string[] = []
    render(
      <SessionList
        groups={groups}
        currentId="s1"
        currentProjectId="p1"
        {...noop}
        renamingId="s2"
        onSelect={(id) => picked.push(id)}
      />,
    )
    fireEvent.click(screen.getByRole('textbox'))
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

  // 这条测试原来断言的是「裸图标、无文字」——那是更早的一次明确要求。
  // 后来要求整体对齐 gpui，而 gpui 的设置入口是侧边栏**底部一整行**
  // （齿轮 + 「设置」文字，见 rs/ui/src/sidebar.rs），所以前提整体换掉。
  //
  // 换位置的理由不只是「gpui 这样」：原来那个位置在右上角紧邻 macOS 红绿灯，
  // 既容易误点，也让「设置」看起来像窗口控件的一部分。
  it('设置入口在侧边栏底部，带图标和文字', () => {
    let opened = 0
    const { container } = render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} onOpenSettings={() => opened++} />,
    )
    const gear = screen.getByRole('button', { name: '设置' })
    expect(gear.textContent).toBe('设置')
    fireEvent.click(gear)
    expect(opened).toBe(1)
    // 在底部：它是 aside 的最后一个子元素，排在滚动区之后
    expect(container.querySelector('aside')!.lastElementChild).toBe(gear)
  })

  // 层级只用缩进表达，不画左引导线 —— gpui 侧是刻意不画的（sidebar.rs）：
  // 线紧贴圆角行背景，折叠展开时会看到线头从圆角里突出来。
  it('嵌套的会话列表不画左引导线', () => {
    const { container } = render(
      <SessionList groups={groups} currentId="s1" currentProjectId="p1" {...noop} />,
    )
    for (const el of container.querySelectorAll('ul, aside p')) {
      expect(el.className).not.toMatch(/border-l/)
    }
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
