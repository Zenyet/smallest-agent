// ============================================================================
// providers.ts —— provider 注册表与会话绑定（纯数据 + 纯函数）
// ----------------------------------------------------------------------------
// 两件事：
//   1. 管理有哪些 provider 可用（内置 agent + 用户配的外部 CLI）
//   2. 记住每个会话用的是哪个 —— 用户可以在会话 A 用内置 agent、
//      会话 B 用 Claude Code，切来切去不该丢
//
// 这个文件不 import 任何 electron API，所以 renderer 也能直接用它
// （和 projects.ts 同一个安排，那边的 groupSessions 已经被 renderer 在用）。
// 落盘在 providers-store.ts。
//
// ## 为什么 provider 绑定要单独存
//
// 和项目分组同一个理由（见 projects.ts 的文件头）：会话文件的形状由 src/ 的
// JsonSessionStore 决定（就是 `Message[]`），没地方放元数据，而且每答完一轮
// SaveSessionHook 都会整体覆写它。塞进去的字段会被下一次 save 抹掉。
// ============================================================================

import type { IconName } from '../renderer/src/components/Icon'

/**
 * 内置 provider 的固定 id。
 *
 * 用常量而不是字面量散在各处：它出现在配置文件、UI 的选中判断、默认值
 * 三个地方，改字面量必然漏一个。
 */
export const BUILTIN_ID = 'builtin'

export const BUILTIN_NAME = '内置 agent'

/**
 * 外部 CLI 的一个模型选择。
 *
 * ## 为什么模型要用户配，而不是问 CLI
 *
 * **ACP 协议里没有模型选择。** 查过 SDK 1.4.0 的 schema：SessionUpdate 有
 * `current_mode_update`（ask / architect 那种工作模式），没有 available_models。
 * 有一组 `providers/list` / `providers/set`，但它标着 UNSTABLE（"not part of
 * the spec yet, and may be removed or changed at any point"），而且答的是
 * 「LLM 路由怎么配」不是「有哪些模型可选」。所以客户端问不出来。
 *
 * 各家 CLI 的做法是读环境变量或命令行参数（`ANTHROPIC_MODEL`、`--model`）。
 * 所以让用户声明「有哪些选择、每个怎么传」，我们在起子进程时应用上。
 *
 * 代价是清单会过期（各家出新模型要用户自己加一行）。换来的是**不用为每家
 * CLI 写一个适配器** —— waku 走的是那条路（12 个 driver 文件），因为它用
 * 各家原生协议、要拿到各家独有能力。
 *
 * 名字叫 CliModel 而不是 ModelChoice：vendors.ts 已经有一个 ModelChoice
 * （内置厂商的模型，只有 id/name），两者不是一回事 —— 那个的 id 是我们
 * 自己发 HTTP 时用的模型名，这个的 id 是要塞进别人进程的字符串。
 */
export interface CliModel {
  /** Configured context capacity for this exact CLI model. */
  contextWindow?: number
  id: string
  /** 显示名（"Claude Sonnet 5"） */
  name: string
  /** 追加的环境变量。多数 CLI 走这条。 */
  env?: Record<string, string>
  /** 追加的命令行参数（`["--model", "gpt-5.2"]`）。Codex 那套走这条。 */
  args?: string[]
}

/** 一个外部 CLI provider 的定义。 */
export interface ExternalProvider {
  /** 唯一 id，会话绑定引用它 */
  id: string
  /** 显示名（"Claude Code"） */
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /**
   * 工作目录。不填 = 跟着当前选中的项目走。
   *
   * 这是外部 CLI 和内置 agent 在「项目」概念上的接缝：内置 agent 的项目
   * 只是会话分组，而 CLI 的 cwd 决定它能看到哪些文件。不填让两者对齐 ——
   * 用户在项目 X 下开的会话，CLI 就在 X 的目录里干活。
   */
  cwd?: string
  /**
   * @deprecated 用顶层的 `disabledProviders` 黑名单代替。
   *
   * 这个字段只为**读旧配置**保留：normalizeProvidersState 会把它迁移进
   * disabledProviders，之后不再写出。见那个函数里的迁移段。
   *
   * ## 为什么换成黑名单
   *
   * 原来模板里五家 CLI 全带 `disabled: true`，理由是「要 npx 拉包 + 各自
   * 认证，不该在用户没看过配置时就出现」。结果是**用户以为功能不存在** ——
   * 选择器里只有内置 agent 一项，而「去手改 JSON」这条路没人会自己发现。
   *
   * waku 的做法是反的：配置里只记 `disabled_providers: []`（黑名单，默认
   * 空 = 全部可用），CLI 本身内置在代码里。装了就能用，没装的选了给一句
   * 清楚的错误 —— 藏起来的代价比报错的代价大得多。
   */
  disabled?: boolean
  /** 这个 CLI 支持哪些模型。空表示不提供选择（用它的默认模型）。 */
  models?: CliModel[]
}

