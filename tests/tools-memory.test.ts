import { describe, it, expect } from 'vitest'
import { makeRememberTool } from '../src/tools/remember'
import { makeRecallTool } from '../src/tools/recall'
import { makeForgetTool } from '../src/tools/forget'
import type { Fact, FactScope } from '../src/memory/facts'

const T0 = Date.now()

/** 一个内存版的事实存储，替掉磁盘那份。 */
function fakeStore(initial: Fact[] = []) {
  let facts = [...initial]
  return {
    facts: () => facts,
    persist: (input: { key: string; value: string; scope: FactScope; sessionId?: string }) => {
      facts = facts.filter((f) => !(f.key === input.key && f.scope === input.scope))
      facts.push({ ...input, updatedAt: Date.now(), sourceSessionId: input.sessionId })
    },
    forget: (key: string, scope: FactScope) => {
      facts = facts.filter((f) => !(f.key === key && f.scope === scope))
    },
  }
}

describe('remember 工具', () => {
  it('记一条全局事实', async () => {
    const store = fakeStore()
    const tool = makeRememberTool({ persist: store.persist, sessionId: 's1', projectScope: null })
    const out = await tool.run({ key: 'user-location', value: '用户住在深圳', scope: 'global' })
    expect(out).toContain('已记下')
    expect(store.facts()[0].value).toBe('用户住在深圳')
  })

  it('记下来源会话（给人排查「这条哪来的」）', async () => {
    const store = fakeStore()
    const tool = makeRememberTool({ persist: store.persist, sessionId: 's42', projectScope: null })
    await tool.run({ key: 'k', value: 'v', scope: 'global' })
    expect(store.facts()[0].sourceSessionId).toBe('s42')
  })

  it('有项目作用域时 scope:"project" 落到那个目录', async () => {
    const store = fakeStore()
    const tool = makeRememberTool({
      persist: store.persist,
      sessionId: 's1',
      projectScope: 'project:/lab/x',
    })
    await tool.run({ key: 'build', value: '用 pnpm build', scope: 'project' })
    expect(store.facts()[0].scope).toBe('project:/lab/x')
  })

  // ## 这一条锁的是「静默丢数据」那个 bug
  //
  // 实测撞到过：用户说「我最近在用 Rust 写命令行工具」，模型合理地判断这是
  // 项目信息、选了 scope:"project"，而未分组会话没有工作目录 —— 旧实现
  // **返回一条错误、什么都不记**。那条事实就消失了，而用户以为记住了。
  //
  // 降级到 global 是更好的失败模式：作用域偏大 vs 直接丢数据。
  it('要 project 但没有工作目录时降级到 global，不丢数据', async () => {
    const store = fakeStore()
    const tool = makeRememberTool({ persist: store.persist, sessionId: 's1', projectScope: null })
    const out = await tool.run({ key: 'proj', value: '在写一个 Rust 工具', scope: 'project' })

    expect(store.facts()).toHaveLength(1)
    expect(store.facts()[0].scope).toBe('global')
    // 返回值要说明降级了 —— 模型可以在回答里提一句
    expect(out).toContain('全局')
  })

  it('空 key 或空 value 不写入', async () => {
    const store = fakeStore()
    const tool = makeRememberTool({ persist: store.persist, sessionId: 's1', projectScope: null })
    await tool.run({ key: '  ', value: 'v', scope: 'global' })
    await tool.run({ key: 'k', value: '  ', scope: 'global' })
    expect(store.facts()).toHaveLength(0)
  })
})

describe('recall 工具', () => {
  it('没有事实时说清楚，不返回空串', async () => {
    const store = fakeStore()
    const tool = makeRecallTool({ getAllFacts: store.facts, projectScope: null })
    expect(await tool.run({})).toContain('还没有记下任何事实')
  })

  it('列出全局 + 当前项目的，别的项目不给', async () => {
    const store = fakeStore([
      { key: 'a', value: '全局那条', scope: 'global', updatedAt: T0 },
      { key: 'b', value: 'X 项目的', scope: 'project:/x', updatedAt: T0 },
      { key: 'c', value: 'Y 项目的', scope: 'project:/y', updatedAt: T0 },
    ])
    const tool = makeRecallTool({ getAllFacts: store.facts, projectScope: 'project:/x' })
    const listed = String(await tool.run({}))
    expect(listed).toContain('全局那条')
    expect(listed).toContain('X 项目的')
    // 「Y 项目的」出现在 X 项目的对话里是噪音，还会误导模型
    expect(listed).not.toContain('Y 项目的')
  })

  // forget 的描述里写着「先调 recall 看到 key」—— 那句话成立的前提是
  // recall 真的把 key 输出了
  it('输出带 key（forget 要用它来删）', async () => {
    const store = fakeStore([
      { key: 'user-location', value: '用户住在深圳', scope: 'global', updatedAt: T0 },
    ])
    const tool = makeRecallTool({ getAllFacts: store.facts, projectScope: null })
    expect(String(await tool.run({}))).toContain('user-location')
  })
})

describe('forget 工具', () => {
  it('删掉指定的那条', async () => {
    const store = fakeStore([
      { key: 'a', value: '1', scope: 'global', updatedAt: T0 },
      { key: 'b', value: '2', scope: 'global', updatedAt: T0 },
    ])
    const tool = makeForgetTool({
      forget: store.forget,
      getAllFacts: store.facts,
      projectScope: null,
    })
    await tool.run({ key: 'a', scope: 'global' })
    expect(store.facts().map((f) => f.key)).toEqual(['b'])
  })

  // ## 不确认存在的话会静默成功
  //
  // 模型以为自己删掉了什么，下一轮发现那条还在 —— 可能反复重试。
  // 明确告诉它「没找到」，它才会去调 recall 看真实的 key。
  it('key 不存在时说清楚，并提示去调 recall', async () => {
    const store = fakeStore([{ key: 'a', value: '1', scope: 'global', updatedAt: T0 }])
    const tool = makeForgetTool({
      forget: store.forget,
      getAllFacts: store.facts,
      projectScope: null,
    })
    const out = String(await tool.run({ key: 'nope', scope: 'global' }))
    expect(out).toContain('没有找到')
    expect(out).toContain('recall')
    // 什么都没删
    expect(store.facts()).toHaveLength(1)
  })

  it('只删指定作用域的那条', async () => {
    const store = fakeStore([
      { key: 'pkg', value: 'npm', scope: 'global', updatedAt: T0 },
      { key: 'pkg', value: 'pnpm', scope: 'project:/x', updatedAt: T0 },
    ])
    const tool = makeForgetTool({
      forget: store.forget,
      getAllFacts: store.facts,
      projectScope: 'project:/x',
    })
    await tool.run({ key: 'pkg', scope: 'project' })
    expect(store.facts()).toHaveLength(1)
    expect(store.facts()[0].scope).toBe('global')
  })

  it('空 key 不动任何东西', async () => {
    const store = fakeStore([{ key: 'a', value: '1', scope: 'global', updatedAt: T0 }])
    const tool = makeForgetTool({
      forget: store.forget,
      getAllFacts: store.facts,
      projectScope: null,
    })
    await tool.run({ key: '   ', scope: 'global' })
    expect(store.facts()).toHaveLength(1)
  })
})
