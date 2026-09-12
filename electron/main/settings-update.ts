import { SETTING_KEYS, type DesktopSettings } from './config-env'
import { validateSettingsPatch } from './settings-validate'
import { numberError, RESTART_KEYS, SETTING_DEFAULTS, type SettingsStatus } from '../shared/settings'

export function validateSettingsUpdate(raw: unknown, rawUnset: unknown = []) {
  if (Array.isArray(raw)) throw new Error('设置必须是对象')
  const result = validateSettingsPatch(raw)
  if (!Array.isArray(rawUnset) || rawUnset.some(k => typeof k !== 'string' || !(SETTING_KEYS as readonly string[]).includes(k))) {
    throw new Error('无法移除未知的设置项')
  }
  const unset = [...new Set(rawUnset as string[])]
  if (unset.some(k => Object.hasOwn(result.valid, k))) throw new Error('同一个设置不能同时保存和移除')
  for (const [key, value] of Object.entries(result.valid)) {
    const error = numberError(key, value!)
    if (error) throw new Error(`${key}：${error}`)
  }
  return { ...result, unset }
}
export function applySettingsUpdate(current: DesktopSettings, patch: DesktopSettings, unset: readonly string[] = []): DesktopSettings {
  const next = { ...current, ...patch }
  for (const key of unset) delete next[key]
  return next
}
/** Compare against the main-process startup snapshot, never the renderer's saved form. */
export function createSettingsStatus(base: NodeJS.ProcessEnv, startup: DesktopSettings) {
  const effective = (settings: DesktopSettings, key: string) => settings[key] || base[key] || SETTING_DEFAULTS[key] || ''
  const applied = Object.fromEntries(RESTART_KEYS.map(key => [key, effective(startup, key)]))
  return (settings: DesktopSettings): SettingsStatus => ({
    applied,
    pendingKeys: RESTART_KEYS.filter(key => effective(settings, key) !== applied[key]),
    inheritedKeys: SETTING_KEYS.filter(key => !settings[key] && Boolean(base[key])),
    effective: Object.fromEntries(Object.keys(SETTING_DEFAULTS).map(key => [key, effective(settings, key)])),
  })
}
