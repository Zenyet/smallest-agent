// ============================================================================
// vendors.ts —— 内置厂商目录 + 自定义端点
// ----------------------------------------------------------------------------
// 移植自 rs/core/src/vendors.rs（gpui 侧）。原样搬过去的部分很直接：
// 九家厂商全是 OpenAI 兼容端点（`createOpenAICompatible` 通吃），跟当年
// DeepSeek 接进来时用的是同一条路——`src/llm.ts` 里那句注释写着
// 「DeepSeek 与 OpenAI API 格式兼容，通过 baseURL 切换到 DeepSeek 端点即可
// 复用 OpenAI SDK 协议」，换一家只是换 baseURL/apiKey，SDK 调用点不用碰。
//
// ## 为什么这件事不用碰 src/（也不需要新的 provider 抽象层）
//
// 一开始以为多厂商要在 src/ 里加一层 provider 抽象（gpui 那边确实有，
// core/src/provider/）。仔细看了 src/config.ts 才发现不需要：
//
//   const apiKey = env.DEEPSEEK_API_KEY
//   baseURL: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
//   model: env.DEEPSEEK_MODEL ?? 'deepseek-chat'
//
// loadConfig 只认这三个环境变量的**值**，根本不检查它们是不是真的来自
// DeepSeek。所以「选了 Anthropic」在 src/ 眼里就是「DEEPSEEK_API_KEY 恰好
// 填的是一把 Anthropic 的 key、DEEPSEEK_BASE_URL 恰好指向 Anthropic 的
// 端点」——零修改下这条路完全走得通，不用碰 src/config.ts 一个字。
//
// 这也是为什么这个文件只到「目录 + 解析」为止：真正把选择落成
// DEEPSEEK_* 三个环境变量，是 config-env.ts 的 buildEnv 该做的事
// （src/config.ts 只认这三个名字，不能改）。
//
// ## 和 gpui 的差异
//
// gpui 那边 Selection::apply 直接改一份 Config 结构体（Rust 侧 Config 是
// 强类型的、有 native_search 字段）。这边落地成 env（字符串），所以：
//   • search 支持先只搬数据（每家的 NativeSearch），不接线 ——
//     web 搜索工具本身在 TS 侧还不存在（src/tools 里没有），这是另一件事
//   • fallback_model 跟着主模型走的那条规则原样保留（见 resolveSelection）
// ============================================================================

/** 单个模型。 */
export interface VendorModel {
  id: string
  name: string
}

/**
 * 一家厂商自带的联网搜索怎么开。
 *
 * 先只搬数据、不接线：web 搜索工具本身在 TS 侧还不存在（gpui 那边是
 * src/tools/web.rs，614 行，是独立的一块）。这几个值留着给那件事用，
 * 现在没人读。
 */
export type NativeSearch =
  | { kind: 'none' }
  | { kind: 'enable-flag' }
  | { kind: 'tool-type'; toolType: string }
  | { kind: 'builtin-function'; name: string }

const NONE: NativeSearch = { kind: 'none' }

export interface Vendor {
  id: string
  name: string
  /** OpenAI 兼容端点的基址。不含 /chat/completions。 */
  baseUrl: string
  /** 存 API key 用的设置键名。每家一个，用户可以同时配好几家。 */
  keyEnv: string
  /** 去哪儿领 key。 */
  console: string
  nativeSearch: NativeSearch
  models: VendorModel[]
}

// 顺序有意义：第一个是该厂商的默认模型（用户没选时用它）。
// 每家第一行放它当前的主力型号，不是最便宜的也不是最贵的。
const DEEPSEEK: VendorModel[] = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
]

const ANTHROPIC: VendorModel[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-fable-5', name: 'Claude Fable 5' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
]

const OPENAI: VendorModel[] = [
  { id: 'gpt-5.2', name: 'GPT-5.2' },
  { id: 'gpt-5.1', name: 'GPT-5.1' },
  { id: 'gpt-5', name: 'GPT-5' },
  { id: 'gpt-5-mini', name: 'GPT-5 mini' },
  { id: 'o3', name: 'o3' },
  { id: 'gpt-4o', name: 'GPT-4o' },
]

