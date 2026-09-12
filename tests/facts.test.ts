import { describe, it, expect } from 'vitest'
import {
  MAX_FACTS_PER_SCOPE,
  MAX_VALUE_LEN,
  factsFor,
  forgetFact,
  normalizeFacts,
  renderFacts,
  scopeFor,
  upsertFact,
  type Fact,
} from '../src/memory/facts'

const T0 = 1_700_000_000_000
const g = (key: string, value: string, at = T0): Fact => ({
  key,
  value,
  scope: 'global',
  updatedAt: at,
})

describe('scopeFor', () => {
  it('有工作目录时给项目作用域', () => {
    expect(scopeFor('/Users/me/lab/x')).toBe('project:/Users/me/lab/x')
  })

  // 未分组会话只有全局事实
  it('没有工作目录时返回 null', () => {
    expect(scopeFor(undefined)).toBeNull()
    expect(scopeFor('')).toBeNull()
    expect(scopeFor('   ')).toBeNull()
  })
})

describe('upsertFact', () => {
  it('写入一条新事实', () => {
    const after = upsertFact([], { key: 'user-location', value: '深圳', scope: 'global' }, T0)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ key: 'user-location', value: '深圳', scope: 'global' })
  })

  // ## key 是整个设计的核心：同 key 覆盖，不是新增
  //
  // 没有它的话「用户在深圳」和「用户住深圳」是两条，一个月后 200 条里
  // 大半是近义重复，全在吃上下文预算
  it('同 key 同作用域是覆盖', () => {
    let facts = upsertFact([], { key: 'user-location', value: '深圳', scope: 'global' }, T0)
    facts = upsertFact(facts, { key: 'user-location', value: '北京', scope: 'global' }, T0 + 1000)
    expect(facts).toHaveLength(1)
    expect(facts[0].value).toBe('北京')
    expect(facts[0].updatedAt).toBe(T0 + 1000)
  })

  it('key 大小写和空白不敏感（避免 User-Location 和 user-location 变两条）', () => {
    let facts = upsertFact([], { key: 'User-Location', value: '深圳', scope: 'global' }, T0)
    facts = upsertFact(facts, { key: '  user-location  ', value: '北京', scope: 'global' }, T0 + 1)
    expect(facts).toHaveLength(1)
    expect(facts[0].value).toBe('北京')
  })

  // 同 key 不同作用域是**两条不同的事实**：「这个项目用 pnpm」和
  // 「我一般用 npm」可以并存
  it('同 key 不同作用域各自独立', () => {
    let facts = upsertFact([], { key: 'pkg-manager', value: 'npm', scope: 'global' }, T0)
    facts = upsertFact(facts, { key: 'pkg-manager', value: 'pnpm', scope: 'project:/x' }, T0)
    expect(facts).toHaveLength(2)
  })

  it('空 key 或空 value 不写入，原样返回（调用方靠引用比较跳过写盘）', () => {
    const before: Fact[] = []
    expect(upsertFact(before, { key: '', value: 'x', scope: 'global' }, T0)).toBe(before)
    expect(upsertFact(before, { key: 'k', value: '  ', scope: 'global' }, T0)).toBe(before)
  })

  it('超长 value 截断', () => {
    const after = upsertFact([], { key: 'k', value: 'x'.repeat(500), scope: 'global' }, T0)
    expect(after[0].value).toHaveLength(MAX_VALUE_LEN)
  })

  it('记下来源会话（给人排查「这条哪来的」）', () => {
    const after = upsertFact([], { key: 'k', value: 'v', scope: 'global', sessionId: 's1' }, T0)
    expect(after[0].sourceSessionId).toBe('s1')
  })
})

describe('淘汰', () => {
  it('超上限时丢最旧的', () => {
    let facts: Fact[] = []
    for (let i = 0; i < MAX_FACTS_PER_SCOPE + 5; i++) {
      facts = upsertFact(facts, { key: `k${i}`, value: `v${i}`, scope: 'global' }, T0 + i)
    }
    expect(facts).toHaveLength(MAX_FACTS_PER_SCOPE)
    // 最早那 5 条没了
    expect(facts.find((f) => f.key === 'k0')).toBeUndefined()
    expect(facts.find((f) => f.key === 'k4')).toBeUndefined()
    // 最新的还在
    expect(facts.find((f) => f.key === `k${MAX_FACTS_PER_SCOPE + 4}`)).toBeDefined()
  })

  // 全局事实不该因为某个项目记太多而被挤掉
  it('淘汰只在同作用域内算', () => {
    let facts: Fact[] = [g('important', '别丢我', T0 - 999999)]
    for (let i = 0; i < MAX_FACTS_PER_SCOPE + 10; i++) {
      facts = upsertFact(facts, { key: `k${i}`, value: `v${i}`, scope: 'project:/x' }, T0 + i)
    }
    // 那条很旧的全局事实还在
    expect(facts.find((f) => f.key === 'important')).toBeDefined()
    expect(facts.filter((f) => f.scope === 'project:/x')).toHaveLength(MAX_FACTS_PER_SCOPE)
  })
})