/**
 * 内置 agent 的权限模式。仿 Codex 的那个选择器。
 *
 * ## 为什么是每会话，而不是全局设置
 *
 * 「这条对话能不能动我的磁盘」是个**随任务变**的判断：查点东西用只读，
 * 让它改代码用询问，跑一串脚手架命令时切自动。绑在会话上，切会话就切回
 * 各自的模式，不用每次进设置改一个全局开关。
 */
export type PermissionMode = 'readonly' | 'ask' | 'auto'

export const PERMISSION_MODES: readonly PermissionMode[] = ['readonly', 'ask', 'auto']

/** 默认落在最安全那档：会问。 */
export const DEFAULT_PERMISSION: PermissionMode = 'ask'

export function permissionLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return '只读'
    case 'auto':
      return '自动'
    default:
      return '询问'
  }
}

export function permissionHint(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return '写文件、执行命令一律拒绝。能读、能搜、能上网，动不了东西。'
    case 'auto':
      return '危险操作不问直接放行。清楚自己在干什么、要连着跑很多步时用。'
    default:
      return '危险操作弹卡片让你确认。'
  }
}

export function permissionIcon(mode: PermissionMode): IconName {
  switch (mode) {
    case 'readonly':
      // 眼睛：能看不能动
      return 'eye'
    case 'auto':
      // 播放：不问，直接跑
      return 'play'
    default:
      // 对勾圈：会问一声
      return 'verified'
  }
}

/** 认不出的（旧数据、手改坏了）落到最安全那档。 */
export function toPermissionMode(raw: unknown): PermissionMode {
  return raw === 'readonly' || raw === 'auto' ? raw : DEFAULT_PERMISSION
}

/** 落盘的状态。 */
export interface ProvidersState {
  /** 用户配的外部 CLI */
  external: ExternalProvider[]
  /** sessionId → providerId。不在这里的会话用内置 provider。 */
  sessionProvider: Record<string, string>
  /**
   * sessionId → 外部 CLI 的模型 id。只对外部 provider 有意义。
   * 不在这里的会话用那个 provider 的第一个模型（或它的默认）。
   */
  sessionModel: Record<string, string>
  /**
   * sessionId → 内置 agent 用哪家的哪个模型。值的形状是 `厂商id/模型id`
   * （`anthropic/claude-opus-5`）。
   *
   * ## 为什么和 sessionModel 分开存
   *
   * 两者的键空间不同：sessionModel 的值是「某个外部 CLI 声明的模型 id」，
   * 只在那个 CLI 里有意义；这里的值是「厂商 + 模型」，由 vendors.ts 定义。
   * 合在一张表里的话 normalize 没法判断某个值该按哪套规则校验，而校验错的
   * 后果是把合法绑定清掉（用户选的模型莫名回到默认）。
   */
  builtinModel: Record<string, string>
  /** sessionId → 权限模式。只对内置 agent 有意义 —— 外部 CLI 自带权限模型。 */
  sessionPermission: Record<string, PermissionMode>
  /** 新会话默认用哪个。 */
  defaultProvider?: string
  /**
   * 不想在选择器里看到的 provider id（黑名单）。
   *
   * 默认空 = 配好的 CLI 全部可选。这和原来那套「每家一个 disabled: true」
   * 是相反的默认值，理由见 ExternalProvider.disabled 的注释。
   *
   * 内置 agent 不受它影响 —— 那是「至少有一个能用」的保底。
   */
  disabledProviders: string[]
}

