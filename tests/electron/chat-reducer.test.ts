import { describe, it, expect } from 'vitest'
import { chatReducer, type ChatState } from '../../electron/renderer/src/chat-reducer'
import type { ApprovalRequestEvent } from '../../electron/shared/channels'

const empty: ChatState = {}

// 连续 apply 一串 action，省得每个用例都嵌套调用
const apply = (state: ChatState, ...actions: Parameters<typeof chatReducer>[1][]) =>
  actions.reduce(chatReducer, state)

describe('chatReducer', () => {
  it('user-sent 追加用户消息并标记运行中', () => {
    const s = chatReducer(empty, { type: 'user-sent', sessionId: 's1', text: '你好' })
    expect(s.s1.messages).toEqual([
      { role: 'user', content: '你好', tools: [], streaming: false },
    ])
    expect(s.s1.running).toBe(true)
  })

  it('第一个 chunk 创建 assistant 消息，后续 chunk 累加', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'chunk', event: { sessionId: 's1', text: '北京' } },
      { type: 'chunk', event: { sessionId: 's1', text: '今天晴' } },
    )
    const last = s.s1.messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('北京今天晴')
    expect(last.streaming).toBe(true)
  })

  it('complete 用完整文本替换累积的 delta，保证最终一致', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'chunk', event: { sessionId: 's1', text: '部分' } },
      { type: 'complete', event: { sessionId: 's1', text: '完整答案' } },
    )
    const last = s.s1.messages.at(-1)!
    expect(last.content).toBe('完整答案')
    expect(last.streaming).toBe(false)
    expect(s.s1.running).toBe(false)
  })

  it('缓存命中时没有 chunk，complete 也要能建出 assistant 消息', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'cache-hit', event: { sessionId: 's1' } },
      { type: 'complete', event: { sessionId: 's1', text: '秒回' } },
    )
    expect(s.s1.messages.at(-1)).toMatchObject({ role: 'assistant', content: '秒回', cacheHit: true })
  })

  it('tool-call 挂到当前 assistant 消息上', () => {
    const tool = { sessionId: 's1', turn: 1, toolName: 'get_weather', args: {}, output: '{}' }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'tool-call', event: tool },
    )
    expect(s.s1.messages.at(-1)!.tools).toEqual([tool])
  })

  it('verdict 挂到最后一条 assistant 消息上', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'complete', event: { sessionId: 's1', text: 'a' } },
      { type: 'verdict', event: { sessionId: 's1', grounded: false, issues: ['没依据'] } },
    )
    expect(s.s1.messages.at(-1)!.verdict).toMatchObject({ grounded: false, issues: ['没依据'] })
  })

  it('事件按 sessionId 分桶，不会串到别的会话', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'a' },
      { type: 'user-sent', sessionId: 's2', text: 'b' },
      { type: 'chunk', event: { sessionId: 's1', text: 'X' } },
    )
    expect(s.s1.messages.at(-1)!.content).toBe('X')
    expect(s.s2.messages).toHaveLength(1)
    expect(s.s2.messages[0].role).toBe('user')
  })

  it('error 记录错误并结束运行状态', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'error', event: { sessionId: 's1', code: 'MODEL_ERROR', message: '挂了' } },
    )
    expect(s.s1.running).toBe(false)
    expect(s.s1.error).toEqual({ code: 'MODEL_ERROR', message: '挂了' })
  })

  it('BUSY 错误不清掉正在跑的那个会话的运行状态', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'error', event: { sessionId: 's2', code: 'BUSY', message: '忙' } },
    )
    expect(s.s1.running).toBe(true)
    expect(s.s2.error?.code).toBe('BUSY')
  })

  it('cancelled 结束运行状态但**不设 error**（用户主动停的不是错误）', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'cancelled', event: { sessionId: 's1' } },
    )
    expect(s.s1.running).toBe(false)
    // 这条是 cancelled 单独一个 action 而不是复用 error 的全部理由：
    // 走 error 会渲染出红色报错，而这本来就是用户要的结果
    expect(s.s1.error).toBeUndefined()
  })

  it('cancelled 保留已经流出来的文字（那是真实发生过的输出）', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'chunk', event: { sessionId: 's1', text: '答到一半' } },
      { type: 'cancelled', event: { sessionId: 's1' } },
    )
    expect(s.s1.messages.at(-1)?.content).toBe('答到一半')
  })

  it('cancelled 收掉悬着的审批弹窗', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      {
        type: 'approval-request',
        event: {
          sessionId: 's1',
          requestId: 'r1',
          toolName: 'write_file',
          args: {},
        } as ApprovalRequestEvent,
      },
      { type: 'cancelled', event: { sessionId: 's1' } },
    )
    expect(s.s1.pendingApproval).toBeUndefined()
  })

  it('loaded 用磁盘历史替换该会话的消息（切换会话时用）', () => {
    const s = chatReducer(empty, {
      type: 'loaded',
      sessionId: 's1',
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧答案' },
      ],
    })
    expect(s.s1.messages.map((m) => m.content)).toEqual(['旧问题', '旧答案'])
    expect(s.s1.running).toBe(false)
  })

  it('loaded 丢掉 tool 角色的消息（工具细节不在历史里回放）', () => {
    const s = chatReducer(empty, {
      type: 'loaded',
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'tool', content: '{}', name: 'get_weather', toolCallId: '1' },
        { role: 'assistant', content: 'a' },
      ],
    })
    expect(s.s1.messages).toHaveLength(2)
  })

  // --- Task 8.5 补充：写工具审批状态 ---
  // brief 写在 Task 8.5 之前，没有审批概念；这个 reducer 是事件变 UI 状态的唯一入口，
  // 所以现在就把 approval-request / approval-settled 加进来，而不是等 Task 12/13 再回来改。

  it('approval-request 把请求挂到对应会话的 pendingApproval 上', () => {
    const req: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: { path: 'a.md' },
    }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'approval-request', event: req },
    )
    expect(s.s1.pendingApproval).toEqual(req)
  })

  it('approval-settled 清空 pendingApproval', () => {
    const req: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: {},
    }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'approval-request', event: req },
      { type: 'approval-settled', sessionId: 's1', requestId: 'r1' },
    )
    expect(s.s1.pendingApproval).toBeUndefined()
  })

  it('会话 A 的审批请求不会出现在会话 B 的桶里', () => {
    const req: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: {},
    }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'a' },
      { type: 'user-sent', sessionId: 's2', text: 'b' },
      { type: 'approval-request', event: req },
    )
    expect(s.s1.pendingApproval).toEqual(req)
    expect(s.s2.pendingApproval).toBeUndefined()
  })

  it('approval-request / approval-settled 都不影响 running（等审批期间 agent 仍算运行中）', () => {
    const req: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: {},
    }
    const afterRequest = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'approval-request', event: req },
    )
    expect(afterRequest.s1.running).toBe(true)

    const afterSettled = chatReducer(afterRequest, { type: 'approval-settled', sessionId: 's1', requestId: 'r1' })
    expect(afterSettled.s1.running).toBe(true)
  })

  // --- Review 补充：完整性和防御性修复 ---

  it('complete 清掉 pendingApproval（这轮结束了，审批弹窗必然已失效）', () => {
    const req: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: {},
    }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'approval-request', event: req },
      { type: 'complete', event: { sessionId: 's1', text: '答案' } },
    )
    expect(s.s1.pendingApproval).toBeUndefined()
    expect(s.s1.running).toBe(false)
  })

  it('error 清掉 pendingApproval（这轮失败了，审批弹窗同样已失效）', () => {
    const req: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: {},
    }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'approval-request', event: req },
      { type: 'error', event: { sessionId: 's1', code: 'MODEL_ERROR', message: '挂了' } },
    )
    expect(s.s1.pendingApproval).toBeUndefined()
    expect(s.s1.running).toBe(false)
  })

  it('loaded 保留 pendingApproval 和 running（切换会话时不破坏正在跑的那轮）', () => {
    const req: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: {},
    }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'chunk', event: { sessionId: 's1', text: '部分' } },
      { type: 'approval-request', event: req },
    )
    // 在这个状态下回放历史（用户切到别的会话又切回来，select() 会重新拉一遍）
    const afterLoad = chatReducer(s, {
      type: 'loaded',
      sessionId: 's1',
      messages: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧答案' },
      ],
    })
    // ⚠️ 这条断言改过。原来断言的是 ['旧问题','旧答案'] —— 即「磁盘那份覆盖
    // 内存」。那和这个测试自己的名字矛盾：替换 messages 恰恰**破坏了**正在跑
    // 的那轮。存盘发生在 onComplete，所以这轮还在跑时磁盘上是上一轮的历史，
    // 覆盖下去用户的提问和已流出的字就没了，之后的 chunk 还会另起一条从半句
    // 开始累积。见 tests/electron/turn-state.test.ts 的缺陷 2。
    expect(afterLoad.s1.messages.map((m) => m.content)).toEqual(['q', '部分'])
    expect(afterLoad.s1.running).toBe(true) // 保留"正在跑"
    expect(afterLoad.s1.pendingApproval).toEqual(req) // 保留审批弹窗状态
    expect(afterLoad.s1.error).toBeUndefined() // error 不持久化，回放时清掉
  })

  it('approval-settled 只在 requestId 匹配时清空（防止迟到的 settled 清掉新请求）', () => {
    const req1: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'write_file',
      args: { path: 'a.md' },
    }
    const req2: ApprovalRequestEvent = {
      sessionId: 's1',
      requestId: 'r2',
      toolName: 'edit_file',
      args: { path: 'b.md' },
    }
    // 第一个请求弹窗，超时前用户没点，UI 已经为第二个请求弹了新窗
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'approval-request', event: req1 },
      { type: 'approval-request', event: req2 }, // 覆盖 req1（当前实现只支持一个槽）
    )
    expect(s.s1.pendingApproval?.requestId).toBe('r2')

    // 这时收到 req1 的迟到 settled —— 不该清掉 req2
    const afterStale = chatReducer(s, { type: 'approval-settled', sessionId: 's1', requestId: 'r1' })
    expect(afterStale.s1.pendingApproval?.requestId).toBe('r2')

    // 收到 req2 的 settled —— 才真正清掉
    const afterMatch = chatReducer(afterStale, { type: 'approval-settled', sessionId: 's1', requestId: 'r2' })
    expect(afterMatch.s1.pendingApproval).toBeUndefined()
  })

  it('完整的现实流程：user-sent → chunk → tool-call → chunk → complete → verdict', () => {
    const tool = { sessionId: 's1', turn: 1, toolName: 'search_notes', args: {}, output: '[]' }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'chunk', event: { sessionId: 's1', text: '让我' } },
      { type: 'tool-call', event: tool },
      { type: 'chunk', event: { sessionId: 's1', text: '查一下' } },
      { type: 'complete', event: { sessionId: 's1', text: '让我查一下。没找到相关笔记。' } },
      { type: 'verdict', event: { sessionId: 's1', grounded: true, issues: [] } },
    )
    expect(s.s1.messages).toHaveLength(2)
    expect(s.s1.messages[0]).toMatchObject({ role: 'user', content: 'q' })
    expect(s.s1.messages[1]).toMatchObject({
      role: 'assistant',
      content: '让我查一下。没找到相关笔记。',
      streaming: false,
      tools: [tool],
      verdict: { grounded: true, issues: [] },
    })
    expect(s.s1.running).toBe(false)
  })

  it('tool-call 在任何 chunk 之前到达时 withAssistant 仍能正确创建 assistant 消息', () => {
    const tool = { sessionId: 's1', turn: 1, toolName: 'read_file', args: {}, output: '{}' }
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'q' },
      { type: 'tool-call', event: tool }, // 模型直接调工具，没有前导文本
      { type: 'complete', event: { sessionId: 's1', text: '文件内容如下：...' } },
    )
    expect(s.s1.messages).toHaveLength(2)
    expect(s.s1.messages[1]).toMatchObject({
      role: 'assistant',
      content: '文件内容如下：...',
      tools: [tool],
    })
  })

  it('error 在已有状态的桶上触发（不只测从空状态开始）', () => {
    const s = apply(
      empty,
      { type: 'user-sent', sessionId: 's1', text: 'first' },
      { type: 'complete', event: { sessionId: 's1', text: 'ok' } },
      { type: 'user-sent', sessionId: 's1', text: 'second' },
      { type: 'chunk', event: { sessionId: 's1', text: '部分' } },
      { type: 'error', event: { sessionId: 's1', code: 'MAX_TURNS', message: '超限' } },
    )
    // user + assistant(ok) + user + assistant(部分，还在 streaming——error 到达时没有 complete 它)
    expect(s.s1.messages).toHaveLength(4)
    expect(s.s1.messages.at(-1)).toMatchObject({ role: 'assistant', content: '部分', streaming: true })
    expect(s.s1.error).toEqual({ code: 'MAX_TURNS', message: '超限' })
    expect(s.s1.running).toBe(false)
  })
})