describe('forgetFact', () => {
  it('删掉指定的那条', () => {
    const facts = [g('a', '1'), g('b', '2')]
    const after = forgetFact(facts, 'a', 'global')
    expect(after.map((f) => f.key)).toEqual(['b'])
  })

  it('不存在时原样返回同一个对象', () => {
    const facts = [g('a', '1')]
    expect(forgetFact(facts, 'nope', 'global')).toBe(facts)
  })

  it('只删指定作用域的那条', () => {
    const facts: Fact[] = [
      g('pkg', 'npm'),
      { key: 'pkg', value: 'pnpm', scope: 'project:/x', updatedAt: T0 },
    ]
    const after = forgetFact(facts, 'pkg', 'global')
    expect(after).toHaveLength(1)
    expect(after[0].scope).toBe('project:/x')
  })
})

describe('factsFor —— 这一轮该看见哪些', () => {
  const facts: Fact[] = [
    g('loc', '深圳'),
    { key: 'build', value: 'pnpm build', scope: 'project:/x', updatedAt: T0 },
    { key: 'build', value: 'make', scope: 'project:/y', updatedAt: T0 },
  ]

  it('全局 + 当前项目', () => {
    const got = factsFor(facts, 'project:/x')
    expect(got.map((f) => f.value).sort()).toEqual(['pnpm build', '深圳'])
  })

  // 「A 仓库用 pnpm」出现在 B 仓库的对话里是噪音，还会误导模型
  it('别的项目的事实不给', () => {
    const got = factsFor(facts, 'project:/x')
    expect(got.find((f) => f.value === 'make')).toBeUndefined()
  })

  it('未分组会话只拿全局的', () => {
    const got = factsFor(facts, null)
    expect(got.map((f) => f.value)).toEqual(['深圳'])
  })
})

describe('renderFacts', () => {
  it('空数组返回空串（调用方据此跳过拼接）', () => {
    expect(renderFacts([], 1000)).toBe('')
  })

  it('渲染成可读的一段', () => {
    const out = renderFacts([g('loc', '用户在深圳')], 1000)
    expect(out).toContain('用户在深圳')
    expect(out).toContain('你记得的事实')
  })

  // ## 预算：注入的东西要能被限住
  //
  // 不限的话记忆会挤掉历史，两边加起来超窗 —— 而 compactMessages 不知道
  // 系统提示里多了东西
  it('超预算时截断，保留最新的', () => {
    const facts: Fact[] = []
    for (let i = 0; i < 50; i++) facts.push(g(`k${i}`, `这是第 ${i} 条比较长的事实内容`, T0 + i))
    const out = renderFacts(facts, 80)
    // 最新那条在，最旧那条被截掉了
    expect(out).toContain('第 49 条')
    expect(out).not.toContain('第 0 条')
  })

  it('预算极小时返回空串，不返回只有标题的空壳', () => {
    expect(renderFacts([g('k', '很长很长的一条事实内容在这里')], 5)).toBe('')
  })

  it('新鲜的排在前面', () => {
    const out = renderFacts([g('old', '旧事实', T0), g('new', '新事实', T0 + 9999)], 1000)
    expect(out.indexOf('新事实')).toBeLessThan(out.indexOf('旧事实'))
  })

  it('包含使用指引，强调优先使用已知事实', () => {
    const out = renderFacts([g('loc', '用户在深圳')], 1000)
    expect(out).toContain('请在回答时优先使用这些事实')
    expect(out).toContain('重要提示')
    expect(out).toContain('回答问题前，先检查上面的事实是否已经包含答案')
    expect(out).toContain('优先使用已知的位置信息')
    expect(out).toContain('不要重复询问你已经知道的信息')
  })
})

describe('normalizeFacts —— 磁盘上那份是人可以手改的', () => {
  it('丢掉畸形条目而不是整个崩掉', () => {
    const got = normalizeFacts([
      { key: 'ok', value: '好的', scope: 'global', updatedAt: T0 },
      null,
      'not an object',
      { key: '', value: '空 key', scope: 'global' },
      { key: 'no-value', value: '', scope: 'global' },
      { key: 'bad-scope', value: 'x', scope: 'whatever' },
    ])
    expect(got).toHaveLength(1)
    expect(got[0].key).toBe('ok')
  })

  it('不是数组时返回空', () => {
    expect(normalizeFacts(null)).toEqual([])
    expect(normalizeFacts({ nope: 1 })).toEqual([])
  })

  // 时间戳坏了当「很久以前」：它会排最后、最先被截断，但内容不丢
  it('坏时间戳不丢那条事实', () => {
    const got = normalizeFacts([{ key: 'k', value: 'v', scope: 'global', updatedAt: 'oops' }])
    expect(got).toHaveLength(1)
    expect(got[0].updatedAt).toBe(0)
  })

  it('project 作用域认得出来', () => {
    const got = normalizeFacts([{ key: 'k', value: 'v', scope: 'project:/x', updatedAt: T0 }])
    expect(got[0].scope).toBe('project:/x')
  })
})
