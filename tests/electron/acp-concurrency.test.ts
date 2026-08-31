import { describe, it, expect } from 'vitest'
import { resolveTurnOwner, type TurnSlots } from '../../electron/main/provider/acp'

// ============================================================================
// 这一组锁的是「并发之后 ACP 的审批归属」。
//
// 背景：串行锁改成按会话之后（agent-runner.ts），多个会话可以同时跑。而
// 外部 CLI 的 provider 实例是按 (provider, 模型) 缓存的 —— 两个会话都走
// Claude Code 时**共用一条连接、一个子进程**。
//
// 权限请求的 handler 注册在连接上（onRequest 是连接级的），所以它必须能从
// 请求本身判断「这次审批属于我们哪个会话」。原来那里是一个单格子
// （`let slot: { sessionId } | null`），每轮开始时覆盖 —— 在全局锁下没问题，
// 同时只有一轮。并发之后后开的那轮会把格子覆盖掉，于是前一轮的权限请求
// 被记到后一个会话名下：用户在 B 会话看到一个 A 会话要写文件的确认框，
// 点了之后 A 那边才动。
//
// 现在按 ACP 那侧的 sessionId 查表。用它而不是我们的 id，因为权限请求的
// 载荷里带的是那一个（RequestPermissionRequest.sessionId）。
// ============================================================================

describe('ACP 审批归属', () => {
  it('按 ACP sessionId 查到对应的会话', () => {
    const slots: TurnSlots = new Map([['acp-1', { sessionId: 'ours-a' }]])
    expect(resolveTurnOwner(slots, 'acp-1')).toEqual({ sessionId: 'ours-a' })
  })

  // ## 这是那个缺陷的核心
  //
  // 两轮同时在跑，各自的权限请求必须各回各家
  it('两个会话同时在跑时，各自的审批不串台', () => {
    const slots: TurnSlots = new Map([
      ['acp-1', { sessionId: 'ours-a' }],
      ['acp-2', { sessionId: 'ours-b' }],
    ])
    expect(resolveTurnOwner(slots, 'acp-1')?.sessionId).toBe('ours-a')
    expect(resolveTurnOwner(slots, 'acp-2')?.sessionId).toBe('ours-b')
  })

  // 后开的一轮不能覆盖先开的那一轮 —— 单格子实现的症结正在这里
  it('后开的轮次不覆盖先开的', () => {
    const slots: TurnSlots = new Map()
    slots.set('acp-1', { sessionId: 'ours-a' })
    slots.set('acp-2', { sessionId: 'ours-b' })
    // 先开那个还在
    expect(resolveTurnOwner(slots, 'acp-1')?.sessionId).toBe('ours-a')
  })

  // 一轮结束时只该删自己那一格。原来是 `slot = null` —— 并发之后那等于
  // 把别的会话正在跑的那轮也一起抹掉，它的权限请求随后会查不到归属、
  // 被保守拒绝（用户那边表现为「点了没反应，agent 说它没权限」）
  it('一轮结束只删自己那一格，不影响还在跑的', () => {
    const slots: TurnSlots = new Map([
      ['acp-1', { sessionId: 'ours-a' }],
      ['acp-2', { sessionId: 'ours-b' }],
    ])
    slots.delete('acp-1')
    expect(resolveTurnOwner(slots, 'acp-1')).toBeNull()
    // 另一轮不受影响
    expect(resolveTurnOwner(slots, 'acp-2')?.sessionId).toBe('ours-b')
  })

  // 查不到就返回 null，调用方据此拒绝 —— 不能批准一个不知道归属的写操作
  it('查不到归属时返回 null（调用方会拒绝）', () => {
    const slots: TurnSlots = new Map([['acp-1', { sessionId: 'ours-a' }]])
    expect(resolveTurnOwner(slots, 'acp-unknown')).toBeNull()
    expect(resolveTurnOwner(new Map(), 'acp-1')).toBeNull()
  })

  // 同一个会话的第二轮复用同一个 ACP session（sessions 那张表按我们的
  // sessionId 缓存），所以覆盖同一个键是正常的、不是 bug
  it('同一会话连续两轮复用同一个键', () => {
    const slots: TurnSlots = new Map()
    slots.set('acp-1', { sessionId: 'ours-a' })
    slots.set('acp-1', { sessionId: 'ours-a' })
    expect(slots.size).toBe(1)
    expect(resolveTurnOwner(slots, 'acp-1')?.sessionId).toBe('ours-a')
  })
})
