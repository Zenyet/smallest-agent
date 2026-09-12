import { describe, it, expect } from 'vitest'
import { makeExtractor, parseExtracted, rememberSucceeded, resolveScope } from '../src/memory/extract'
import type { Fact } from '../src/memory/facts'
import type { Message, ModelResult } from '../src/types'

// ============================================================================
// 自动抽取事实
//
// 这是记忆可靠性的第二道保险。第一道（remember 工具）是概率性的 —— 实测过
// 同一句话在干净会话里记得下、在有干扰历史的会话里就漏掉。
//
// parseExtracted 的每条容错分支都对应一种**实际见过的**模型输出形状，
// 所以这一组测试的价值主要在那些「畸形输入」的用例上。
// ============================================================================

describe('parseExtracted —— 必须容错', () => {
  it('干净的 JSON 数组', () => {
    const got = parseExtracted('[{"key":"user-location","value":"用户住在深圳","scope":"global"}]')
    expect(got).toEqual([{ key: 'user-location', value: '用户住在深圳', scope: 'global' }])
  })

  it('空数组（最常见的结果 —— 多数轮次没有事实）', () => {
    expect(parseExtracted('[]')).toEqual([])
  })

  // 模型很爱包这个，尤其是被要求「输出 JSON」的时候
  it('剥掉 markdown 代码块', () => {
    const got = parseExtracted('```json\n[{"key":"k","value":"v","scope":"global"}]\n```')
    expect(got).toHaveLength(1)
  })

  it('剥掉不带语言标记的代码块', () => {
    expect(parseExtracted('```\n[]\n```')).toEqual([])
  })

  // 「好的，我抽取到以下事实：[...]」
  it('忽略 JSON 前后的解释文字', () => {
    const got = parseExtracted(
      '好的，我从对话中抽取到以下事实：\n[{"key":"k","value":"v","scope":"global"}]\n希望有帮助！',
    )
    expect(got).toHaveLength(1)
    expect(got[0].key).toBe('k')
  })

  // 只有一条时模型偶尔不套数组
  it('单个对象当成一条处理，而不是丢掉', () => {
    const got = parseExtracted('{"key":"k","value":"v","scope":"global"}')
    expect(got).toEqual([{ key: 'k', value: 'v', scope: 'global' }])
  })

  it('彻底不是 JSON 时返回空数组，不抛', () => {
    expect(parseExtracted('我没有找到任何值得记住的事实。')).toEqual([])
    expect(parseExtracted('')).toEqual([])
  })

  it('数组里的畸形项跳过，好的留下', () => {
    const got = parseExtracted(
      '[{"key":"ok","value":"好的","scope":"global"},null,"字符串",{"key":"","value":"空key"},{"key":"nv","value":""}]',
    )
    expect(got).toHaveLength(1)
    expect(got[0].key).toBe('ok')
  })

  it('key 统一小写（避免 User-Location 和 user-location 变两条）', () => {
    expect(parseExtracted('[{"key":"User-Location","value":"v","scope":"global"}]')[0].key).toBe(
      'user-location',
    )
  })

  // scope 缺失或写错时当 global：全局事实在所有会话可见，最坏情况是多看到
  // 一条，而不是该看到却看不到
  it('scope 缺失或非法时当 global', () => {
    expect(parseExtracted('[{"key":"k","value":"v"}]')[0].scope).toBe('global')
    expect(parseExtracted('[{"key":"k","value":"v","scope":"whatever"}]')[0].scope).toBe('global')
  })

  it('scope 是 project 时保留', () => {
    expect(parseExtracted('[{"key":"k","value":"v","scope":"project"}]')[0].scope).toBe('project')
  })

  it('value 前后空白去掉', () => {
    expect(parseExtracted('[{"key":"k","value":"  用户住在深圳  ","scope":"global"}]')[0].value).toBe(
      '用户住在深圳',
    )
  })

  // value 里带方括号时，「截取第一个 [ 到最后一个 ]」仍然要对
  it('value 里有方括号不影响解析', () => {
    const got = parseExtracted('[{"key":"k","value":"用户用 arr[0] 这种写法","scope":"global"}]')
    expect(got[0].value).toBe('用户用 arr[0] 这种写法')
  })
})

