import { describe, it, expect } from 'vitest'
import {
  BUILTIN_ID,
  DEFAULT_PERMISSION,
  assignBuiltinModel,
  assignModel,
  assignPermission,
  assignProvider,
  builtinModelFor,
  emptyProvidersState,
  exampleProvidersState,
  forgetSession,
  modelFor,
  modelsFor,
  normalizeProvidersState,
  permissionFor,
  providerFor,
  providerOptions,
  resolveLaunch,
  splitVendorModel,
  toggleProvider,
  toPermissionMode,
  type ProvidersState,
} from '../../electron/main/providers'

// 一份典型状态：两家外部 CLI，一家带模型清单、一家不带（用它的默认模型）
const state = (over: Partial<ProvidersState> = {}): ProvidersState => ({
  ...emptyProvidersState(),
  external: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
      models: [
        { id: 'claude-opus-5', name: 'Claude Opus 5', env: { ANTHROPIC_MODEL: 'claude-opus-5' } },
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', env: { ANTHROPIC_MODEL: 'claude-sonnet-5' } },
      ],
    },
    { id: 'pi', name: 'Pi', command: 'npx', args: ['-y', 'pi-acp@latest'] },
  ],
  ...over,
})

describe('splitVendorModel', () => {
  it('按第一个斜杠切开', () => {
    expect(splitVendorModel('anthropic/claude-opus-5')).toEqual({
      vendorId: 'anthropic',
      modelId: 'claude-opus-5',
    })
  })

  // 1M 后缀里没有斜杠，但万一模型 id 带上了，切第一个才对
  it('模型 id 里有斜杠时只切第一个', () => {
    expect(splitVendorModel('custom/org/model')).toEqual({
      vendorId: 'custom',
      modelId: 'org/model',
    })
  })

  it('切不开的返回 null（脏数据，调用方回落到默认）', () => {
    expect(splitVendorModel('没有斜杠')).toBeNull()
    expect(splitVendorModel('/开头就是斜杠')).toBeNull()
    expect(splitVendorModel('结尾是斜杠/')).toBeNull()
    expect(splitVendorModel('')).toBeNull()
  })
})

describe('toPermissionMode', () => {
  it('认得三档', () => {
    expect(toPermissionMode('readonly')).toBe('readonly')
    expect(toPermissionMode('auto')).toBe('auto')
    expect(toPermissionMode('ask')).toBe('ask')
  })

  // 认不出的落到最安全那档 —— 手改坏了不该变成「不问直接放行」
  it('认不出的落到 ask，不是 auto', () => {
    expect(toPermissionMode('乱写')).toBe('ask')
    expect(toPermissionMode(undefined)).toBe('ask')
    expect(toPermissionMode(null)).toBe('ask')
    expect(toPermissionMode(1)).toBe('ask')
  })
})

