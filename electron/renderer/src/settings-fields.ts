// ============================================================================
// settings-fields.ts —— 设置页字段的标签/说明/分组
// ----------------------------------------------------------------------------
// 移植自 rs/ui/src/settings.rs 的 label() / hint() / groups() 三个函数。
// 六个分区（通用/能力/模型/Agent/检索/高级）里，五个能直接搬——它们的
// 字段本来就存在，只是散在一张平铺表里，现在按 gpui 的分组重排。
//
// **Agents 分区没有搬**：它不是表单，是「有哪些引擎可选」的只读列表，
// 数据来自 gpui 侧的 providers.json（rs/ui/src/providers.rs），那是
// provider 抽象 + ACP 外部 CLI 那个子项目（1026 行）才有的东西，TS 侧
// 目前不存在。这里放一个诚实的占位说明，不假装有那个能力——
// 见 SettingsPanel.tsx 里 Agents 分区的渲染。
// ============================================================================

// vendors.ts 不 import 任何 electron API（纯数据 + 纯函数），所以 renderer
// 能直接用它——和 renderer 已经在 import main/projects 的 groupSessions 同理。
import { ALL, CUSTOM_KEYS, keyEnvs } from '../../main/vendors'
import type { IconName } from './components/Icon'

export type SectionId = 'general' | 'capabilities' | 'provider' | 'agents' | 'retrieval' | 'advanced'

/**
 * 分区导航的图标，对上 gpui 侧 SettingsSection::icon()。
 *
 * 导航行带图标而不是纯文字：设置打开时它占的是侧边栏那一栏，
 * 而那一栏的另一种内容（会话列表的项目行）是带图标的 ——
 * 两者切换时行的形状不该跳。
 */
export const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'capabilities', label: '能力', icon: 'terminal' },
  { id: 'provider', label: '凭据', icon: 'globe' },
  { id: 'agents', label: 'Agent 模式', icon: 'bot' },
  { id: 'retrieval', label: '检索', icon: 'search' },
  { id: 'advanced', label: '高级', icon: 'sliders' },
]

/**
 * 每个分区里的字段，按组排列。每组一张卡片，组名是卡片头。
 *
 * 分组把「哪些字段是一类东西」交给版面：凭据一张卡、模型一张卡，
 * 卡片头一眼扫过去就知道下面几行是一类东西（gpui 侧同一条理由）。
 *
 * provider 分区不在这张表里——它的字段是按厂商动态生成的（当前选中
 * 那家的凭据栏），见 SettingsPanel.tsx。agents 分区同理，它不是表单。
 */
/**
 * 高级参数：默认藏起来，由凭据页那个 Switch 打开。
 *
 * ## 为什么不直接放进「高级」分区
 *
 * 那一页是「让 agent 试到什么程度」（轮数、重试、压缩）—— 和「模型怎么采样」
 * 不是一类东西。温度属于「这家厂商的这个模型怎么答」，它的位置贴着凭据，
 * 而不是贴着 agent 循环。
 *
 * ## 为什么默认藏起来
 *
 * 绝大多数人一辈子不需要动温度，而它摆在 key 输入框旁边会让「配置模型」
 * 这件事看起来比实际复杂 —— 用户以为这些都得填。Switch 是「我知道我在做
 * 什么」的显式表态。
 */
export const ADVANCED_MODEL_KEYS = ['TEMPERATURE'] as const

export const GROUPS: Partial<Record<SectionId, [string, string[]][]>> = {
  general: [['输出行为', ['STREAM', 'LLM_CACHE']]],
  // 凭据页**不在这张静态表里** —— 它的字段是按「select 里选了哪家」动态
  // 生成的（内置九家各一栏 key；自定义端点四栏），见 SettingsPanel.tsx。
  //
  // 那个 select 选的不是「谁答我的问题」，只是这张表单填哪家的 key。
  // 「用哪家答话」由 composer 左下角的选择器决定 —— 两处混用会让同一个
  // 事实有两个来源，而它们迟早不一致（撞出过 {厂商:anthropic,
  // 模型:deepseek-reasoner} 这种脏组合）。
  //
  // 曾经这里列过 keyEnvs() + CUSTOM_KEYS（九家全摊开）。留在表里的后果是
  // 两个渲染器都跑，同一个 key 出现两个 input、**id 还一样** —— 点标签
  // 聚焦到哪个由文档顺序决定。别加回来。
  capabilities: [['网络搜索', ['BRAVE_API_KEY', 'TAVILY_API_KEY']]],
  retrieval: [
    ['笔记来源', ['NOTES_DIR']],
    ['嵌入模型', ['EMBEDDING_MODEL', 'HF_ENDPOINT']],
  ],
  advanced: [
    // 这两个都是「让 agent 试到什么程度」，同一张卡。拆成两张一字段的卡
    // 会让四个字段占三张卡，版面比内容还多
    ['循环与重试', ['MAX_TURNS', 'MAX_RETRIES']],
    ['上下文压缩', ['MAX_CONTEXT_TOKENS', 'KEEP_RECENT']],
  ],
}