describe('resolveScope', () => {
  it('global 就是 global', () => {
    expect(resolveScope('global', 'project:/x')).toBe('global')
  })

  it('project 落到当前项目', () => {
    expect(resolveScope('project', 'project:/lab/x')).toBe('project:/lab/x')
  })

  // 和 remember 工具里同一个决定：作用域偏大好过丢掉这条事实
  it('要 project 但没有工作目录时降级到 global', () => {
    expect(resolveScope('project', null)).toBe('global')
  })
})

describe('makeExtractor', () => {
  const fakeModel = (text: string) => async (): Promise<ModelResult> => ({ text, toolCalls: [] })

  it('把抽取结果交出来', async () => {
    const extract = makeExtractor(
      fakeModel('[{"key":"user-location","value":"用户住在深圳","scope":"global"}]'),
    )
    const got = await extract({ userMessage: '我住深圳', answer: '好的', existing: [] })
    expect(got).toEqual([{ key: 'user-location', value: '用户住在深圳', scope: 'global' }])
  })

  // ## 已有事实必须进 prompt
  //
  // 不给的话它会反复抽出同一件事：用户三次提到「我在深圳」就抽三次
  it('已有事实带进 prompt，让它别重复抽', async () => {
    let seen = ''
    const extract = makeExtractor(async (messages: Message[]) => {
      seen = messages.map((m) => m.content).join('\n')
      return { text: '[]', toolCalls: [] }
    })
    const existing: Fact[] = [
      { key: 'user-location', value: '用户住在深圳', scope: 'global', updatedAt: 0 },
    ]
    await extract({ userMessage: '今天天气', answer: '晴', existing })

    expect(seen).toContain('user-location')
    expect(seen).toContain('用户住在深圳')
  })

  it('没有已有事实时也说清楚（不是一段空白）', async () => {
    let seen = ''
    const extract = makeExtractor(async (messages: Message[]) => {
      seen = messages.map((m) => m.content).join('\n')
      return { text: '[]', toolCalls: [] }
    })
    await extract({ userMessage: 'q', answer: 'a', existing: [] })
    expect(seen).toContain('还没有记住任何事实')
  })

  // 回答也要给 —— 用来消解指代（「那我用它吧」里的「它」）
  it('用户消息和回答都进 prompt', async () => {
    let seen = ''
    const extract = makeExtractor(async (messages: Message[]) => {
      seen = messages.map((m) => m.content).join('\n')
      return { text: '[]', toolCalls: [] }
    })
    await extract({ userMessage: '那我用它吧', answer: '推荐你用 pnpm', existing: [] })
    expect(seen).toContain('那我用它吧')
    expect(seen).toContain('推荐你用 pnpm')
  })

  it('模型输出垃圾时返回空数组，不抛', async () => {
    const extract = makeExtractor(fakeModel('抱歉我无法完成这个任务'))
    await expect(
      extract({ userMessage: 'q', answer: 'a', existing: [] }),
    ).resolves.toEqual([])
  })
})


describe('rememberSucceeded —— 短路的判据', () => {
  // ## 这一组锁的是「两条路都没记上」那个 bug
  //
  // 实测撞到过：remember 工具不可用，模型调了、拿到
  // `{"error":"unknown tool: remember"}`，而短路只看「调过没」，
  // 于是抽取也被跳过 —— 那条事实两条路都丢了。
  it('失败的调用不算成功（否则短路会吃掉抽取那条路）', () => {
    expect(rememberSucceeded('{"error":"unknown tool: remember"}')).toBe(false)
  })

  it('工具内部抛错也不算', () => {
    expect(rememberSucceeded('{"error":"磁盘满了"}')).toBe(false)
  })

  it('正常返回算成功', () => {
    expect(rememberSucceeded('"已记下：用户住在深圳（全局）"')).toBe(true)
  })

  // 输出不是我们那套错误信封时当成功 —— 更可能是工具正常返回的东西
  it('不是 JSON 时当成功', () => {
    expect(rememberSucceeded('已记下')).toBe(true)
  })

  it('普通对象（没有 error 字段）算成功', () => {
    expect(rememberSucceeded('{"ok":true}')).toBe(true)
  })
})