describe('normalizeProvidersState', () => {
  it('不是对象就给空状态', () => {
    expect(normalizeProvidersState(null)).toEqual(emptyProvidersState())
    expect(normalizeProvidersState('字符串')).toEqual(emptyProvidersState())
    expect(normalizeProvidersState(undefined)).toEqual(emptyProvidersState())
  })

  // 没有 command 起不了进程、没有 id 没法绑定 —— 留个残缺条目在选择器里，
  // 用户选了才发现起不来
  it('丢掉没有 id 或没有 command 的条目', () => {
    const out = normalizeProvidersState({
      external: [
        { id: 'ok', name: 'OK', command: 'npx' },
        { name: '没有 id', command: 'npx' },
        { id: '没有命令' },
        { id: '', command: 'npx' },
        { id: 'x', command: '' },
        '不是对象',
        null,
      ],
    })
    expect(out.external.map((e) => e.id)).toEqual(['ok'])
  })

  // 占用内置那个 id 会让选择器里两项同 id，选中判断指向错的那个
  it('丢掉占用内置 id 的条目', () => {
    const out = normalizeProvidersState({
      external: [{ id: BUILTIN_ID, name: '冒名', command: 'npx' }],
    })
    expect(out.external).toEqual([])
  })

  // 重复 id 会让「按 id 找 provider」取决于遍历顺序，而缓存键也是 id
  it('同 id 只留第一个', () => {
    const out = normalizeProvidersState({
      external: [
        { id: 'dup', name: '先', command: 'a' },
        { id: 'dup', name: '后', command: 'b' },
      ],
    })
    expect(out.external).toHaveLength(1)
    expect(out.external[0].name).toBe('先')
  })

  it('没写 name 就用 id 顶上（空标签比 id 更糟）', () => {
    const out = normalizeProvidersState({ external: [{ id: 'my-cli', command: 'npx' }] })
    expect(out.external[0].name).toBe('my-cli')
  })

  it('模型没写 name 也用 id 顶上', () => {
    const out = normalizeProvidersState({
      external: [{ id: 'a', command: 'x', models: [{ id: 'm1' }] }],
    })
    expect(out.external[0].models?.[0]).toEqual({ id: 'm1', name: 'm1' })
  })

  it('丢掉没有 id 的模型', () => {
    const out = normalizeProvidersState({
      external: [{ id: 'a', command: 'x', models: [{ name: '只有名字' }, { id: 'ok' }] }],
    })
    expect(out.external[0].models?.map((m) => m.id)).toEqual(['ok'])
  })

  // ## 这几条是这个函数存在的理由
  //
  // 指向已删 provider 的绑定不清掉的话，那个会话既不属于任何外部 provider、
  // 也不显示成内置 —— 选择器上是空的，用户不知道点发送会走哪条路。
  it('清掉指向已删 provider 的会话绑定', () => {
    const out = normalizeProvidersState({
      external: [{ id: 'alive', name: 'A', command: 'x' }],
      sessionProvider: { s1: 'alive', s2: '已经删了的', s3: BUILTIN_ID },
    })
    expect(out.sessionProvider).toEqual({ s1: 'alive', s3: BUILTIN_ID })
  })

  it('内置 id 的绑定要留着（它永远存在）', () => {
    const out = normalizeProvidersState({ sessionProvider: { s1: BUILTIN_ID } })
    expect(out.sessionProvider).toEqual({ s1: BUILTIN_ID })
  })

  // 模型 id 只在它所属的 provider 里唯一，所以要先知道绑的是哪个 provider
  it('清掉指向已删模型的绑定', () => {
    const out = normalizeProvidersState({
      external: [{ id: 'p', name: 'P', command: 'x', models: [{ id: 'm1', name: 'M1' }] }],
      sessionProvider: { s1: 'p', s2: 'p' },
      sessionModel: { s1: 'm1', s2: '被删掉的模型' },
    })
    expect(out.sessionModel).toEqual({ s1: 'm1' })
  })

  it('没绑 provider 的会话不该有模型绑定', () => {
    const out = normalizeProvidersState({
      external: [{ id: 'p', name: 'P', command: 'x', models: [{ id: 'm1', name: 'M1' }] }],
      sessionModel: { s1: 'm1' },
    })
    expect(out.sessionModel).toEqual({})
  })

  it('绑在内置上的会话不该有外部模型绑定', () => {
    const out = normalizeProvidersState({
      sessionProvider: { s1: BUILTIN_ID },
      sessionModel: { s1: '什么模型' },
    })
    expect(out.sessionModel).toEqual({})
  })

  it('没声明模型清单的 provider 不该有模型绑定（用它的默认模型）', () => {
    const out = normalizeProvidersState({
      external: [{ id: 'p', name: 'P', command: 'x' }],
      sessionProvider: { s1: 'p' },
      sessionModel: { s1: '猜的模型' },
    })
    expect(out.sessionModel).toEqual({})
  })

  // 内置模型只校验形状，不校验厂商是否存在 —— 那要 import vendors.ts，
  // 而厂商清单会随用户配的自定义端点变化，在这里判会把合法绑定误删
  it('内置模型只校验形状，认不出的厂商也留着', () => {
    const out = normalizeProvidersState({
      builtinModel: { s1: 'anthropic/claude-opus-5', s2: '没有斜杠', s3: '未知厂商/某模型' },
    })
    expect(out.builtinModel).toEqual({
      s1: 'anthropic/claude-opus-5',
      s3: '未知厂商/某模型',
    })
  })

  it('权限只存非默认值，默认那档不落盘', () => {
    const out = normalizeProvidersState({
      sessionPermission: { s1: 'readonly', s2: 'ask', s3: 'auto', s4: '乱写' },
    })
    expect(out.sessionPermission).toEqual({ s1: 'readonly', s3: 'auto' })
  })

  // ## 旧格式迁移
  //
  // 老配置里 disabled 挂在每个 external 上，新格式是顶层黑名单。
  // 不迁移的话，已经在用的人升级后五家会突然全部冒出来 —— 而他可能特意
  // 留着 disabled（装了但不想在这个 app 里用）。那是「升级悄悄改了我的配置」。
  it('把旧的 disabled: true 迁移进 disabledProviders', () => {
    const out = normalizeProvidersState({
      external: [
        { id: 'a', name: 'A', command: 'x' },
        { id: 'b', name: 'B', command: 'x', disabled: true },
      ],
    })
    expect(out.disabledProviders).toEqual(['b'])
    // 迁移完不再写回 external —— 留一份的话用户想启用得改两个地方，
    // 而他只看得到一个
    expect(out.external.some((e) => e.disabled)).toBe(false)
  })

  it('迁移是幂等的（迁完再 normalize 一次结果不变）', () => {
    const once = normalizeProvidersState({
      external: [{ id: 'b', name: 'B', command: 'x', disabled: true }],
    })
    expect(normalizeProvidersState(once)).toEqual(once)
  })

  it('两个来源合并，不互相覆盖', () => {
    const out = normalizeProvidersState({
      external: [
        { id: 'a', name: 'A', command: 'x' },
        { id: 'b', name: 'B', command: 'x', disabled: true },
      ],
      disabledProviders: ['a'],
    })
    expect([...out.disabledProviders].sort()).toEqual(['a', 'b'])
  })

  // 黑名单里留着已删 provider 的 id 没意义，而且会随每次写盘一直堆积
  it('黑名单里认不出的 id 清掉', () => {
    const out = normalizeProvidersState({
      external: [{ id: 'a', name: 'A', command: 'x' }],
      disabledProviders: ['a', '已经删了的', ''],
    })
    expect(out.disabledProviders).toEqual(['a'])
  })

  it('defaultProvider 指向不存在的就丢掉', () => {
    expect(normalizeProvidersState({ defaultProvider: '不存在' }).defaultProvider).toBeUndefined()
    expect(normalizeProvidersState({ defaultProvider: BUILTIN_ID }).defaultProvider).toBe(BUILTIN_ID)
  })
})