export function emptyProvidersState(): ProvidersState {
  return {
    external: [],
    sessionProvider: {},
    sessionModel: {},
    builtinModel: {},
    sessionPermission: {},
    disabledProviders: [],
  }
}

/**
 * 把 `厂商id/模型id` 拆开。
 *
 * 模型 id 里不含斜杠（vendors.ts 那张表里都是 `claude-opus-5` 这种形状），
 * 所以按第一个斜杠切就够。切不开说明是脏数据，返回 null 让调用方回落到默认。
 */
export function splitVendorModel(v: string): { vendorId: string; modelId: string } | null {
  const at = v.indexOf('/')
  if (at <= 0 || at === v.length - 1) return null
  return { vendorId: v.slice(0, at), modelId: v.slice(at + 1) }
}

function strRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

function normalizeCliModel(raw: unknown): CliModel | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<CliModel>
  if (typeof m.id !== 'string' || m.id === '') return null
  const args = Array.isArray(m.args) ? m.args.filter((a): a is string => typeof a === 'string') : []
  return {
    id: m.id,
    ...(Number.isSafeInteger(m.contextWindow) && m.contextWindow! > 0 ? { contextWindow: m.contextWindow } : {}),
    // 没写显示名就用 id 本身 —— 显示一个空标签比显示 id 更糟
    name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
    ...(Object.keys(strRecord(m.env)).length > 0 ? { env: strRecord(m.env) } : {}),
    ...(args.length > 0 ? { args } : {}),
  }
}

function normalizeExternal(raw: unknown): ExternalProvider | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<ExternalProvider>
  // id 和 command 是硬要求：没有 id 没法绑定，没有 command 起不了进程。
  // 缺哪个都只能整条丢掉 —— 留个残缺条目在选择器里，用户选了才发现起不来
  if (typeof p.id !== 'string' || p.id === '') return null
  if (typeof p.command !== 'string' || p.command === '') return null
  // 不能占用内置那个 id，否则选择器里两项同 id，选中判断会指向错的那个
  if (p.id === BUILTIN_ID) return null
  const args = Array.isArray(p.args) ? p.args.filter((a): a is string => typeof a === 'string') : []
  let models = Array.isArray(p.models)
    ? p.models.map(normalizeCliModel).filter((m): m is CliModel => m !== null)
    : []
  // 只升级旧版本原样写入的 Codex 模板；手工配置的命令、模型和参数保持原样。
  const legacyIds = ['gpt-5.2', 'gpt-5.1', 'gpt-5']
  if (
    p.id === 'codex' && p.command === 'npx' &&
    args.length === 2 && args[0] === '-y' && args[1] === '@agentclientprotocol/codex-acp@latest' &&
    models.length === legacyIds.length &&
    models.every((m, i) => m.id === legacyIds[i] && m.name === legacyIds[i].toUpperCase() &&
      m.args?.length === 2 && m.args[0] === '--model' && m.args[1] === m.id &&
      !m.env && !m.contextWindow)
  ) {
    models = codexModels()
  }
  return {
    id: p.id,
    name: typeof p.name === 'string' && p.name !== '' ? p.name : p.id,
    command: p.command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(strRecord(p.env)).length > 0 ? { env: strRecord(p.env) } : {}),
    ...(typeof p.cwd === 'string' && p.cwd !== '' ? { cwd: p.cwd } : {}),
    // **不透传 disabled**：它已经被 normalizeProvidersState 收进顶层的
    // disabledProviders 了（见那边的迁移段）。这里再留一份的话，
    // 用户之后想启用某家就得两个地方都改 —— 而他只看得到一个。
    ...(models.length > 0 ? { models } : {}),
  }
}

/**
 * 读盘之后过一遍：磁盘上的 JSON 可能是手改的、或者旧版本写的。
 *
 * ## 为什么要清掉指向已删 provider 的绑定
 *
 * 不清的话那个会话会既不属于任何外部 provider、也不显示成内置 ——
 * 选择器上是空的，用户不知道点发送会走哪条路。
 */
