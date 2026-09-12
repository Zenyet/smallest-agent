// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { ChatWindow } from '../../electron/renderer/src/components/ChatWindow'
import { LoadingState } from '../../electron/renderer/src/components/LoadingState'
import { StreamingText } from '../../electron/renderer/src/components/StreamingText'
import { chatReducer, type ChatState } from '../../electron/renderer/src/chat-reducer'

/** 所有测试的时间原点。固定值而不是 Date.now()，让失败信息可复现。 */
const BASE = 1_700_000_000_000

// 每条测试自带一个干净的假时钟。
//
// 必须在 beforeEach 里统一装：这一组里好几条都调 setSystemTime，而假时钟
// 是全局的 —— 上一条留下的系统时间会漏给下一条，让它算出的秒数莫名偏大
// （撞过一次：期望 3s 实际 6s，因为前一条把时钟推到了 +3s）。
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * 读出秒表那一格的文字。
 *
 * 不用 getByText('3s')：JSX 里 `{elapsed}s` 是**两个**文本节点（数字和 s
 * 各一个），testing-library 的文本匹配按单个节点来，永远匹配不到 "3s"。
 * 直接取那个 span 的 textContent（它会把子节点拼起来）。
 */
function seconds(container: HTMLElement): string | undefined {
  return container.querySelector('.tabular-nums')?.textContent ?? undefined
}