describe('providerFor', () => {
  it('绑过就用绑的那个', () => {
    expect(providerFor(state({ sessionProvider: { s1: 'pi' } }), 's1')).toBe('pi')
  })

  it('没绑过用 defaultProvider', () => {
    expect(providerFor(state({ defaultProvider: 'claude-code' }), 's1')).toBe('claude-code')
  })

  it('都没有就用内置', () => {
    expect(providerFor(state(), 's1')).toBe(BUILTIN_ID)
  })
})

describe('modelsFor / modelFor', () => {
  it('内置不走这套（模型来自 vendors.ts）', () => {
    expect(modelsFor(state(), BUILTIN_ID)).toEqual([])
  })

  it('不存在的 provider 给空', () => {
    expect(modelsFor(state(), '不存在')).toEqual([])
  })

  it('给出那家声明的清单', () => {
    expect(modelsFor(state(), 'claude-code').map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ])
  })

  // 让「显示的」和「打勾的」是同一项 —— 否则打开下拉会看到按钮上写着 A
  // 而列表里勾在别处
  it('没绑定时给第一个，不是 undefined', () => {
    const s = state({ sessionProvider: { s1: 'claude-code' } })
    expect(modelFor(s, 's1')).toBe('claude-opus-5')
  })

  it('绑过就给绑的那个', () => {
    const s = state({
      sessionProvider: { s1: 'claude-code' },
      sessionModel: { s1: 'claude-sonnet-5' },
    })
    expect(modelFor(s, 's1')).toBe('claude-sonnet-5')
  })

  it('绑的模型已经不在清单里时回落到第一个', () => {
    const s = state({
      sessionProvider: { s1: 'claude-code' },
      sessionModel: { s1: '被删了' },
    })
    expect(modelFor(s, 's1')).toBe('claude-opus-5')
  })

  it('没声明清单的 provider 返回 undefined（用它的默认模型）', () => {
    const s = state({ sessionProvider: { s1: 'pi' } })
    expect(modelFor(s, 's1')).toBeUndefined()
  })
})

