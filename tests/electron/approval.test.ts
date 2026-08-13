import { describe, it, expect } from 'vitest'
import { createApprovalGate, guardRegistry, WRITE_TOOLS } from '../../electron/main/approval'
import type { ApprovalRequestEvent } from '../../electron/shared/channels'
import type { Tool, ToolRegistry } from '../../src/types'

// 记录 run 是否真的被调到了 —— 审批的全部意义就是「拒绝时不执行」
function fakeTool(name: string, calls: string[]): Tool {
  return {
    name,
    description: name,
    parameters: {},
    run: async () => {
      calls.push(name)
      return `${name} done`
    },
  }
}

function setup() {
  const calls: string[] = []
  const requests: ApprovalRequestEvent[] = []
  const registry: ToolRegistry = {
    write_file: fakeTool('write_file', calls),
    read_file: fakeTool('read_file', calls),
    search_notes: fakeTool('search_notes', calls),
  }
  const gate = createApprovalGate()
  const guarded = guardRegistry(registry, 's1', gate, (e) => requests.push(e))
  return { calls, requests, gate, guarded }
}

describe('WRITE_TOOLS', () => {
  it('覆盖 fs server 的四个写操作', () => {
    for (const name of ['write_file', 'edit_file', 'create_directory', 'move_file']) {
      expect(WRITE_TOOLS.has(name)).toBe(true)
    }
  })

  it('不含只读工具（否则每次检索都要点一次确认，没人受得了）', () => {
    for (const name of ['read_file', 'list_directory', 'search_notes', 'get_weather']) {
      expect(WRITE_TOOLS.has(name)).toBe(false)
    }
  })
})

