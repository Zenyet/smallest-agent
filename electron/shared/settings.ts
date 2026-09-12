import type { DesktopSettings } from '../main/config-env'

export const RESTART_KEYS = ['NOTES_DIR', 'EMBEDDING_MODEL', 'HF_ENDPOINT'] as const
export const SETTING_DEFAULTS: DesktopSettings = {
  STREAM: '1', LLM_CACHE: '1', SUBAGENT: '1', AUTO_EXTRACT_FACTS: '1',
  MAX_TURNS: '10', MAX_RETRIES: '2', MAX_CONTEXT_TOKENS: '2000', KEEP_RECENT: '6',
  TEMPERATURE: '0', NOTES_DIR: './notes', EMBEDDING_MODEL: 'Xenova/multilingual-e5-small',
}
export const NUMBER_RULES: Record<string, { min: number; integer?: boolean; max?: number }> = {
  MAX_TURNS: { min: 1, integer: true }, MAX_RETRIES: { min: 0, integer: true },
  MAX_CONTEXT_TOKENS: { min: 1, integer: true }, KEEP_RECENT: { min: 1, integer: true },
  TEMPERATURE: { min: 0, max: 2 },
}
export function numberError(key: string, value: string): string | undefined {
  const rule = NUMBER_RULES[key]
  if (!rule || !value.trim()) return
  const n = Number(value)
  if (!Number.isFinite(n) || n < rule.min || (rule.max !== undefined && n > rule.max)
    || (rule.integer && !Number.isInteger(n))) {
    return rule.integer ? `请输入不小于 ${rule.min} 的整数` : `请输入 ${rule.min}–${rule.max} 之间的数字`
  }
}
export interface SettingsStatus {
  pendingKeys: string[]
  applied: DesktopSettings
  inheritedKeys: string[]
  effective?: DesktopSettings
}
export interface ConnectionCheck {
  ok: boolean
  model: string
  checkedAt: number
  message: string
}