const GEMINI: VendorModel[] = [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
]

const GROK: VendorModel[] = [
  { id: 'grok-4.1', name: 'Grok 4.1' },
  { id: 'grok-4', name: 'Grok 4' },
  { id: 'grok-3', name: 'Grok 3' },
]

const GLM: VendorModel[] = [
  { id: 'glm-4.6', name: 'GLM-4.6' },
  { id: 'glm-4.5', name: 'GLM-4.5' },
  { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
]

const KIMI: VendorModel[] = [
  { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking' },
  { id: 'kimi-k2-0905-preview', name: 'Kimi K2' },
  { id: 'moonshot-v1-128k', name: 'Moonshot v1 128k' },
]

const QWEN: VendorModel[] = [
  { id: 'qwen3-max', name: 'Qwen3 Max' },
  { id: 'qwen-max', name: 'Qwen Max' },
  { id: 'qwen-plus', name: 'Qwen Plus' },
  { id: 'qwen-turbo', name: 'Qwen Turbo' },
]

const MINIMAX: VendorModel[] = [
  { id: 'minimax-m2', name: 'MiniMax M2' },
  { id: 'abab6.5s-chat', name: 'abab6.5s' },
]

/**
 * 全部内置厂商。
 *
 * DeepSeek 排第一是历史原因——它是这个仓库原来唯一支持的那个，老用户的
 * 配置里只有它的 key，让它继续当默认值可以做到「升级之后什么都不用改」。
 */
export const ALL: Vendor[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    console: 'https://platform.deepseek.com/api_keys',
    nativeSearch: NONE, // 搜索在 Responses API 上，不是 chat/completions
    models: DEEPSEEK,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    // Anthropic 的 OpenAI 兼容层挂在 /v1 下。它不覆盖原生 API 的全部能力
    // （thinking 块、prompt caching 的细粒度控制拿不到），但 chat +
    // tool_calls 这条路是通的，也就是这个 app 用到的部分。
    baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
    console: 'https://console.anthropic.com/settings/keys',
    nativeSearch: NONE, // 原生 API 有 web_search，但 OpenAI 兼容层不透传
    models: ANTHROPIC,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    console: 'https://platform.openai.com/api-keys',
    nativeSearch: NONE, // 同上：搜索在 Responses API 那边
    models: OPENAI,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    // Gemini 的 OpenAI 兼容层，注意路径里那个 openai/
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    console: 'https://aistudio.google.com/apikey',
    nativeSearch: NONE, // google_search 只在原生 API，兼容层没有
    models: GEMINI,
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    console: 'https://console.x.ai',
    nativeSearch: NONE, // Live Search 是独立参数集，兼容层不支持
    models: GROK,
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyEnv: 'ZHIPU_API_KEY',
    console: 'https://open.bigmodel.cn/usercenter/apikeys',
    nativeSearch: { kind: 'tool-type', toolType: 'web_search' },
    models: GLM,
  },
  {
    id: 'kimi',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyEnv: 'MOONSHOT_API_KEY',
    console: 'https://platform.moonshot.cn/console/api-keys',
    nativeSearch: NONE, // $web_search 要回传 tool_call 才执行
    models: KIMI,
  },
  {
    id: 'qwen',
    name: '阿里通义千问',
    // 阿里的 OpenAI 兼容模式在 compatible-mode 这个路径下。
    // 用国际站（dashscope-intl）的走自定义端点。
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY',
    console: 'https://bailian.console.aliyun.com',
    nativeSearch: { kind: 'enable-flag' },
    models: QWEN,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    keyEnv: 'MINIMAX_API_KEY',
    console: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    nativeSearch: NONE,
    models: MINIMAX,
  },
]

/** 默认厂商。见 ALL 上面那段关于 DeepSeek 的说明。 */
export const DEFAULT_VENDOR = 'deepseek'

// ============================================================================
// 自定义端点
// ----------------------------------------------------------------------------
// 上面九家的对立面：地址、key、模型清单全由用户填。覆盖内置目录表达不了
// 的那几类——第三方聚合站、公司内网网关、本地跑的（Ollama/LM Studio/vLLM，
// 这类通常不校验 key）、内置某家的另一个站点。
//
// 只有一个位：同时挂 Ollama 和 OpenRouter 的人会不够用，但可增删的列表
// 是另一件事（像 gpui 那边的 agents.json 那样）。这一个位覆盖的是
// 「我有一个自己的端点」这条主线。
// ============================================================================

/** 自定义端点的厂商 id。不在 ALL 里——它没有静态字段可填。 */
export const CUSTOM_ID = 'custom'
export const CUSTOM_NAME = '自定义端点'
/** 设置键：OpenAI 兼容端点的基址，不含 /chat/completions */
export const CUSTOM_BASE_URL = 'CUSTOM_BASE_URL'
/** 设置键：API key。可空（本地服务通常不校验） */
export const CUSTOM_API_KEY = 'CUSTOM_API_KEY'
/** 设置键：模型 id 清单，分隔符见 parseModels */
export const CUSTOM_MODELS = 'CUSTOM_MODELS'
/**
 * 设置键：自定义端点的联网搜索开关。
 *
 * 自定义端点指向什么我们不知道，所以不能像内置厂商那样写死——但最常见的
 * 那个（OpenRouter）是有服务端搜索的，而且用同一把 key。值填 tool 的 type
 * （openrouter:web_search），留空表示没有。
 */
export const CUSTOM_SEARCH_TOOL = 'CUSTOM_SEARCH_TOOL'

/** 自定义端点的设置键，按设置页上该出现的顺序。 */
export const CUSTOM_KEYS = [CUSTOM_BASE_URL, CUSTOM_API_KEY, CUSTOM_MODELS, CUSTOM_SEARCH_TOOL]

// ============================================================================
// 解析
// ============================================================================

/**
 * 取设置值。桌面端传「查 settings.json」（经 buildEnv 拼出来的那份），
 * 设置页传「读输入框当前值」——两处来源不同，但都只需要 key → value。
 */
export type Lookup = (key: string) => string | undefined

/** 取一个值并 trim。空白等于没填——一个只有空格的 key 不该算配好了。 */
function val(get: Lookup, key: string): string {
  return (get(key) ?? '').trim()
}

export interface ModelChoice {
  id: string
  name: string
}

/** 一个厂商解析之后的样子——内置九家和自定义端点在这里同形。 */
export interface VendorEntry {
  id: string
  name: string
  /** 已经去掉末尾斜杠。拼 URL 时是 `${baseUrl}/chat/completions`。 */
  baseUrl: string
  models: ModelChoice[]
  nativeSearch: NativeSearch
}

/** 这个 id 是不是一个认识的厂商（含自定义端点）。 */
export function exists(id: string): boolean {
  return id === CUSTOM_ID || find(id) !== undefined
}

export function find(id: string): Vendor | undefined {
  return ALL.find((v) => v.id === id)
}

/** 显示名。自定义端点也有，所以调用方不用自己特判。 */
export function nameOf(id: string): string | undefined {
  if (id === CUSTOM_ID) return CUSTOM_NAME
  return find(id)?.name
}

/**
 * 存这家 API key 的设置键名。
 *
 * 有这个函数是为了让调用方不必再写 `id === CUSTOM_ID`——原来 gpui 那边
 * providers.rs 和设置页各写了一遍「哪个键存 key」，两处都得跟着改。
 */
export function apiKeySetting(vendorId: string): string | undefined {
  if (vendorId === CUSTOM_ID) return CUSTOM_API_KEY
  return find(vendorId)?.keyEnv
}

/** 内置厂商的默认模型 = 它清单里的第一个。自定义端点没有静态默认值。 */
export function defaultModel(vendorId: string): string | undefined {
  return find(vendorId)?.models[0]?.id
}

/** 所有内置厂商的 key 键名，给设置页生成输入框用。 */
export function keyEnvs(): string[] {
  return ALL.map((v) => v.keyEnv)
}

/**
 * 把用户填的模型清单切成一个个 id。
 *
 * 分隔符收得比较宽（中英文逗号、分号、换行）：这一栏的内容通常是从某个
 * 文档里粘过来的，粘进来是什么样不好预测，而不认识分隔符的后果是整串被
 * 当成一个模型 id，然后调用时报 model not found——一个完全看不出原因的错。
 *
 * 刻意不按空格切：`qwen2.5:14b` 这类 id 里没有空格，但用户可能顺手写成
 * `llama3.1 (本地)`，按空格切会得到一个叫 `(本地)` 的模型。
 */
export function parseModels(raw: string): ModelChoice[] {
  const out: ModelChoice[] = []
  for (const part of raw.split(/[,，;；\n\r]/)) {
    const id = part.trim()
    if (!id) continue
    // 重复的去掉：清单是手填的，粘两遍很常见，两个同名项在选择器里会
    // 一起高亮（当前值是按 id 比的），看着像 bug
    if (out.some((m) => m.id === id)) continue
    out.push({ id, name: id }) // 没有别的名字可用，id 本身就是用户认得的东西
  }
  return out
}

/** 解析某一家。认不出 id 返回 undefined。 */
export function entry(id: string, get: Lookup): VendorEntry | undefined {
  if (id === CUSTOM_ID) {
    const searchTool = val(get, CUSTOM_SEARCH_TOOL)
    return {
      id: CUSTOM_ID,
      name: CUSTOM_NAME,
      // 末尾斜杠要去掉：拼的是 `${baseUrl}/chat/completions`，用户粘进来
      // 的地址常带一个斜杠，不去就成了 `//chat/completions`
      baseUrl: val(get, CUSTOM_BASE_URL).replace(/\/+$/, ''),
      models: parseModels(val(get, CUSTOM_MODELS)),
      nativeSearch: searchTool ? { kind: 'tool-type', toolType: searchTool } : NONE,
    }
  }
  const v = find(id)
  if (!v) return undefined
  return {
    id: v.id,
    name: v.name,
    baseUrl: v.baseUrl,
    models: v.models.map((m) => ({ ...m })),
    nativeSearch: v.nativeSearch,
  }
}

/**
 * 模型选择器要显示的全部条目。
 *
 * 内置九家总是在列（哪怕没配 key），自定义端点只在填了模型清单时出现——
 * 没填的话它一个模型都没有，出现在列表里也是个空组。
 *
 * 「列出来的能不能真的用」不在这里判断：那是 resolveSelection 的事，
 * 它会报出缺的具体是什么（key 还是地址）。列表这边宽松、调用那边严格，
 * 是因为反过来会得到「我的模型填了怎么不出现」这种查不下去的现象。
 */
export function catalog(get: Lookup): VendorEntry[] {
  const out = ALL.map((v) => entry(v.id, get)!).filter(Boolean)
  const custom = entry(CUSTOM_ID, get)
  if (custom && custom.models.length > 0) out.push(custom)
  return out
}

/**
 * 这家配好了没有。
 *
 * 判据按类型不同：
 *   • 内置厂商：填了 key 就算（地址是固定的）
 *   • 自定义端点：地址 + 至少一个模型。不要求 key——本地跑的
 *     Ollama / LM Studio 不校验 authorization
 */
export function isConfigured(vendorId: string, get: Lookup): boolean {
  if (vendorId === CUSTOM_ID) {
    const e = entry(CUSTOM_ID, get)
    return !!e && e.baseUrl !== '' && e.models.length > 0
  }
  const key = apiKeySetting(vendorId)
  return key !== undefined && val(get, key) !== ''
}

/**
 * 第一个配好的厂商。
 *
 * 顺序是 ALL 的顺序，自定义端点排最后——内置九家优先保证了「老配置（只有
 * DeepSeek key）行为不变」，而自定义端点是个显式选择，用户配了它通常也会
 * 去选它的模型，不需要靠这个兜底顺序抢到第一。
 */
export function firstConfigured(get: Lookup): string | undefined {
  const ids = [...ALL.map((v) => v.id), CUSTOM_ID]
  return ids.find((id) => isConfigured(id, get))
}

/** 一次调用要用哪个厂商、哪个模型。 */
export interface Selection {
  /** 内置厂商的 id，或者 CUSTOM_ID */
  vendorId: string
  model: string
}

/**
 * resolveSelection 的结果：能直接塞进 buildEnv 的三个值。
 *
 * 不直接改一份 Config——那是 src/ 的类型，零修改约束下不能碰它的构造
 * 方式。这一层只产出「DEEPSEEK_* 三个环境变量该填什么」，落地在
 * config-env.ts 的 buildEnv 里。
 */
export interface ResolvedProvider {
  apiKey: string
  baseUrl: string
  model: string
  nativeSearch: NativeSearch
}

/**
 * 把选择解析成可用的凭据，缺东西时抛错说明缺的是哪一样。
 *
 * `get` 用来读凭据（key、自定义端点的地址）。每次调用都读一次而不是
 * 缓存：用户可以在设置里填一把新 key，那之后这一轮就该用上。
 *
 * 缺东西时抛错而不是静默回落到默认厂商——静默回落的后果是用户选了
 * Anthropic、界面上显示 Anthropic，实际却在用 DeepSeek 回答，而这个错
 * 完全看不见。
 */
export function resolveSelection(sel: Selection, get: Lookup): ResolvedProvider {
  const e = entry(sel.vendorId, get)
  if (!e) throw new Error(`没有叫「${sel.vendorId}」的厂商`)

  if (e.baseUrl === '') {
    // 只有自定义端点会走到这儿（内置的地址是常量）
    throw new Error('自定义端点还没填地址（设置 → 模型），比如 http://localhost:11434/v1')
  }
  if (sel.model.trim() === '') {
    throw new Error(`${e.name} 还没选模型（对话框左下角）`)
  }

  // 模型必须属于这家厂商。
  //
  // ## 为什么这条校验非有不可
  //
  // 少了它，`{vendorId:'anthropic', model:'deepseek-reasoner'}` 这种组合会
  // 一路通过，然后拿 **Anthropic 的地址 + Anthropic 的 key + DeepSeek 的
  // 模型名** 去发请求。服务端回的是「Invalid Anthropic API Key」——
  // 一个指向完全错误方向的报错：key 是好的，错的是模型名。
  // 用户会去反复检查、重新生成那把 key，而问题压根不在那儿。
  //
  // 这种脏组合真的会出现（实测撞到过）：设置页的「导入」把厂商设成
  // anthropic、又把探测到的模型名原样写进 ACTIVE_MODEL，两者来自不同的
  // 来源、谁都没校验过对方。UI 的选择器不会产生它（那边一次点击同时决定
  // 两个值），但它不是唯一的写入口。
  //
  // 自定义端点豁免：它的模型清单是用户自己填的一行字符串（CUSTOM_MODELS），
  // 填了个没在清单里的名字是他自己的事 —— 那家端点认不认由它回答，
  // 我们没有权威清单可比。
  if (sel.vendorId !== CUSTOM_ID && !e.models.some((m) => m.id === sel.model)) {
    const known = e.models.map((m) => m.id).join('、')
    throw new Error(
      `${e.name} 没有叫「${sel.model}」的模型（对话框左下角重新选一个）。它支持：${known}`,
    )
  }

  const keySetting = apiKeySetting(sel.vendorId)
  const key = keySetting ? val(get, keySetting) : ''
  // key 对内置厂商是必填，对自定义端点不是——本地跑的服务（Ollama /
  // LM Studio / vLLM 默认配置）根本不看 authorization
  if (key === '' && sel.vendorId !== CUSTOM_ID) {
    const console = find(sel.vendorId)?.console ?? ''
    throw new Error(`还没填 ${e.name} 的 API Key（设置 → 模型），去 ${console} 领一个`)
  }

  return { apiKey: key, baseUrl: e.baseUrl, model: sel.model, nativeSearch: e.nativeSearch }
}
