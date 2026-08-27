// 桌面端的设置面板不需要改 src/config.ts —— loadConfig(env) 本来就接受 env 参数，
// 所以这里只负责把「用户在 UI 里填的东西」拼成 env 形状交给它。
// 这是「零修改复用」的关键接缝之一。

import {
  CUSTOM_KEYS,
  DEFAULT_VENDOR,
  defaultModel,
  keyEnvs,
  resolveSelection,
  type Lookup,
} from './vendors'

export interface DesktopSettings {
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  DEEPSEEK_MODEL?: string
  NOTES_DIR?: string
  EMBEDDING_MODEL?: string
  HF_ENDPOINT?: string
  STREAM?: string
  LLM_CACHE?: string
  MAX_RETRIES?: string
  MAX_TURNS?: string
  MAX_CONTEXT_TOKENS?: string
  KEEP_RECENT?: string
  // 采样温度。core 早就读它（src/config.ts 的 TEMPERATURE），只是一直没
  // 暴露到设置页 —— 加进 SETTING_KEYS 之后 buildEnv 会自动透传。
  TEMPERATURE?: string
  // 当前选中的厂商 + 模型。空 = 还没选，走 DEFAULT_VENDOR 兜底
  // （见 resolveActiveProvider）。
  ACTIVE_VENDOR?: string
  ACTIVE_MODEL?: string
  // 自定义端点那四个键，见 vendors.ts 的 CUSTOM_KEYS
  CUSTOM_BASE_URL?: string
  CUSTOM_API_KEY?: string
  CUSTOM_MODELS?: string
  CUSTOM_SEARCH_TOOL?: string
  // --- 多厂商 key（照 gpui 的 vendors.rs 移植，见 vendors.ts 文件头）---
  //
  // 每家一个 key 键，所以用户可以同时配好几家、随时切换而不用来回粘 key。
  // 键名直接是 vendors.ts 里各家的 keyEnv（比如 ANTHROPIC_API_KEY），
  // 这里没法一一列出（会跟着 vendors.ts 的 ALL 变），所以用字符串索引
  // 签名兜底——SETTING_KEYS 才是运行时渲染哪些字段的真相来源，这里
  // 只是放宽类型，让 keyof DesktopSettings 能接受任意字符串键。
  [key: string]: string | undefined
}

// 设置面板要渲染哪些字段，由这份清单驱动（Task 15 用）。
//
// DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL **不在这份清单里
// 了**——它们不再是用户直接填的字段，而是 resolveActiveProvider 在请求
// 级算出来的派生值（见下面 buildEnv 的用法）。用户面对的是「选哪家、
// 填哪家的 key」，不是「填三个叫 DEEPSEEK 的框」。
//
// gpui 那边的等价物是 render_vendor_picker：厂商的字段按 vendors::ALL
// 动态生成，不在一张静态表里——这里同理，vendorKeyEnvs 是动态拼进来的。
export const SETTING_KEYS = [
  'NOTES_DIR',
  'EMBEDDING_MODEL',
  'HF_ENDPOINT',
  'STREAM',
  'LLM_CACHE',
  'MAX_RETRIES',
  'MAX_TURNS',
  'MAX_CONTEXT_TOKENS',
  'KEEP_RECENT',
  'TEMPERATURE',
  'ACTIVE_VENDOR',
  'ACTIVE_MODEL',
  ...CUSTOM_KEYS,
  ...keyEnvs(),
] as const satisfies readonly (keyof DesktopSettings)[]

// 目录不走用户设置：打包后应用目录只读，必须落在 userData 下。
export interface UserPaths {
  sessionsDir: string
  cacheDir: string
}

/**
 * 从设置里解析出当前生效的 provider：厂商 + 模型 + 凭据。
 *
 * 对应 gpui 的 Selection::apply，但落地成三个字符串而不是改一份 Config
 * 结构体——src/ 的 Config 是零修改约束下不能碰构造方式的类型。
 *
 * ACTIVE_VENDOR 没填时退回 DEFAULT_VENDOR（deepseek）：这保住了「升级前
 * 只有一把 DEEPSEEK_API_KEY 的老用户，升级后什么都不用改」——他们的
 * key 本来就在 DEEPSEEK_API_KEY 这个键下，ALL[0] 就是 deepseek，
 * resolveSelection 会自然读到它。
 *
 * ACTIVE_MODEL 没填时用该厂商的默认模型（清单第一个）。
 */
function resolveActiveProvider(settings: DesktopSettings) {
  const get: Lookup = (key) => settings[key as keyof DesktopSettings]
  const vendorId = settings.ACTIVE_VENDOR || DEFAULT_VENDOR
  // 没选模型时用该厂商的默认模型（清单第一个）。
  //
  // 这一条是「升级前只有一把 DEEPSEEK_API_KEY 的老用户，升级后什么都不用改」
  // 的另一半：老配置里没有 ACTIVE_MODEL，不兜底的话 resolveSelection 会抛
  // 「还没选模型」，于是 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL 都不会被写进
  // env，loadConfig 只能退回它自己的硬编码默认值——对 deepseek 恰好是对的，
  // 但换成任何别家就会拿 DeepSeek 的地址去请求别家的 key。
  const model = settings.ACTIVE_MODEL || defaultModel(vendorId) || ''
  return resolveSelection({ vendorId, model }, get)
}

export function buildEnv(
  base: NodeJS.ProcessEnv,
  settings: DesktopSettings,
  paths: UserPaths,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of SETTING_KEYS) {
    const value = settings[key]
    // 空串/undefined 一律跳过：否则会把 loadConfig 里的默认值覆盖成空，
    // 例如 NOTES_DIR='' 会让 RAG 去读根目录。
    if (value === undefined || value === '') continue
    env[key] = value
  }

  // 厂商选择解析成 src/config.ts 认识的三个名字。放在遍历 SETTING_KEYS
  // 之后写：不能让某个厂商的原始 key（比如 ANTHROPIC_API_KEY）意外撞上
  // DEEPSEEK_API_KEY 这个名字覆盖掉解析结果。
  //
  // resolveActiveProvider 抛错（没选模型、没填 key）时不在这里处理——
  // 调用方（agent-runner 的 loadConfig）自然会在 loadConfig 里因为
  // DEEPSEEK_API_KEY 缺失而报 API_KEY_MISSING，是同一条既有错误路径，
  // 不需要在这儿另起一套。真正精确的报错（「还没选模型」vs「还没填
  // key」）留给设置页在选择器那一层直接呈现，见 render_provider_picker /
  // render_model_picker 在 gpui 侧的对应部分。
  try {
    const resolved = resolveActiveProvider(settings)
    env.DEEPSEEK_API_KEY = resolved.apiKey
    env.DEEPSEEK_BASE_URL = resolved.baseUrl
    env.DEEPSEEK_MODEL = resolved.model
  } catch {
    // 留空：loadConfig 会因为 DEEPSEEK_API_KEY 缺失而报出「填了才能跑」
    // 这条既有路径，用户看到的是同一句提示，不是一个新的错误码。
  }

  // 放在最后写，确保用户设置里就算混进了同名 key 也覆盖不掉
  env.SESSIONS_DIR = paths.sessionsDir
  env.LLM_CACHE_DIR = paths.cacheDir
  return env
}