describe('guardRegistry', () => {
  it('只读工具直接执行，不发审批请求', async () => {
    const { calls, requests, guarded } = setup()
    await guarded.read_file.run({})
    await guarded.search_notes.run({})
    expect(calls).toEqual(['read_file', 'search_notes'])
    expect(requests).toEqual([])
  })

  it('保留原工具的 name/description/parameters（模型看到的定义不能变）', () => {
    const { guarded } = setup()
    expect(guarded.write_file.name).toBe('write_file')
    expect(guarded.write_file.description).toBe('write_file')
  })

  it('写工具先发审批请求，带 sessionId / toolName / args', async () => {
    const { requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    // 等一个微任务，让 run 内部走到发请求那步
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      sessionId: 's1',
      toolName: 'write_file',
      args: { path: 'a.md' },
    })
    gate.resolve(requests[0].requestId, 'allow')
    await pending
  })

  it('批准后执行原 run 并返回它的结果', async () => {
    const { calls, requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    gate.resolve(requests[0].requestId, 'allow')
    expect(await pending).toBe('write_file done')
    expect(calls).toEqual(['write_file'])
  })

  it('拒绝后绝不执行原 run，返回一个模型能读懂的拒绝说明', async () => {
    const { calls, requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    gate.resolve(requests[0].requestId, 'deny')
    const result = await pending
    // runTool 会把返回值 JSON.stringify 后喂回模型，所以这里返回结构化拒绝而不是抛错 ——
    // 抛错会被 runTool 包成 {"error":...}，模型可能理解成「工具坏了」而反复重试。
    expect(JSON.stringify(result)).toMatch(/denied|拒绝/)
    expect(calls).toEqual([])
  })

  it('每次请求的 requestId 都不同（一轮里可能多个写操作排队）', async () => {
    const { requests, gate, guarded } = setup()
    const a = guarded.write_file.run({ path: 'a.md' })
    const b = guarded.write_file.run({ path: 'b.md' })
    await Promise.resolve()
    expect(requests).toHaveLength(2)
    expect(requests[0].requestId).not.toBe(requests[1].requestId)
    gate.resolve(requests[0].requestId, 'allow')
    gate.resolve(requests[1].requestId, 'deny')
    await Promise.all([a, b])
  })

  it('pending() 报告还在等审批的请求（带 sessionId，方便按 session 清理），resolve 后清掉', async () => {
    const { requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    expect(gate.pending()).toHaveLength(1)
    expect(gate.pending()[0]).toMatchObject({
      requestId: requests[0].requestId,
      sessionId: 's1',
      toolName: 'write_file',
    })
    gate.resolve(requests[0].requestId, 'allow')
    await pending
    expect(gate.pending()).toEqual([])
  })

  it('resolve 一个不存在的 requestId 不抛错（用户在超时后又点了按钮）', () => {
    const { gate } = setup()
    expect(() => gate.resolve('ghost', 'allow')).not.toThrow()
  })

  it('同一个 requestId 重复 resolve 只生效第一次', async () => {
    const { calls, requests, gate, guarded } = setup()
    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    gate.resolve(requests[0].requestId, 'allow')
    gate.resolve(requests[0].requestId, 'deny') // 迟到的第二次，应被忽略
    await pending
    expect(calls).toEqual(['write_file'])
  })

  it.each(['edit_file', 'create_directory', 'move_file'])(
    '%s 也会先发审批请求，拒绝后不执行（不只 write_file 被拦，四个写工具都要拦）',
    async (name) => {
      const calls: string[] = []
      const requests: ApprovalRequestEvent[] = []
      const registry: ToolRegistry = { [name]: fakeTool(name, calls) }
      const gate = createApprovalGate()
      const guarded = guardRegistry(registry, 's1', gate, (e) => requests.push(e))

      const pending = guarded[name].run({})
      await Promise.resolve()
      expect(requests).toHaveLength(1)
      expect(requests[0].toolName).toBe(name)

      gate.resolve(requests[0].requestId, 'deny')
      const result = await pending
      expect(JSON.stringify(result)).toMatch(/denied|拒绝/)
      expect(calls).toEqual([])
    },
  )
})

describe('多 session 共用一个 gate（Task 13 要建的拓扑）', () => {
  it('两个 session 各自的 guardRegistry 并发工作，事件流里的 sessionId 不串台', async () => {
    const calls: string[] = []
    const requestsA: ApprovalRequestEvent[] = []
    const requestsB: ApprovalRequestEvent[] = []
    const registryA: ToolRegistry = { write_file: fakeTool('write_file', calls) }
    const registryB: ToolRegistry = { write_file: fakeTool('write_file', calls) }
    const gate = createApprovalGate()
    const guardedA = guardRegistry(registryA, 'sessionA', gate, (e) => requestsA.push(e))
    const guardedB = guardRegistry(registryB, 'sessionB', gate, (e) => requestsB.push(e))

    const pendingA = guardedA.write_file.run({ path: 'a.md' })
    const pendingB = guardedB.write_file.run({ path: 'b.md' })
    await Promise.resolve()

    expect(requestsA).toHaveLength(1)
    expect(requestsB).toHaveLength(1)
    expect(requestsA[0].sessionId).toBe('sessionA')
    expect(requestsB[0].sessionId).toBe('sessionB')
    // 各自的事件流互不干扰，一个 session 的回调数组里绝不该出现另一个 session 的事件
    expect(requestsA.some((r) => r.sessionId === 'sessionB')).toBe(false)
    expect(requestsB.some((r) => r.sessionId === 'sessionA')).toBe(false)

    gate.resolve(requestsA[0].requestId, 'allow')
    gate.resolve(requestsB[0].requestId, 'deny')
    expect(await pendingA).toBe('write_file done')
    expect(JSON.stringify(await pendingB)).toMatch(/denied|拒绝/)
    expect(calls).toEqual(['write_file'])
  })
})

describe('超时（fail-closed）', () => {
  // 用小的注入超时值，不用等真实的 5 分钟默认值。
  it('无人回应时超时自动结算为 deny，绝不能默认放行', async () => {
    const calls: string[] = []
    const registry: ToolRegistry = { write_file: fakeTool('write_file', calls) }
    const gate = createApprovalGate({ timeoutMs: 10 })
    const guarded = guardRegistry(registry, 's1', gate, () => {})

    const result = await guarded.write_file.run({ path: 'a.md' })
    expect(JSON.stringify(result)).toMatch(/denied|拒绝/)
    expect(calls).toEqual([])
  })

  it('用户在超时前已决定，超时定时器之后不会再次结算或产生副作用', async () => {
    const calls: string[] = []
    const requests: ApprovalRequestEvent[] = []
    const registry: ToolRegistry = { write_file: fakeTool('write_file', calls) }
    const gate = createApprovalGate({ timeoutMs: 20 })
    const guarded = guardRegistry(registry, 's1', gate, (e) => requests.push(e))

    const pending = guarded.write_file.run({ path: 'a.md' })
    await Promise.resolve()
    gate.resolve(requests[0].requestId, 'allow')
    expect(await pending).toBe('write_file done')

    // 等过超时窗口，确认定时器已被清理、没有迟到的第二次结算
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toEqual(['write_file'])
  })

  it('超时结算之后再调用 resolve 是迟到的决定，被忽略', async () => {
    const calls: string[] = []
    const requests: ApprovalRequestEvent[] = []
    const registry: ToolRegistry = { write_file: fakeTool('write_file', calls) }
    const gate = createApprovalGate({ timeoutMs: 10 })
    const guarded = guardRegistry(registry, 's1', gate, (e) => requests.push(e))

    const pending = guarded.write_file.run({ path: 'a.md' })
    const result = await pending // 已经因超时结算为 deny
    gate.resolve(requests[0].requestId, 'allow') // 迟到的决定，不应生效
    expect(JSON.stringify(result)).toMatch(/denied|拒绝/)
    expect(calls).toEqual([])
  })
})

describe('cancelSession', () => {
  it('只取消指定 session 的 pending 请求，按 deny 结算；其它 session 的请求不受影响', async () => {
    const calls: string[] = []
    const requestsA: ApprovalRequestEvent[] = []
    const requestsB: ApprovalRequestEvent[] = []
    const registryA: ToolRegistry = { write_file: fakeTool('write_file', calls) }
    const registryB: ToolRegistry = { write_file: fakeTool('write_file', calls) }
    // 超时设长一点，确保这里测的是 cancelSession 生效，不是超时兜底生效
    const gate = createApprovalGate({ timeoutMs: 5000 })
    const guardedA = guardRegistry(registryA, 'sessionA', gate, (e) => requestsA.push(e))
    const guardedB = guardRegistry(registryB, 'sessionB', gate, (e) => requestsB.push(e))

    const pendingA = guardedA.write_file.run({ path: 'a.md' })
    const pendingB = guardedB.write_file.run({ path: 'b.md' })
    await Promise.resolve()
    expect(gate.pending()).toHaveLength(2)

    gate.cancelSession('sessionA')
    const resultA = await pendingA
    expect(JSON.stringify(resultA)).toMatch(/denied|拒绝/)
    expect(calls).toEqual([]) // sessionA 的 run 从未真正执行

    // sessionB 的请求原样留在 pending 里，没被 sessionA 的取消误杀
    const remaining = gate.pending()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ sessionId: 'sessionB', requestId: requestsB[0].requestId })

    gate.resolve(requestsB[0].requestId, 'allow')
    expect(await pendingB).toBe('write_file done')
    expect(calls).toEqual(['write_file'])
  })

  it('cancelSession 是幂等的：重复调用、或对没有 pending 请求的 session 调用都不报错', () => {
    const gate = createApprovalGate()
    expect(() => gate.cancelSession('ghost-session')).not.toThrow()
    expect(() => gate.cancelSession('ghost-session')).not.toThrow()
  })
})
