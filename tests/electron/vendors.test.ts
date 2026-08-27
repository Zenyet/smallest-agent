import { describe, it, expect } from 'vitest'
import {
  ALL,
  CUSTOM_API_KEY,
  CUSTOM_BASE_URL,
  CUSTOM_ID,
  CUSTOM_MODELS,
  CUSTOM_NAME,
  CUSTOM_SEARCH_TOOL,
  DEFAULT_VENDOR,
  apiKeySetting,
  catalog,
  defaultModel,
  entry,
  exists,
  find,
  firstConfigured,
  isConfigured,
  keyEnvs,
  nameOf,
  parseModels,
  resolveSelection,
  type Lookup,
} from '../../electron/main/vendors'

// 造一个 Lookup：settings 用一份 map 模拟。
function fromMap(m: Record<string, string>): Lookup {
  return (key) => m[key]
}

describe('内置厂商目录', () => {
  it('DeepSeek 排第一——老配置（只有 DEEPSEEK_API_KEY）升级后行为不变', () => {
    expect(ALL[0].id).toBe('deepseek')
    expect(DEFAULT_VENDOR).toBe('deepseek')
  })

  // 这条是这个文件不用碰 src/ 的前提：DeepSeek 的 key 名必须是
  // src/config.ts 已经在读的那个，换了名字整条兼容性就断了
  it('DeepSeek 的 key 名和 src/config.ts 读的环境变量一致', () => {
    expect(find('deepseek')?.keyEnv).toBe('DEEPSEEK_API_KEY')
  })

  it('九家厂商 id 互不相同', () => {
    const ids = ALL.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('九家厂商 key 键名互不相同（同时配好几家不会互相覆盖）', () => {
    const keys = ALL.map((v) => v.keyEnv)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('每家至少有一个模型，且第一个是默认模型', () => {
    for (const v of ALL) {
      expect(v.models.length).toBeGreaterThan(0)
      expect(defaultModel(v.id)).toBe(v.models[0].id)
    }
  })

  it('keyEnvs 返回全部九家的键名', () => {
    expect(keyEnvs()).toHaveLength(ALL.length)
  })
})

describe('exists / find / nameOf', () => {
  it('认识内置厂商和自定义端点', () => {
    expect(exists('deepseek')).toBe(true)
    expect(exists(CUSTOM_ID)).toBe(true)
    expect(exists('不存在的厂商')).toBe(false)
  })

  it('nameOf 对自定义端点也有返回，调用方不用特判', () => {
    expect(nameOf(CUSTOM_ID)).toBe(CUSTOM_NAME)
    expect(nameOf('anthropic')).toBe('Anthropic')
    expect(nameOf('不存在的厂商')).toBeUndefined()
  })

  it('apiKeySetting 对自定义端点返回 CUSTOM_API_KEY', () => {
    expect(apiKeySetting(CUSTOM_ID)).toBe(CUSTOM_API_KEY)
    expect(apiKeySetting('deepseek')).toBe('DEEPSEEK_API_KEY')
    expect(apiKeySetting('不存在的厂商')).toBeUndefined()
  })
})

describe('parseModels', () => {
  it('按中英文逗号、分号、换行切', () => {
    expect(parseModels('a,b，c;d；e\nf\rg').map((m) => m.id)).toEqual([
      'a', 'b', 'c', 'd', 'e', 'f', 'g',
    ])
  })

  it('去掉每一项前后空白', () => {
    expect(parseModels(' a , b ').map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('丢掉空白项', () => {
    expect(parseModels('a,,b,  ,c')).toHaveLength(3)
  })

  // qwen2.5:14b 这类 id 里没有空格，但用户可能写成 "llama3.1 (本地)"，
  // 按空格切会切出一个叫 "(本地)" 的模型
  it('不按空格切', () => {
    expect(parseModels('llama3.1 (本地)').map((m) => m.id)).toEqual(['llama3.1 (本地)'])
  })

  it('去重——粘两遍很常见，重复项在选择器里会一起高亮', () => {
    expect(parseModels('a,b,a').map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('空字符串得到空数组', () => {
    expect(parseModels('')).toEqual([])
  })
})

describe('entry', () => {
  it('内置厂商解析出完整的 VendorEntry', () => {
    const e = entry('anthropic', fromMap({}))!
    expect(e.id).toBe('anthropic')
    expect(e.baseUrl).toBe('https://api.anthropic.com/v1')
    expect(e.models.length).toBeGreaterThan(0)
  })

  it('认不出的 id 返回 undefined', () => {
    expect(entry('不存在的厂商', fromMap({}))).toBeUndefined()
  })

  it('自定义端点：地址末尾斜杠被去掉', () => {
    const e = entry(CUSTOM_ID, fromMap({ [CUSTOM_BASE_URL]: 'http://localhost:11434/v1/' }))!
    expect(e.baseUrl).toBe('http://localhost:11434/v1')
  })

  it('自定义端点：模型清单来自 CUSTOM_MODELS', () => {
    const e = entry(CUSTOM_ID, fromMap({ [CUSTOM_MODELS]: 'llama3,qwen2.5' }))!
    expect(e.models.map((m) => m.id)).toEqual(['llama3', 'qwen2.5'])
  })

  it('自定义端点：没填搜索工具时是 none', () => {
    const e = entry(CUSTOM_ID, fromMap({}))!
    expect(e.nativeSearch).toEqual({ kind: 'none' })
  })

  it('自定义端点：填了搜索工具时是 tool-type', () => {
    const e = entry(CUSTOM_ID, fromMap({ [CUSTOM_SEARCH_TOOL]: 'openrouter:web_search' }))!
    expect(e.nativeSearch).toEqual({ kind: 'tool-type', toolType: 'openrouter:web_search' })
  })
})

describe('catalog', () => {
  it('九家内置厂商总是在列，哪怕一把 key 都没配', () => {
    const list = catalog(fromMap({}))
    expect(list).toHaveLength(ALL.length)
  })

  it('自定义端点只在填了模型清单时才出现', () => {
    expect(catalog(fromMap({}))).toHaveLength(ALL.length)
    expect(catalog(fromMap({ [CUSTOM_MODELS]: 'llama3' }))).toHaveLength(ALL.length + 1)
  })
})

describe('isConfigured', () => {
  it('内置厂商：填了 key 就算配好', () => {
    expect(isConfigured('deepseek', fromMap({}))).toBe(false)
    expect(isConfigured('deepseek', fromMap({ DEEPSEEK_API_KEY: 'sk-x' }))).toBe(true)
  })

  it('只有空白的 key 不算配好', () => {
    expect(isConfigured('deepseek', fromMap({ DEEPSEEK_API_KEY: '   ' }))).toBe(false)
  })

  it('自定义端点：地址 + 模型都要有，key 可以没有', () => {
    expect(isConfigured(CUSTOM_ID, fromMap({}))).toBe(false)
    expect(isConfigured(CUSTOM_ID, fromMap({ [CUSTOM_BASE_URL]: 'http://x' }))).toBe(false)
    expect(
      isConfigured(
        CUSTOM_ID,
        fromMap({ [CUSTOM_BASE_URL]: 'http://x', [CUSTOM_MODELS]: 'm1' }),
      ),
    ).toBe(true)
  })
})

describe('firstConfigured', () => {
  it('没配任何一家时返回 undefined', () => {
    expect(firstConfigured(fromMap({}))).toBeUndefined()
  })

  it('按 ALL 的顺序找第一个配好的', () => {
    // anthropic 排在 deepseek 后面，即使只配了 anthropic 也不该被跳过，
    // 但如果两个都配了，deepseek 应该赢
    expect(firstConfigured(fromMap({ ANTHROPIC_API_KEY: 'x' }))).toBe('anthropic')
    expect(
      firstConfigured(fromMap({ DEEPSEEK_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })),
    ).toBe('deepseek')
  })

  it('自定义端点排最后——内置厂商优先保住老配置的行为', () => {
    expect(
      firstConfigured(
        fromMap({
          [CUSTOM_BASE_URL]: 'http://x',
          [CUSTOM_MODELS]: 'm1',
          ANTHROPIC_API_KEY: 'y',
        }),
      ),
    ).toBe('anthropic')
  })
})

describe('resolveSelection', () => {
  it('内置厂商配好时解析出完整凭据', () => {
    const r = resolveSelection(
      { vendorId: 'anthropic', model: 'claude-opus-5' },
      fromMap({ ANTHROPIC_API_KEY: 'sk-ant' }),
    )
    expect(r).toEqual({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-opus-5',
      nativeSearch: { kind: 'none' },
    })
  })

  it('认不出的厂商抛错', () => {
    expect(() => resolveSelection({ vendorId: 'x', model: 'm' }, fromMap({}))).toThrow(
      /没有叫/,
    )
  })

  it('自定义端点没填地址时抛错，报出缺的是地址', () => {
    expect(() =>
      resolveSelection({ vendorId: CUSTOM_ID, model: 'm1' }, fromMap({ [CUSTOM_MODELS]: 'm1' })),
    ).toThrow(/端点还没填地址/)
  })

  it('没选模型时抛错，报出缺的是模型', () => {
    expect(() =>
      resolveSelection(
        { vendorId: 'anthropic', model: '' },
        fromMap({ ANTHROPIC_API_KEY: 'x' }),
      ),
    ).toThrow(/还没选模型/)
    expect(() =>
      resolveSelection(
        { vendorId: 'anthropic', model: '   ' },
        fromMap({ ANTHROPIC_API_KEY: 'x' }),
      ),
    ).toThrow(/还没选模型/)
  })

  // 缺东西必须抛错而不是静默回落——静默回落的后果是用户选了 Anthropic、
  // 界面上显示 Anthropic，实际却在用别的厂商回答，这个错完全看不见
  it('内置厂商没配 key 时抛错，报出去哪领', () => {
    expect(() =>
      resolveSelection({ vendorId: 'anthropic', model: 'claude-opus-5' }, fromMap({})),
    ).toThrow(/console\.anthropic\.com/)
  })

  it('自定义端点不要求 key——本地服务不校验 authorization', () => {
    const r = resolveSelection(
      { vendorId: CUSTOM_ID, model: 'llama3' },
      fromMap({ [CUSTOM_BASE_URL]: 'http://localhost:11434/v1', [CUSTOM_MODELS]: 'llama3' }),
    )
    expect(r.apiKey).toBe('')
    expect(r.baseUrl).toBe('http://localhost:11434/v1')
  })

  it('换厂商换搜索能力：GLM 带 tool-type', () => {
    const r = resolveSelection(
      { vendorId: 'glm', model: 'glm-4.6' },
      fromMap({ ZHIPU_API_KEY: 'x' }),
    )
    expect(r.nativeSearch).toEqual({ kind: 'tool-type', toolType: 'web_search' })
  })
})

// ## 这一组锁的是一个真 bug（实测撞到过）
//
// 少了「模型必须属于这家厂商」这条校验，{anthropic, deepseek-reasoner} 会
// 一路通过，然后拿 Anthropic 的地址 + Anthropic 的 key + DeepSeek 的模型名
// 去请求，服务端回「Invalid Anthropic API Key」—— 指向完全错误的方向：
// key 是好的，错的是模型名。用户会去反复检查那把 key。
describe('resolveSelection：厂商和模型必须配对', () => {
  const get = (key: string): string | undefined =>
    ({ ANTHROPIC_API_KEY: 'sk-ant', DEEPSEEK_API_KEY: 'sk-ds' })[key]

  it('模型不属于该厂商时抛错，而不是发一个注定 401 的请求', () => {
    expect(() =>
      resolveSelection({ vendorId: 'anthropic', model: 'deepseek-reasoner' }, get),
    ).toThrow(/没有叫「deepseek-reasoner」的模型/)
  })

  it('报错里列出这家真支持哪些模型（不然用户不知道该填什么）', () => {
    expect(() =>
      resolveSelection({ vendorId: 'anthropic', model: '瞎写的' }, get),
    ).toThrow(/claude-opus-5/)
  })

  it('配对正确时正常解析', () => {
    const out = resolveSelection({ vendorId: 'anthropic', model: 'claude-opus-5' }, get)
    expect(out.model).toBe('claude-opus-5')
    expect(out.baseUrl).toContain('anthropic')
    expect(out.apiKey).toBe('sk-ant')
  })

  // 自定义端点的清单是用户自己填的一行字符串，我们没有权威清单可比
  it('自定义端点豁免这条校验', () => {
    const customGet = (key: string): string | undefined =>
      ({ CUSTOM_BASE_URL: 'http://localhost:11434/v1', CUSTOM_MODELS: 'llama3' })[key]
    expect(() =>
      resolveSelection({ vendorId: 'custom', model: '清单里没有的' }, customGet),
    ).not.toThrow()
  })
})