export function normalizeProvidersState(raw: unknown): ProvidersState {
  if (!raw || typeof raw !== 'object') return emptyProvidersState()
  const obj = raw as Partial<ProvidersState>

  const external: ExternalProvider[] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.external)) {
    for (const item of obj.external) {
      const p = normalizeExternal(item)
      // 同 id 只留第一个：重复条目会让「按 id 找 provider」的结果取决于
      // 遍历顺序，而缓存键也是 id —— 两个不同命令共用一个实例
      if (p && !seen.has(p.id)) {
        seen.add(p.id)
        external.push(p)
      }
    }
  }

  const known = new Set<string>([BUILTIN_ID, ...seen])

  const sessionProvider: Record<string, string> = {}
  for (const [sid, pid] of Object.entries(strRecord(obj.sessionProvider))) {
    if (known.has(pid)) sessionProvider[sid] = pid
  }

  // 模型绑定分两步查，不是一步：模型 id 只在它所属的 provider 里唯一，
  // 所以要先知道这个会话绑的是哪个 provider，才能判断这个模型 id 合不合法
  const sessionModel: Record<string, string> = {}
  for (const [sid, mid] of Object.entries(strRecord(obj.sessionModel))) {
    const pid = sessionProvider[sid]
    if (!pid || pid === BUILTIN_ID) continue
    const provider = external.find((e) => e.id === pid)
    if (!provider) continue
    // 没声明模型清单的 provider（用它的默认模型）不该有模型绑定
    if (!provider.models || provider.models.length === 0) continue
    if (provider.models.some((m) => m.id === mid)) sessionModel[sid] = mid
  }

  // 内置模型只校验形状（能不能拆成 厂商/模型），不校验厂商是否存在 ——
  // 那要 import vendors.ts，而「厂商清单」会随用户配的自定义端点变化，
  // 在这里判会把合法绑定误删。认不出的厂商由读取方回落到默认。
  const builtinModel: Record<string, string> = {}
  for (const [sid, v] of Object.entries(strRecord(obj.builtinModel))) {
    if (splitVendorModel(v)) builtinModel[sid] = v
  }

  const sessionPermission: Record<string, PermissionMode> = {}
  if (obj.sessionPermission && typeof obj.sessionPermission === 'object') {
    for (const [sid, mode] of Object.entries(obj.sessionPermission)) {
      // 只存非默认值：默认是 ask，存一堆 "ask" 只是让文件变大
      const m = toPermissionMode(mode)
      if (m !== DEFAULT_PERMISSION) sessionPermission[sid] = m
    }
  }

  const defaultProvider =
    typeof obj.defaultProvider === 'string' && known.has(obj.defaultProvider)
      ? obj.defaultProvider
      : undefined

  // 黑名单。两个来源合并：
  //
  //   1. 顶层 disabledProviders —— 新格式，用户显式排除的
  //   2. 各 external 上残留的 disabled: true —— 旧格式，迁移过来
  //
  // ## 为什么必须迁移，不能直接忽略旧字段
  //
  // 忽略的话，已经在用的人升级后五家 CLI 会突然全部冒出来 —— 而他可能
  // 特意留着 disabled（比如装了但不想在这个 app 里用）。那是「升级悄悄
  // 改了我的配置」，比默认值选错更糟。
  //
  // 迁移是一次性的：normalize 之后写回磁盘的 external 不再带 disabled
  // （见 normalizeExternal —— 它现在不透传那个字段了），所以下次读到的
  // 就只有顶层黑名单。
  //
  // 只保留认识的 id：external 里已经没有的条目留在黑名单里没意义，
  // 而且会随每次写盘一直堆积。
  const disabled = new Set<string>()
  if (Array.isArray(obj.disabledProviders)) {
    for (const id of obj.disabledProviders) {
      if (typeof id === 'string' && seen.has(id)) disabled.add(id)
    }
  }
  if (Array.isArray(obj.external)) {
    for (const item of obj.external) {
      if (!item || typeof item !== 'object') continue
      const p = item as Partial<ExternalProvider>
      if (p.disabled === true && typeof p.id === 'string' && seen.has(p.id)) {
        disabled.add(p.id)
      }
    }
  }

  return {
    external,
    sessionProvider,
    sessionModel,
    builtinModel,
    sessionPermission,
    disabledProviders: [...disabled],
    ...(defaultProvider ? { defaultProvider } : {}),
  }
}