describe('「已等待 Ns」跨会话切换存活', () => {
  // ## 用户报的症状
  //
  // 「在响应中时切换会话，再回来，已等待会重置」。
  //
  // 根因：秒表原来是 LoadingState 自己 `useState(0)` + setInterval，从**组件
  // 挂载**起算。那等于把「这一轮开始于何时」和「这个组件何时被创建」划了
  // 等号 —— 而后者会因为纯 UI 的原因反复发生。切走再切回，ChatWindow 重新
  // 挂载，秒表归零：等了 40 秒，切个会话回来变成 2 秒。
  //
  // 修法：起点记进会话桶（startedAt），组件只负责「现在 - 起点」。

  it('user-sent 时记下这一轮的起点', () => {
    const t0 = BASE
    const s = chatReducer({}, { type: 'user-sent', sessionId: 's1', text: 'q' })
    expect(s.s1.startedAt).toBe(t0)
  })

  it('组件重新挂载后秒数不归零（起点在 state 里，不在组件里）', () => {
    const t0 = BASE

    // 第一次挂载：已经过了 40 秒
    vi.setSystemTime(t0 + 40_000)
    const first = render(<LoadingState startedAt={t0} />)
    expect(seconds(first.container)).toBe('40s')

    // 切走（卸载）、切回（重新挂载）—— 时钟又走了 2 秒
    first.unmount()
    vi.setSystemTime(t0 + 42_000)
    const again = render(<LoadingState startedAt={t0} />)

    // 关键断言：42s，不是重新从 0/2 开始
    expect(seconds(again.container)).toBe('42s')
  })

  it('每秒自己往前走', () => {
    const { container } = render(<LoadingState startedAt={BASE} />)
    expect(seconds(container)).toBe('0s')

    // 只用 advanceTimersByTime：它**同时**推进假时钟和触发 interval。
    // 再叠一个 setSystemTime(+3s) 的话时钟会走 6 秒（两者都推）——
    // 我第一版就是这么写的，断言 3s 拿到 6s。
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(seconds(container)).toBe('3s')
  })

  // 存时间戳而不是「每秒 +1」：后者本质上还是自己计数，切走那段时间没跑的
  // tick 永远补不回来（切回来接着从旧值 +1）。存时间戳则每次从真实时钟重算。
  it('组件卸载期间流逝的时间也算进去', () => {
    const t0 = BASE
    const view = render(<LoadingState startedAt={t0} />)
    view.unmount()
    // 卸载了 100 秒 —— 这段时间没有任何 tick 跑过
    vi.setSystemTime(t0 + 100_000)
    const again = render(<LoadingState startedAt={t0} />)
    expect(seconds(again.container)).toBe('100s')
  })

  // reload 之后主进程只知道「这个会话在跑」，不知道它什么时候开始的。
  // 那种情况下不显示秒数，而不是显示 0s（假装刚开始）或 NaN。
  it('没有起点时不显示秒数', () => {
    const { container } = render(<LoadingState />)
    expect(screen.getByText(/Agent 正在处理/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/\ds/)
  })

  it('ChatWindow 把会话桶里的起点交给指示器', () => {
    const t0 = BASE
    vi.setSystemTime(t0 + 7_000)
    const { container } = render(
      <ChatWindow
        chat={{ messages: [], running: true, startedAt: t0 }}
        sessionId="s1"
        onSend={() => {}}
        onDecide={() => {}}
      />,
    )
    expect(seconds(container)).toBe('7s')
  })
})

describe('live 指示槽位在整轮里高度稳定', () => {
  // 回归测试。原来 ThinkingState / LoadingState 各自条件渲染，于是模型一开始
  // 吐字（liveIdle 变 false）LoadingState 就整个卸载 —— 用户正在读的文字
  // 下面凭空少一块，内容跳一格。现在套了一个 running 期间常驻的槽位。
  const slot = (c: HTMLElement) => c.querySelector('.chat__scroll > .min-h-7')

  const win = (chat: Parameters<typeof ChatWindow>[0]['chat']) =>
    render(
      <ChatWindow chat={chat} sessionId="s1" onSend={() => {}} onDecide={() => {}} />,
    ).container

  it('纯等待态：槽位在，里面是 LoadingState', () => {
    const c = win({ messages: [], running: true, startedAt: BASE })
    expect(slot(c)).toBeTruthy()
    expect(screen.getByText(/Agent 正在处理/)).toBeTruthy()
  })

  it('开始吐字后槽位仍然在（这是原来会跳的那一下）', () => {
    const c = win({
      running: true,
      startedAt: BASE,
      messages: [
        { role: 'user', content: '问', tools: [], streaming: false },
        { role: 'assistant', content: '答到一半', tools: [], streaming: true },
      ],
    })
    // 里面已经空了（liveIdle 和 liveThinking 都是 false），但槽位本身还在撑高度
    expect(slot(c)).toBeTruthy()
    expect(screen.queryByText(/Agent 正在处理/)).toBeNull()
  })

  it('轮次结束后槽位卸载', () => {
    const c = win({
      running: false,
      messages: [{ role: 'assistant', content: '答完了', tools: [], streaming: false }],
    })
    expect(slot(c)).toBeNull()
  })
})

describe('工具调用只有一处表示', () => {
  const tool = {
    sessionId: 's1', turn: 1, toolName: 'fetch_url',
    args: { url: 'https://x.com' }, output: '{"ok":1}',
  }
  const win = (chat: Parameters<typeof ChatWindow>[0]['chat']) =>
    render(<ChatWindow chat={chat} sessionId="s1" onSend={() => {}} onDecide={() => {}} />)
      .container

  it('跑动中：工具只在气泡的 chip 里，底部不再有第二份', () => {
    // 回归测试。原来底部还有一个 ThinkingState 显示同一份 lastMsg.tools，
    // 于是同一批工具调用在界面上出现两处（用户报的就是这个）。
    const c = win({
      running: true, startedAt: BASE,
      messages: [
        { role: 'user', content: '看看这个', tools: [], streaming: false },
        { role: 'assistant', content: '', tools: [tool], streaming: true },
      ],
    })
    // chip 在气泡里，且是实时态
    const chips = c.querySelectorAll('.bubble .tool-group')
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toContain('正在调用 fetch_url')

    // 关键断言：工具名在**整页**只出现一次。
    //
    // 不能只查底部槽位里有没有 .tool-group —— 重复的那份是 ThinkingState，
    // 它有自己的一套标记，压根不带这个类名，那样断言等于没断言
    // （验证过：把 ThinkingState 加回去，测试照样绿）。按渲染出来的文本数
    // 才抓得住「同一份数据被画了两遍」，不管画它的是哪个组件。
    expect(screen.queryAllByText(/fetch_url/)).toHaveLength(1)
  })

  it('正文一开始出现，chip 就退回静态摘要', () => {
    // 工具早跑完了、模型在写字，这时还显示「正在调用 X」是错的。
    // 「还在生成」由 StreamingText 左边距那个转圈负责。
    const c = win({
      running: true, startedAt: BASE,
      messages: [
        { role: 'user', content: '看看这个', tools: [], streaming: false },
        { role: 'assistant', content: '读到了，内容是…', tools: [tool], streaming: true },
      ],
    })
    const chip = c.querySelector('.bubble .tool-group')!
    expect(chip.textContent).not.toContain('正在调用')
    expect(chip.textContent).toContain('本轮 1 次工具调用')
  })

  it('轮次结束后 chip 是静态的', () => {
    const c = win({
      running: false,
      messages: [{ role: 'assistant', content: '好了', tools: [tool], streaming: false }],
    })
    expect(c.querySelector('.bubble .tool-group')!.textContent).not.toContain('正在调用')
  })
})

describe('loading 图标在文本左侧', () => {
  // 用户的要求：「响应中应该改为在左侧的对话框文本左侧增加 loading icon」

  it('等待态：图标在文字之前', () => {
    const { container } = render(<LoadingState startedAt={BASE} />)
    const svg = container.querySelector('svg')!
    const text = screen.getByText(/Agent 正在处理/)
    // DOCUMENT_POSITION_FOLLOWING：text 在 svg 之后
    expect(svg.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // ## 为什么流式态也要一个
  //
  // 流式文字一出来，ChatWindow 的 liveIdle 变 false、整个「Agent 正在处理」
  // 指示消失，只剩一个闪动光标。而光标停在一段文字末尾时很难和「答完了」
  // 区分开 —— 用户盯着一段话，不知道它还会不会继续长。
  it('流式态：正文左侧有一个转动的指示', () => {
    const { container } = render(
      <StreamingText
        message={{ role: 'assistant', content: '我正在回答', tools: [], streaming: true }}
      />,
    )
    expect(container.querySelector('[aria-label="正在生成"]')).toBeTruthy()
  })

  it('流完之后那个指示消失', () => {
    const { container } = render(
      <StreamingText
        message={{ role: 'assistant', content: '答完了', tools: [], streaming: false }}
      />,
    )
    expect(container.querySelector('[aria-label="正在生成"]')).toBeNull()
  })

  // 光标和左侧图标是两个信号，不冲突：一个说「这条消息在生长」，
  // 一个指出「长到这里了」
  it('流式态两个信号并存', () => {
    const { container } = render(
      <StreamingText
        message={{ role: 'assistant', content: '写着', tools: [], streaming: true }}
      />,
    )
    expect(container.querySelector('[aria-label="正在生成"]')).toBeTruthy()
    expect(container.querySelector('.cursor')).toBeTruthy()
  })
})

describe('切走再切回时不再卡住', () => {
  // ## 用户报的第二半：「然后会一直卡在思考中，实际上过了很久已经响应完了，
  // 按 cmd+R 刷新整个 app 再点击之前的会话，已经响应完的内容渲染了」
  //
  // 「刷新之后内容在」说明那一轮早就答完并存了盘 —— 卡住的只是前端的
  // running 标志。原来它只能被事件清掉，而事件是「当时在场才收得到」；
  // 丢一个就永久卡死，因为 hydrate-running 只能点亮、不能熄灭。

  it('对齐时熄灭那个幽灵', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: 'q' })
    expect(s.s1.running).toBe(true)

    // 主进程说：没有任何会话在跑（那一轮的终止事件丢了/时序乱了）
    s = chatReducer(s, { type: 'reconcile-running', sessionIds: [] })
    expect(s.s1.running).toBe(false)
  })

  // select() 的顺序：先 reconcile 再 loaded。反过来的话 loaded 会先看到一个
  // 过期的 running=true，走「在跑就保留内存那份」的分支、拒绝这次磁盘历史 ——
  // 而磁盘上恰好是刚刚答完的完整内容。用户看到「切回来还在转圈，内容也没更新」。
  it('先对齐再放消息 —— 切回来能看到已经答完的内容', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '问题' })
    s = chatReducer(s, { type: 'chunk', event: { sessionId: 's1', text: '半句' } })

    // 切回来：主进程说这个会话没在跑了
    s = chatReducer(s, { type: 'reconcile-running', sessionIds: [] })
    // 然后放磁盘那份（完整的答案）
    s = chatReducer(s, {
      type: 'loaded',
      sessionId: 's1',
      messages: [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '完整的答案' },
      ],
    })

    expect(s.s1.running).toBe(false)
    expect(s.s1.messages.map((m) => m.content)).toEqual(['问题', '完整的答案'])
  })

  // 反面：真在跑的时候切回来，不能被磁盘那份旧历史覆盖
  it('真在跑时切回来仍然保住实时内容', () => {
    let s: ChatState = {}
    s = chatReducer(s, { type: 'user-sent', sessionId: 's1', text: '问题' })
    s = chatReducer(s, { type: 'chunk', event: { sessionId: 's1', text: '半句' } })

    s = chatReducer(s, { type: 'reconcile-running', sessionIds: ['s1'] })
    s = chatReducer(s, { type: 'loaded', sessionId: 's1', messages: [] })

    expect(s.s1.running).toBe(true)
    expect(s.s1.messages.map((m) => m.content)).toEqual(['问题', '半句'])
  })
})