describe('builtinModelFor', () => {
  it('没绑定返回 null（调用方用设置里的 ACTIVE_VENDOR）', () => {
    expect(builtinModelFor(state(), 's1')).toBeNull()
  })

  it('绑定了就拆开给出', () => {
    const s = state({ builtinModel: { s1: 'anthropic/claude-opus-5' } })
    expect(builtinModelFor(s, 's1')).toEqual({
      vendorId: 'anthropic',
      modelId: 'claude-opus-5',
    })
  })
})

describe('permissionFor', () => {
  it('没设过就是默认那档', () => {
    expect(permissionFor(state(), 's1')).toBe(DEFAULT_PERMISSION)
    expect(permissionFor(state(), 's1')).toBe('ask')
  })

  it('设过就用设的', () => {
    expect(permissionFor(state({ sessionPermission: { s1: 'auto' } }), 's1')).toBe('auto')
  })
})

describe('providerOptions', () => {
  // 内置永远在：它不需要配置也不会起不来，是那个「至少有一个能用」的保底
  it('内置永远第一个', () => {
    const opts = providerOptions(emptyProvidersState())
    expect(opts).toHaveLength(1)
    expect(opts[0]).toEqual({ id: BUILTIN_ID, name: '内置 agent', external: false })
  })

  it('外部 CLI 跟在后面，标成 external', () => {
    const opts = providerOptions(state())
    expect(opts.map((o) => o.id)).toEqual([BUILTIN_ID, 'claude-code', 'pi'])
    expect(opts.slice(1).every((o) => o.external)).toBe(true)
  })

  // 默认全部可选 —— 这是和原来相反的默认值（原来模板里全带 disabled: true，
  // 结果用户以为功能不存在）。见 providers.ts 里 disabledProviders 的注释。
  it('默认（黑名单为空）时配好的 CLI 全部可选', () => {
    const s = state({
      external: [
        { id: 'a', name: 'A', command: 'x' },
        { id: 'b', name: 'B', command: 'x' },
      ],
    })
    expect(providerOptions(s).map((o) => o.id)).toEqual([BUILTIN_ID, 'a', 'b'])
  })

  it('黑名单里的不出现在选择器里', () => {
    const s = state({
      external: [
        { id: 'on', name: '开着', command: 'x' },
        { id: 'off', name: '关着', command: 'x' },
      ],
      disabledProviders: ['off'],
    })
    expect(providerOptions(s).map((o) => o.id)).toEqual([BUILTIN_ID, 'on'])
  })

  it('内置 agent 不受黑名单影响（那是「至少有一个能用」的保底）', () => {
    const s = state({ external: [], disabledProviders: [BUILTIN_ID] })
    expect(providerOptions(s).map((o) => o.id)).toEqual([BUILTIN_ID])
  })
})