// ============================================================================
// 读
// ============================================================================

/** 这个会话用哪个 provider。没绑定过就用默认（defaultProvider 或内置）。 */
export function providerFor(state: ProvidersState, sessionId: string): string {
  return state.sessionProvider[sessionId] ?? state.defaultProvider ?? BUILTIN_ID
}

/** 这个 provider 声明了哪些模型。内置和不存在的都返回空。 */
export function modelsFor(state: ProvidersState, providerId: string): CliModel[] {
  if (providerId === BUILTIN_ID) return []
  return state.external.find((e) => e.id === providerId)?.models ?? []
}

/**
 * 这个会话用外部 CLI 的哪个模型。
 *
 * 没绑定时给第一个 —— 那也是显示出来的那个。让「显示的」和「打勾的」是
 * 同一项，否则打开下拉会看到按钮上写着 A 而列表里勾在别处。
 */
export function modelFor(state: ProvidersState, sessionId: string): string | undefined {
  const pid = providerFor(state, sessionId)
  const models = modelsFor(state, pid)
  if (models.length === 0) return undefined
  const bound = state.sessionModel[sessionId]
  if (bound && models.some((m) => m.id === bound)) return bound
  return models[0].id
}

/**
 * 这个会话的内置 agent 用哪家的哪个模型。
 *
 * 返回 null 表示「没绑定过」，调用方用设置里的 ACTIVE_VENDOR / ACTIVE_MODEL。
 * 这里不 import vendors.ts 去取默认值 —— 那会让这个纯数据模块依赖厂商清单，
 * 而清单还受用户配的自定义端点影响。
 */
export function builtinModelFor(
  state: ProvidersState,
  sessionId: string,
): { vendorId: string; modelId: string } | null {
  const v = state.builtinModel[sessionId]
  return v ? splitVendorModel(v) : null
}

/** 这个会话的权限模式。 */
export function permissionFor(state: ProvidersState, sessionId: string): PermissionMode {
  return state.sessionPermission[sessionId] ?? DEFAULT_PERMISSION
}

/** 一个可选项，给 composer 的引擎选择器和设置页的列表用。 */
export interface ProviderOption {
  id: string
  name: string
  /** 外部 CLI（true）还是内置 agent（false） */
  external: boolean
}

/**
 * 启用/停用一个外部 CLI（写黑名单）。
 *
 * 纯函数、返回新状态 —— 和 assignProvider 那几个同一个约定，
 * 落盘和广播由 ipc-handlers 负责。
 *
 * 内置 agent 拒绝停用：它是「至少有一个能用」的保底，停掉之后
 * 选择器会是空的，用户没法把会话切回任何东西。
 * 认不出的 id 原样返回，不往黑名单里塞垃圾。
 */
export function toggleProvider(
  state: ProvidersState,
  providerId: string,
  enabled: boolean,
): ProvidersState {
  if (providerId === BUILTIN_ID) return state
  if (!state.external.some((e) => e.id === providerId)) return state
  const hidden = new Set(state.disabledProviders)
  if (enabled) hidden.delete(providerId)
  else hidden.add(providerId)
  return { ...state, disabledProviders: [...hidden] }
}

/**
 * 选择器里列哪些。内置永远第一个，后面跟着没被 disable 的外部 CLI。
 *
 * 内置永远在：它不需要配置也不会起不来，是那个「至少有一个能用」的保底。
 */
export function providerOptions(state: ProvidersState): ProviderOption[] {
  // 黑名单过滤。默认空 = 配好的全部可选（和原来「全部 disabled」相反，
  // 理由见 ExternalProvider.disabled 的注释）。
  const hidden = new Set(state.disabledProviders)
  return [
    { id: BUILTIN_ID, name: BUILTIN_NAME, external: false },
    ...state.external
      .filter((e) => !hidden.has(e.id))
      .map((e) => ({ id: e.id, name: e.name, external: true })),
  ]
}

