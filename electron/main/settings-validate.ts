// 验证和约束逻辑单独成模块：ipc-handlers.ts 只做接线，这里的纯函数可被直接测试。
import { SETTING_KEYS, type DesktopSettings } from './config-env'

// 数字型设置：这些字段对应 src/config.ts 里的 numFromEnv 调用，
// 值必须能被 Number() 转成有限数，否则 loadConfig 会在启动时抛错。
const NUMERIC_SETTINGS = new Set(['MAX_RETRIES', 'MAX_TURNS', 'MAX_CONTEXT_TOKENS', 'KEEP_RECENT', 'TEMPERATURE'])

// 布尔型设置：src/config.ts 用 `!== '0'` 判断真假，只区分 '0' 和其它值。
// 允许 '0' / '1' / '' 这三个实际被区分的值，拒绝其它随意字符串（避免误导）。
const BOOLEAN_SETTINGS = new Set(['STREAM', 'LLM_CACHE'])

export interface ValidationResult {
  valid: DesktopSettings
  dropped: string[] // 被跳过的未知 key 列表，用于日志或 UI 反馈
}

// 验证 saveSettings 的输入：只接受已知的 SETTING_KEYS，且值必须是字符串；
// 数字型字段额外要求能解析成有限数，布尔型字段只接受 '0'/'1'/''。
// 拒绝其它 key 和非法值，避免无效数据污染持久化存储、或在启动时导致不可恢复的错误。
//
// ⚠️ 安全注意：这个函数处理的 patch 可能包含 DEEPSEEK_API_KEY（明文）。
// 永远不要 log/stringify/echo 整个 patch 对象或其 values —— 只记录 keys。
export function validateSettingsPatch(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('设置必须是对象')
  }

  const patch: DesktopSettings = {}
  const dropped: string[] = []
  const allowed = new Set(SETTING_KEYS)

  for (const [key, value] of Object.entries(raw)) {
    // 未知 key：静默跳过而不是整体拒绝（renderer 可能比 main 更新，多出的字段不该让整个保存失败），
    // 但记录下来，让调用方有机会观察到不匹配（Task 15 review [Important] 要求）。
    if (!allowed.has(key as keyof DesktopSettings)) {
      dropped.push(key)
      continue
    }

    if (typeof value !== 'string') {
      throw new Error(`${key} 的值必须是字符串，得到的是 ${typeof value}`)
    }

    // 去掉纯空白：避免 '   ' 这种输入通过 buildEnv 的空串检查，实际上把配置项设成了空白。
    const trimmed = value.trim()
    if (trimmed === '') continue

    // 数字型字段：必须能被 Number() 转成有限数，否则 src/config.ts 的 numFromEnv 会在启动时抛错，
    // 且因为值已经持久化，用户会被锁在启动失败状态（重启也救不回来）。在这里拦住。
    if (NUMERIC_SETTINGS.has(key)) {
      const n = Number(trimmed)
      if (!Number.isFinite(n)) {
        throw new Error(`${key} 必须是数字，得到的是 "${trimmed}"`)
      }
    }

    // 布尔型字段（STREAM / LLM_CACHE）：src/config.ts 用 `!== '0'` 判断，
    // 实际区分的只有 '0'（关）和其它任何值（开）。只接受 '0' / '1' / ''，
    // 拒绝其它随意字符串（'true' / 'maybe' 这些会被当成"开"，但容易误导）。
    if (BOOLEAN_SETTINGS.has(key)) {
      if (!['0', '1', ''].includes(trimmed)) {
        throw new Error(`${key} 只接受 '0'（关闭）或 '1'（开启），得到的是 "${trimmed}"`)
      }
    }

    patch[key as keyof DesktopSettings] = trimmed
  }

  return { valid: patch, dropped }
}