describe('resolveLaunch', () => {
  it('不存在的 provider 返回 null', () => {
    expect(resolveLaunch(state(), '不存在')).toBeNull()
  })

  it('不带模型时就是 provider 自己那份', () => {
    expect(resolveLaunch(state(), 'pi')).toEqual({
      command: 'npx',
      args: ['-y', 'pi-acp@latest'],
      env: {},
    })
  })

  // 模型是通过子进程的 env/args 传的 —— 协议里没有模型选择
  it('模型的 env 追加进去', () => {
    const out = resolveLaunch(state(), 'claude-code', 'claude-sonnet-5')
    expect(out?.env).toEqual({ ANTHROPIC_MODEL: 'claude-sonnet-5' })
    expect(out?.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp@latest'])
  })

  it('模型的 args 追加在 provider 的后面', () => {
    const s = state({
      external: [
        {
          id: 'codex',
          name: 'Codex',
          command: 'npx',
          args: ['-y', 'codex-acp'],
          models: [{ id: 'gpt-5.2', name: 'GPT-5.2', args: ['--model', 'gpt-5.2'] }],
        },
      ],
    })
    expect(resolveLaunch(s, 'codex', 'gpt-5.2')?.args).toEqual([
      '-y',
      'codex-acp',
      '--model',
      'gpt-5.2',
    ])
  })

  // 用户在模型上写同名变量就是要覆盖 provider 级的那个
  it('同名环境变量以模型的为准', () => {
    const s = state({
      external: [
        {
          id: 'p',
          name: 'P',
          command: 'x',
          env: { ANTHROPIC_MODEL: 'provider 级', OTHER: '保留' },
          models: [{ id: 'm', name: 'M', env: { ANTHROPIC_MODEL: '模型级' } }],
        },
      ],
    })
    expect(resolveLaunch(s, 'p', 'm')?.env).toEqual({
      ANTHROPIC_MODEL: '模型级',
      OTHER: '保留',
    })
  })

  it('认不出的模型 id 当没传（用 provider 的默认）', () => {
    const out = resolveLaunch(state(), 'claude-code', '不存在的模型')
    expect(out?.env).toEqual({})
  })

  it('带 cwd 的原样给出', () => {
    const s = state({ external: [{ id: 'p', name: 'P', command: 'x', cwd: '/tmp/工作区' }] })
    expect(resolveLaunch(s, 'p')?.cwd).toBe('/tmp/工作区')
  })
})

describe('写操作', () => {
  it('assignProvider 记下绑定', () => {
    const out = assignProvider(state(), 's1', 'pi')
    expect(providerFor(out, 's1')).toBe('pi')
  })

  // 模型 id 只在它所属的 provider 里有意义。不清的话 modelFor 会拿旧 id 去和
  // 新 provider 的清单比 —— 比不中就回落到第一个，看着像「换引擎顺手换了模型」
  it('assignProvider 顺手清掉旧的模型绑定', () => {
    const s = state({
      sessionProvider: { s1: 'claude-code' },
      sessionModel: { s1: 'claude-sonnet-5' },
    })
    const out = assignProvider(s, 's1', 'pi')
    expect(out.sessionModel).toEqual({})
  })

  it('assignProvider 不动别的会话', () => {
    const s = state({ sessionModel: { s2: 'claude-opus-5' } })
    expect(assignProvider(s, 's1', 'pi').sessionModel).toEqual({ s2: 'claude-opus-5' })
  })

  it('assignModel 记下模型', () => {
    const s = assignModel(state({ sessionProvider: { s1: 'claude-code' } }), 's1', 'claude-sonnet-5')
    expect(modelFor(s, 's1')).toBe('claude-sonnet-5')
  })

  it('assignBuiltinModel 存成 厂商/模型', () => {
    const out = assignBuiltinModel(state(), 's1', 'anthropic', 'claude-opus-5')
    expect(out.builtinModel.s1).toBe('anthropic/claude-opus-5')
  })

  it('assignPermission 记下非默认值', () => {
    expect(assignPermission(state(), 's1', 'auto').sessionPermission).toEqual({ s1: 'auto' })
  })

  // 回到默认就删掉，别存一堆 "ask"
  it('assignPermission 回到默认时删掉那一项', () => {
    const s = state({ sessionPermission: { s1: 'auto' } })
    expect(assignPermission(s, 's1', 'ask').sessionPermission).toEqual({})
  })

  it('写操作不改入参（renderer 靠引用变化重渲染）', () => {
    const s = state()
    const before = JSON.stringify(s)
    assignProvider(s, 's1', 'pi')
    assignModel(s, 's1', 'claude-opus-5')
    assignBuiltinModel(s, 's1', 'anthropic', 'x')
    assignPermission(s, 's1', 'auto')
    forgetSession(s, 's1')
    expect(JSON.stringify(s)).toBe(before)
  })
})

describe('forgetSession', () => {
  it('四种绑定一起清', () => {
    const s = state({
      sessionProvider: { s1: 'pi', s2: 'pi' },
      sessionModel: { s1: 'x' },
      builtinModel: { s1: 'a/b', s2: 'c/d' },
      sessionPermission: { s1: 'auto' },
    })
    const out = forgetSession(s, 's1')
    expect(out.sessionProvider).toEqual({ s2: 'pi' })
    expect(out.sessionModel).toEqual({})
    expect(out.builtinModel).toEqual({ s2: 'c/d' })
    expect(out.sessionPermission).toEqual({})
  })

  // 调用方用引用比较跳过写盘 —— 删一个从没绑定过的会话不该写一次盘、
  // 广播一次没有变化的状态
  it('本来就没绑定过时返回同一个引用', () => {
    const s = state()
    expect(forgetSession(s, '没见过的会话')).toBe(s)
  })
})

describe('toggleProvider', () => {
  it('停用：进黑名单，选择器里消失', () => {
    const out = toggleProvider(state(), 'pi', false)
    expect(out.disabledProviders).toEqual(['pi'])
    expect(providerOptions(out).map((o) => o.id)).toEqual([BUILTIN_ID, 'claude-code'])
  })

  it('启用：出黑名单，选择器里回来', () => {
    const off = toggleProvider(state(), 'pi', false)
    const on = toggleProvider(off, 'pi', true)
    expect(on.disabledProviders).toEqual([])
    expect(providerOptions(on).map((o) => o.id)).toEqual([BUILTIN_ID, 'claude-code', 'pi'])
  })

  it('幂等：重复停用不会塞两份', () => {
    const once = toggleProvider(state(), 'pi', false)
    expect(toggleProvider(once, 'pi', false).disabledProviders).toEqual(['pi'])
  })

  // 停掉内置之后选择器会是空的，用户没法把会话切回任何东西
  it('拒绝停用内置 agent，原样返回', () => {
    const s = state()
    expect(toggleProvider(s, BUILTIN_ID, false)).toBe(s)
  })

  it('认不出的 id 原样返回，不往黑名单里塞垃圾', () => {
    const s = state()
    expect(toggleProvider(s, '不存在的', false)).toBe(s)
  })

  // 黑名单不动会话绑定：停用当前正在用的那家时，已有绑定还在（normalize 不清它），
  // 只是选择器里选不到了 —— 用户下次切换只能选别的
  it('停用当前正在用的那家，不清掉已有绑定', () => {
    const s = state({ sessionProvider: { s1: 'pi' } })
    const out = toggleProvider(s, 'pi', false)
    expect(out.sessionProvider).toEqual({ s1: 'pi' })
    expect(providerFor(out, 's1')).toBe('pi')
  })
})

describe('exampleProvidersState（模板）', () => {
  // 默认全部可用：装了 Claude Code / Codex 的人开箱就能在对话框左下角选到，
  // 不用先去手改 JSON。原来五家全带 disabled: true，结果是用户以为功能不存在
  // （用户原话：「首页的对话框为啥只有一个 agent 模式的」）。
  it('预置的五家默认全部可选，不再是 disabled', () => {
    const s = exampleProvidersState()
    expect(s.external.some((e) => e.disabled)).toBe(false)
    expect(s.disabledProviders).toEqual([])
    expect(providerOptions(s).map((o) => o.id)).toEqual([
      BUILTIN_ID,
      'claude-code',
      'codex',
      'gemini',
      'pi',
      'deepseek-harness',
    ])
  })

  it('五家都在，且 Kimi 不在（npm 上没有它的 ACP 桥）', () => {
    const ids = exampleProvidersState().external.map((e) => e.id)
    expect(ids).toEqual(['claude-code', 'codex', 'gemini', 'pi', 'deepseek-harness'])
    expect(ids.some((id) => id.includes('kimi'))).toBe(false)
  })

  it('模板能过 normalize（自己生成的东西不该被自己的校验丢掉）', () => {
    const s = exampleProvidersState()
    expect(normalizeProvidersState(s).external).toHaveLength(s.external.length)
  })

  it('Claude Code 走 ANTHROPIC_MODEL 环境变量', () => {
    const s = exampleProvidersState()
    const launch = resolveLaunch(s, 'claude-code', 'claude-sonnet-5')
    expect(launch?.env.ANTHROPIC_MODEL).toBe('claude-sonnet-5')
  })

  it('Codex 提供默认项和截图中的七个模型，模型参数对应实际 ID', () => {
    const s = exampleProvidersState()
    expect(modelsFor(s, 'codex').map(m => m.name)).toEqual([
      '默认', 'GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna',
      'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna',
    ])
    for (const model of modelsFor(s, 'codex').slice(1)) {
      expect(resolveLaunch(s, 'codex', model.id)?.args.slice(-2)).toEqual(['--model', model.id])
    }
    const bound = assignProvider(s, 's1', 'codex')
    expect(modelFor(bound, 's1')).toBe('default')
    expect(resolveLaunch(bound, 'codex', modelFor(bound, 's1'))?.args).toEqual([
      '-y', '@agentclientprotocol/codex-acp@latest',
    ])
    expect(modelFor(assignModel(bound, 's1', 'gpt-6-astra'), 's1')).toBe('gpt-6-astra')
    expect(modelFor(assignModel(bound, 's1', 'default'), 's1')).toBe('default')
  })

  // Gemini CLI 原生支持 ACP，不需要第三方适配器
  it('Gemini 用自带的 --experimental-acp', () => {
    const launch = resolveLaunch(exampleProvidersState(), 'gemini')
    expect(launch?.args).toContain('--experimental-acp')
  })

  // 版本号还在 0.0.x / 第三方维护，模型清单留空用它的默认模型 ——
  // 免得写一串猜的 id 让人以为是验证过的
  it('Pi 和 DeepSeek Harness 不预置模型清单', () => {
    const s = exampleProvidersState()
    expect(modelsFor(s, 'pi')).toEqual([])
    expect(modelsFor(s, 'deepseek-harness')).toEqual([])
  })
})

describe('Codex 旧模板模型升级', () => {
  const legacy = () => {
    const s = assignModel(assignProvider(exampleProvidersState(), 's1', 'codex'), 's1', 'gpt-5.2')
    s.external.find(p => p.id === 'codex')!.models = ['gpt-5.2', 'gpt-5.1', 'gpt-5'].map(id => ({
      id, name: id.toUpperCase(), args: ['--model', id],
    }))
    return s
  }

  it('已有用户也获得新模型列表，失效选择回到本机默认，重复读取保持稳定', () => {
    const s = legacy()
    s.external.find(p => p.id === 'codex')!.cwd = '/tmp/project'
    s.disabledProviders = ['pi']
    const updated = normalizeProvidersState(s)
    expect(modelsFor(updated, 'codex')).toEqual(modelsFor(exampleProvidersState(), 'codex'))
    expect(modelFor(updated, 's1')).toBe('default')
    expect(providerFor(updated, 's1')).toBe('codex')
    expect(updated.disabledProviders).toEqual(['pi'])
    expect(resolveLaunch(updated, 'codex')?.cwd).toBe('/tmp/project')
    expect(normalizeProvidersState(updated)).toEqual(updated)
  })

  it.each(['models', 'command', 'args', 'context'] as const)('保留用户自定义的 %s', (field) => {
    const s = legacy(), provider = s.external.find(p => p.id === 'codex')!
    if (field === 'models') provider.models!.push({ id: 'custom', name: 'My model', args: ['--model', 'custom'] })
    if (field === 'command') provider.command = '/usr/local/bin/codex-acp'
    if (field === 'args') provider.models![0].args = ['--model', 'private-alias']
    if (field === 'context') provider.models![0].contextWindow = 100_000
    const updated = normalizeProvidersState(s)
    expect(modelsFor(updated, 'codex')).toEqual(provider.models)
    expect(modelFor(updated, 's1')).toBe('gpt-5.2')
  })

  it('用户清空列表后不自动补回模板', () => {
    const s = legacy()
    s.external.find(p => p.id === 'codex')!.models = []
    expect(modelsFor(normalizeProvidersState(s), 'codex')).toEqual([])
  })
})
