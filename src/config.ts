// ============================================================================
// config.ts —— 环境变量驱动的运行时配置
// ----------------------------------------------------------------------------
// 职责：把散落在 .env 里的字符串变量聚合成一个强类型 Config 对象。
// 这里是「单一真相源」——所有模块从 Config 取参数，不直接读 process.env，
// 便于测试（传入假 env）和参数校验集中管理。
//
// 注：SYSTEM_PROMPT 写在这里是因为它是「配置」的一部分，
// 实际上可以在不同 Stage 中扩展（如 Stage 3 加了引用来源要求）。
// ============================================================================

import type { Config, NativeSearch } from './types'

// 系统提示：约束模型行为的「全局指令」，在每次 callModel 时作为首条 system 消息注入。
// 两条关键约束：
//   1. 有外部数据需求时调工具，不要凭空编造（防幻觉）
//   2. 用到 RAG 检索结果时注明来源文件名（Stage 3 加的溯源要求）
export const SYSTEM_PROMPT =
  '你是一个简洁、诚实的中文助手。当需要外部信息（如天气、笔记）时调用提供的工具，不要凭空编造；信息足够时直接回答。' +
  '当回答用到 search_notes 或读取文件得到的内容时，在末尾注明来源文件名（如：来源：01-rag.md）。'

// 从环境变量读取数字，带默认值 + 类型校验。
// 单独抽成函数是因为数字型 env 都需要同样的「undefined 用默认值 / 非数字报错」逻辑，
// 参数 name 只用来生成可读的错误消息。
function numFromEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  // Number() 会把空字符串转成 0、把非数字字符串转成 NaN；
  // isFinite 排除 NaN / Infinity，确保拿到的是真实数字。
  if (!Number.isFinite(n)) {
    throw new Error(`${name} 必须是数字，得到的是 "${value}"`)
  }
  return n
}

// loadConfig：唯一入口，把 env 变量映射成 Config 对象。
// 默认读 process.env，但接受任意 env 对象（方便测试传入 mock env）。
// 只有 DEEPSEEK_API_KEY 是强制必填项，其余都有合理默认值。
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { allowMissingApiKey?: boolean } = {}): Config {
  const apiKey = env.DEEPSEEK_API_KEY ?? ''
  if (!apiKey && !options.allowMissingApiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY（把 .env.example 复制成 .env 并填好）')
  }
  return {
    apiKey,
    baseURL: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    // temperature=0 → 输出更确定/一致，适合工具调用场景；调高会更「有创意」但不稳定
    temperature: numFromEnv(env.TEMPERATURE, 0, 'TEMPERATURE'),
    maxTurns: numFromEnv(env.MAX_TURNS, 10, 'MAX_TURNS'),
    systemPrompt: SYSTEM_PROMPT,
    // Stage 3 RAG：本地 embedding 模型，multilingual-e5-small 体积小、中文效果够用
    embeddingModel: env.EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small',
    notesDir: env.NOTES_DIR ?? './notes',
    hfEndpoint: env.HF_ENDPOINT,
    localModelPath: env.LOCAL_MODEL_PATH,
    // Stage 2 记忆：sessionId 决定读写哪个会话文件
    sessionId: env.SESSION_ID ?? 'default',
    sessionsDir: env.SESSIONS_DIR ?? './.sessions',
    maxContextTokens: numFromEnv(env.MAX_CONTEXT_TOKENS, 2000, 'MAX_CONTEXT_TOKENS'),
    keepRecent: numFromEnv(env.KEEP_RECENT, 6, 'KEEP_RECENT'),
    // fallbackModel 优先用独立变量，没设就跟主模型一样——退化成「不切换」
    fallbackModel: env.FALLBACK_MODEL ?? env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    maxRetries: numFromEnv(env.MAX_RETRIES, 2, 'MAX_RETRIES'),
    // LLM_CACHE=0 才关闭缓存；其他任何值（包括不设）都视为开启
    cacheEnabled: env.LLM_CACHE !== '0',
    cacheDir: env.LLM_CACHE_DIR ?? './.llm-cache',
    // STREAM=0 才关闭流式；同上，默认开启
    stream: env.STREAM !== '0',
    // 默认开，同 STREAM / LLM_CACHE 的约定（不写 = 开）
    autoExtractFacts: env.AUTO_EXTRACT_FACTS !== '0',
    // 厂商自带搜索的开关形状，由桌面端按选中的厂商写进来（见
    // electron/main/config-env.ts）。CLI 不写这一项，所以通常是 undefined。
    nativeSearch: parseNativeSearch(env.NATIVE_SEARCH),
    // 认不出的值当成 'chat'（默认那条路径）—— 手改坏一个环境变量
    // 不该让应用起不来，同 parseNativeSearch 的理由
    protocol: env.LLM_PROTOCOL === 'responses' ? 'responses' : 'chat',
  }
}

/**
 * 解 NATIVE_SEARCH。
 *
 * **坏值一律当成「没有」，不抛错**：这一项是可选增强（少了只是用不上厂商
 * 自带的搜索，我们自己那个 web_search 还在），而抛错会让整个应用起不来。
 * 手改坏一个 JSON 不该是启动失败的理由 —— 那和缺 API key 不是一个级别的问题。
 */
function parseNativeSearch(raw: string | undefined): NativeSearch | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw) as NativeSearch
    // 只认这四种 kind。多一层判断是因为 JSON.parse 的结果是 any，
    // 而一个 {kind:'乱写'} 会一路传到 llm.ts 的 switch 里静默不生效
    if (
      v &&
      (v.kind === 'none' ||
        v.kind === 'enable-flag' ||
        v.kind === 'tool-type' ||
        v.kind === 'builtin-function')
    ) {
      return v
    }
    return undefined
  } catch {
    return undefined
  }
}
