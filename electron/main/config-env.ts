// 桌面端的设置面板不需要改 src/config.ts —— loadConfig(env) 本来就接受 env 参数，
// 所以这里只负责把「用户在 UI 里填的东西」拼成 env 形状交给它。
// 这是「零修改复用」的关键接缝之一。

export interface DesktopSettings {
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  DEEPSEEK_MODEL?: string
  FALLBACK_MODEL?: string
  NOTES_DIR?: string
  EMBEDDING_MODEL?: string
  HF_ENDPOINT?: string
  STREAM?: string
  LLM_CACHE?: string
  MAX_RETRIES?: string
  MAX_TURNS?: string
  MAX_CONTEXT_TOKENS?: string
  KEEP_RECENT?: string
}

// 设置面板要渲染哪些字段，由这份清单驱动（Task 15 用）
export const SETTING_KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'FALLBACK_MODEL',
  'NOTES_DIR',
  'EMBEDDING_MODEL',
  'HF_ENDPOINT',
  'STREAM',
  'LLM_CACHE',
  'MAX_RETRIES',
  'MAX_TURNS',
  'MAX_CONTEXT_TOKENS',
  'KEEP_RECENT',
] as const satisfies readonly (keyof DesktopSettings)[]

// 目录不走用户设置：打包后应用目录只读，必须落在 userData 下。
export interface UserPaths {
  sessionsDir: string
  cacheDir: string
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
  // 放在最后写，确保用户设置里就算混进了同名 key 也覆盖不掉
  env.SESSIONS_DIR = paths.sessionsDir
  env.LLM_CACHE_DIR = paths.cacheDir
  return env
}