/**
 * 起子进程要的东西：命令 + 参数 + 环境变量，模型已经展开进去了。
 *
 * 模型的 env/args 追加在 provider 自己的后面 —— 同名环境变量以模型的为准
 * （用户在模型上写 ANTHROPIC_MODEL 就是要覆盖 provider 级的那个）。
 *
 * 返回 null 表示这个 provider 不存在。
 */
export function resolveLaunch(
  state: ProvidersState,
  providerId: string,
  modelId?: string,
): { command: string; args: string[]; env: Record<string, string>; cwd?: string } | null {
  const p = state.external.find((e) => e.id === providerId)
  if (!p) return null
  const model = modelId ? p.models?.find((m) => m.id === modelId) : undefined
  return {
    command: p.command,
    args: [...(p.args ?? []), ...(model?.args ?? [])],
    env: { ...(p.env ?? {}), ...(model?.env ?? {}) },
    ...(p.cwd ? { cwd: p.cwd } : {}),
  }
}

// ============================================================================
// 写（都返回新状态，不改入参 —— renderer 靠引用变化决定重渲染）
// ============================================================================

export function assignProvider(
  state: ProvidersState,
  sessionId: string,
  providerId: string,
): ProvidersState {
  const next = { ...state, sessionProvider: { ...state.sessionProvider, [sessionId]: providerId } }
  // 换了 provider，原来那个模型绑定就是垃圾了（模型 id 只在它所属的
  // provider 里有意义）。不清的话 normalize 下次读盘会清掉，但内存态里
  // 还留着，而 modelFor 会拿它去和新 provider 的清单比 —— 比不中就回落到
  // 第一个，看着像「换引擎顺手把模型也换了」，实际是脏数据的巧合
  if (sessionId in next.sessionModel) {
    const sessionModel = { ...next.sessionModel }
    delete sessionModel[sessionId]
    next.sessionModel = sessionModel
  }
  return next
}

export function assignModel(
  state: ProvidersState,
  sessionId: string,
  modelId: string,
): ProvidersState {
  return { ...state, sessionModel: { ...state.sessionModel, [sessionId]: modelId } }
}

/** value 的形状是 `厂商id/模型id`。 */
export function assignBuiltinModel(
  state: ProvidersState,
  sessionId: string,
  vendorId: string,
  modelId: string,
): ProvidersState {
  return {
    ...state,
    builtinModel: { ...state.builtinModel, [sessionId]: `${vendorId}/${modelId}` },
  }
}

export function assignPermission(
  state: ProvidersState,
  sessionId: string,
  mode: PermissionMode,
): ProvidersState {
  const sessionPermission = { ...state.sessionPermission }
  // 回到默认就删掉这一项，别存一堆 "ask"
  if (mode === DEFAULT_PERMISSION) delete sessionPermission[sessionId]
  else sessionPermission[sessionId] = mode
  return { ...state, sessionPermission }
}

/**
 * 会话被删了，它名下的四种绑定都是垃圾。
 *
 * 不清的话会在 electron-store 里越攒越多，而且将来某个新会话万一拿到同样的
 * id 会莫名带着别人的引擎设置（和 projects.ts 的 forgetSession 同一条理由）。
 *
 * 一个都没有时返回同一个引用，调用方可以用引用比较跳过写盘。
 */
export function forgetSession(state: ProvidersState, sessionId: string): ProvidersState {
  const has =
    sessionId in state.sessionProvider ||
    sessionId in state.sessionModel ||
    sessionId in state.builtinModel ||
    sessionId in state.sessionPermission
  if (!has) return state
  const sessionProvider = { ...state.sessionProvider }
  const sessionModel = { ...state.sessionModel }
  const builtinModel = { ...state.builtinModel }
  const sessionPermission = { ...state.sessionPermission }
  delete sessionProvider[sessionId]
  delete sessionModel[sessionId]
  delete builtinModel[sessionId]
  delete sessionPermission[sessionId]
  return { ...state, sessionProvider, sessionModel, builtinModel, sessionPermission }
}

// ============================================================================
// 模板
// ============================================================================