/**
 * 人话标题。
 *
 * 厂商的 key 栏用厂商名（「Anthropic」）而不是「API Key」：九家现在同处
 * 一张卡，全叫「API Key」的话九行长得一模一样，只能靠下面那行小字的键名
 * 分辨谁是谁。
 *
 * 兜底返回空串，调用方退回显示键名本身（丑但可用），不是一行空白。
 */
export function label(key: string): string {
  const vendor = ALL.find((v) => v.keyEnv === key)
  if (vendor) return vendor.name
  switch (key) {
    case 'CUSTOM_BASE_URL':
      return 'API 端点'
    case 'BRAVE_API_KEY':
      return 'Brave Search Key'
    case 'TAVILY_API_KEY':
      return 'Tavily Key'
    case 'CUSTOM_API_KEY':
      return 'API Key'
    case 'CUSTOM_MODELS':
      return '模型清单'
    case 'CUSTOM_SEARCH_TOOL':
      return '联网搜索工具'
    case 'NOTES_DIR':
      return '笔记目录'
    case 'EMBEDDING_MODEL':
      return '嵌入模型'
    case 'HF_ENDPOINT':
      return 'HuggingFace 镜像'
    case 'STREAM':
      return '流式输出'
    case 'LLM_CACHE':
      return '磁盘缓存'
    case 'MAX_RETRIES':
      return '重试次数'
    case 'MAX_TURNS':
      return '最大轮数'
    case 'MAX_CONTEXT_TOKENS':
      return '上下文上限'
    case 'KEEP_RECENT':
      return '保留最近条数'
    case 'TEMPERATURE':
      return '采样温度'
    default:
      return ''
  }
}

/**
 * 必填字段。空——加了多厂商之后没有单个字段是必填的，loadConfig 要的是
 * 「至少配一家」，那不是任何一栏自己的属性。九家里每家都标红星会变成
 * 噪音，而且是错的（填了一家就够）。「一家都没配」由厂商卡的卡片头说明。
 */
export const REQUIRED: readonly string[] = []

/** 每个字段的说明，逐条抄自 gpui 侧（那边又是逐条抄自 Electron 版的 HINTS）。 */
export function hint(key: string): string | undefined {
  const v = ALL.find((vendor) => vendor.keyEnv === key)
  if (v) return `在 ${v.console} 领取`
  switch (key) {
    case 'BRAVE_API_KEY':
      return '配了才能搜全网。留空的话 web_search 只能搜维基百科。在 https://brave.com/search/api 领取'
    case 'TAVILY_API_KEY':
      return '同上，二选一即可。在 https://tavily.com 领取'
    case 'CUSTOM_BASE_URL':
      return 'OpenAI 兼容端点，不含 /chat/completions。比如 http://localhost:11434/v1（Ollama）'
    case 'CUSTOM_API_KEY':
      return '本地服务通常不校验，可留空'
    case 'CUSTOM_MODELS':
      return '用逗号或换行分隔多个模型 id'
    case 'CUSTOM_SEARCH_TOOL':
      return '这家端点自带的搜索工具 type（比如 openrouter:web_search），没有就留空'
    case 'NOTES_DIR':
      return 'RAG 检索的笔记目录，默认 ./notes'
    case 'EMBEDDING_MODEL':
      return '默认 Xenova/multilingual-e5-small'
    case 'HF_ENDPOINT':
      return '国内连不上 HuggingFace 时填 https://hf-mirror.com'
    case 'STREAM':
      return '填 0 关闭流式输出，填 1 开启'
    case 'LLM_CACHE':
      return '填 0 关闭磁盘缓存，填 1 开启'
    case 'MAX_RETRIES':
      return '单个模型调用失败时的重试次数，默认 2'
    case 'MAX_TURNS':
      return 'agent 循环最多转几圈，默认 10'
    case 'MAX_CONTEXT_TOKENS':
      return '历史超过这个估算值就压缩，默认 2000'
    case 'KEEP_RECENT':
      return '压缩时保留最近几条，默认 6'
    case 'TEMPERATURE':
      return '0 = 每次都给最确定的答案，适合调工具；调高更有创意但不稳定。默认 0'
    default:
      return undefined
  }
}

/** 这两个字段改了需要重建索引/重启应用才生效。 */
export const RESTART_REQUIRED = ['NOTES_DIR', 'EMBEDDING_MODEL'] as const
