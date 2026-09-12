// electron-store 把设置持久化到 userData。
// API Key 存明文 —— 个人本地工具，不引 keytar 以免增加跨平台打包复杂度（README 里注明）。
import Store from 'electron-store'
import type { DesktopSettings } from './config-env'
import { applySettingsUpdate } from './settings-update'

const store = new Store<{ settings: DesktopSettings }>({ defaults: { settings: {} } })

export function getSettings(): DesktopSettings {
  return store.get('settings')
}

export function saveSettings(patch: Partial<DesktopSettings>, unset: readonly string[] = []): DesktopSettings {
  const next = applySettingsUpdate(store.get('settings'), patch, unset)
  store.set('settings', next)
  return next
}