/** Codex 推荐模型；默认项不传 --model，沿用本机 Codex 的配置。 */
function codexModels(): CliModel[] {
  return [
    { id: 'default', name: '默认' },
    ...[
      ['gpt-6.1-sol', 'GPT-6.1 Sol'],
      ['gpt-6-astra', 'GPT-6 Astra'],
      ['gpt-6-sol', 'GPT-6 Sol'],
      ['gpt-6-luna', 'GPT-6 Luna'],
      ['gpt-5.6-sol', 'GPT-5.6 Sol'],
      ['gpt-5.6-terra', 'GPT-5.6 Terra'],
      ['gpt-5.6-luna', 'GPT-5.6 Luna'],
    ].map(([id, name]) => ({ id, name, args: ['--model', id] })),
  ]
}

/**
 * 示例配置，第一次打开设置页时写一份进去。
 *
 * 五家默认启用，用户可在设置里停用；首次使用要准备适配器和各自的登录。
 *
 * ## 这几个包名都核对过 npm
 *
 * claude-agent-acp 0.70.0 / codex-acp 1.6.2 / pi-acp 0.0.33 / deepseek-acp 0.7.0，
 * Gemini CLI 自带 `--experimental-acp` 不需要适配器。
 *
 * **Kimi Code 没有预置**：`@moonshot-ai/kimi-code` 是 CLI 本身，npm 上没有
 * ACP 桥，第三方的也没搜到。编一个包名进去的后果是用户点了之后 npx 报 404，
 * 而错误看着像我们的问题。哪天有了加一行就行 —— 这正是「清单是用户可改的
 * 配置文件」而不是硬编码的理由。
 *
 * ## 模型清单会过期
 *
 * 这是**用户可改的模板**，不是权威清单 —— ACP 查不到模型（见 CliModel 的
 * 注释），各家出新模型时自己加一行。
 *
 * 1M 上下文用 id 后缀表达（`claude-opus-5[1m]`）而不是单独的选项维度：
 * 那样需要一个嵌套的选择 UI，摊平成独立条目多几行就够了。只给顶配加，
 * 否则列表长一倍而多数人用不到。
 */
export function exampleProvidersState(): ProvidersState {
  /** 走 ANTHROPIC_MODEL 环境变量的模型（Claude Code 那套）。 */
  const envModel = (id: string, name: string): CliModel => ({
    id,
    name,
    env: { ANTHROPIC_MODEL: id },
  })
  /** 走 `--model` 命令行参数的模型（Codex 那套）。 */
  const argModel = (id: string, name: string): CliModel => ({
    id,
    name,
    args: ['--model', id],
  })

  return {
    ...emptyProvidersState(),
    external: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp@latest'],
        // 没实测 claude-agent-acp 是否真的读 ANTHROPIC_MODEL。这是 Claude Code
        // 的标准环境变量，适配器大概率透传。填错的后果是 CLI 用它的默认模型
        // （不会崩），换个变量名再试即可
        models: [
          envModel('claude-opus-5', 'Claude Opus 5'),
          envModel('claude-opus-5[1m]', 'Claude Opus 5 (1M)'),
          envModel('claude-sonnet-5', 'Claude Sonnet 5'),
          envModel('claude-sonnet-5[1m]', 'Claude Sonnet 5 (1M)'),
          envModel('claude-fable-5', 'Claude Fable 5'),
          envModel('claude-haiku-4-5', 'Claude Haiku 4.5'),
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp@latest'],
        models: codexModels(),
      },
      {
        id: 'gemini',
        name: 'Gemini CLI',
        command: 'npx',
        // Gemini CLI 原生支持 ACP，不用适配器
        args: ['-y', '@google/gemini-cli@latest', '--experimental-acp'],
        models: [
          argModel('gemini-3-pro', 'Gemini 3 Pro'),
          argModel('gemini-3-flash', 'Gemini 3 Flash'),
        ],
      },
      {
        id: 'pi',
        name: 'Pi',
        command: 'npx',
        args: ['-y', 'pi-acp@latest'],
        // 版本号还在 0.0.x，模型清单先留空 —— 用它的默认模型，
        // 免得写一串猜的 id 让人以为是验证过的
        models: [],
      },
      {
        id: 'deepseek-harness',
        name: 'DeepSeek Harness',
        command: 'npx',
        args: ['-y', 'deepseek-acp@latest'],
        models: [],
      },
    ],
  }
}
