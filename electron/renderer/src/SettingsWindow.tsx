// 设置窗口的外壳。原来这是 App.tsx 里一个 fixed inset-0 的浮层，
// 现在是独立 BrowserWindow 的根组件（macOS ⌘, 的原生做法）。
//
// 它承担原来 App.tsx 替 SettingsPanel 做的两件事：
//   1. 什么时候才敢把 settings 交给面板 —— SettingsPanel 的 draft 只在挂载时
//      从 props 播种一次，所以在 settings 真正读回来之前不能渲染它。否则用户
//      看到一排空输入框，一改就把空配置写回磁盘，把本来好的 key 冲掉。
//      这个坑 App.tsx 里注释了一大段，搬窗口不能把它丢了。
//   2. saveSettings 的往返 + 失败时把错误抛回面板（面板靠 onSave reject 显示验证错误）。
import { useCallback, useEffect, useState } from 'react'
import { SettingsPanel } from './components/SettingsPanel'
import { api } from './api'
import type { DesktopSettings, RuntimeStatusEvent } from '../../shared/channels'

export function SettingsWindow() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // getSettings 的 handler 要等主进程 createRuntime 跑完（setupIpcHandlers）才注册，
  // 失败路径下则由 index.ts 的 catch 补注册。两种情况都是"等 phase 落定"。
  // ⌘, 可以在启动过程中被按下（模型首次下载要几十秒，用户完全有时间去开设置），
  // 那时候直接 invoke 会砸在 "No handler registered" 上，settings 永远停在 null。
  // 所以先问 phase，落定了再拉设置。
  const [phase, setPhase] = useState<RuntimeStatusEvent['phase'] | null>(null)

  useEffect(() => {
    // 拉一次 + 订阅：拉是为了这个窗口开得比状态变化晚（大概率如此），
    // 订阅是为了它开得比状态变化早（启动中按 ⌘,）。少哪一半都会漏。
    api
      .getRuntimeStatus()
      .then((s) => setPhase(s.phase))
      .catch((err: unknown) => {
        setLoadError(`读取运行状态失败：${err instanceof Error ? err.message : String(err)}`)
      })
    return api.onRuntimeStatus((s) => setPhase(s.phase))
  }, [])

  useEffect(() => {
    // failed 也要放行：启动失败最常见的原因就是没配 API Key，
    // 这时候设置窗口正是用户唯一的出路，不能跟着一起罢工。
    if (phase !== 'ready' && phase !== 'failed') return
    api
      .getSettings()
      .then(setSettings)
      .catch((err: unknown) => {
        // 不能静默：这个项目已经在 Task 13/15 因为丢 .catch 栽过两次。
        setLoadError(`读取设置失败：${err instanceof Error ? err.message : String(err)}`)
      })
  }, [phase])

  // 别的窗口/别的途径改了设置时跟着更新。本窗口自己保存也会收到这条广播，
  // 但那时 draft 已经是新值了，setSettings 只是让 needsRestart 的基线（它比较
  // draft 和 settings）跟着推进 —— 这正是想要的：保存成功后警告应该消失。
  useEffect(() => api.onSettingsChanged(setSettings), [])

  const save = useCallback(async (patch: DesktopSettings) => {
    // 失败不在这里吞：SettingsPanel 靠 onSave 的 reject 把验证错误显示在字段旁边。
    const next = await api.saveSettings(patch)
    setSettings(next)
  }, [])

  // 面板的关闭按钮在独立窗口里就是关窗口。window.close() 在 Electron 里
  // 对 BrowserWindow 生效（不像浏览器里那样只能关自己 open 的窗口）。
  const close = useCallback(() => window.close(), [])

  if (loadError) {
    return (
      <div className="settings flex h-full flex-1 flex-col bg-canvas">
        <div aria-hidden className="h-9 shrink-0 [-webkit-app-region:drag]" />
        <div className="flex flex-1 items-center justify-center px-8">
          <p
            className="settings__error m-0 rounded-card bg-red-tint px-2.5 py-1.5 text-center text-[12.5px] text-red shadow-hairline"
            role="alert"
          >
            {loadError}
          </p>
        </div>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="settings flex h-full flex-1 flex-col bg-canvas">
        {/* 这一条同时是红绿灯让位和拖拽区：设置窗口也是 hiddenInset，
            没有原生标题栏，不自己画一块 drag 就完全拖不动。 */}
        <div aria-hidden className="h-9 shrink-0 [-webkit-app-region:drag]" />
        <div className="flex flex-1 items-center justify-center">
          <p className="m-0 text-[12.5px] text-ink-3" aria-live="polite">
            读取设置中…
          </p>
        </div>
      </div>
    )
  }

  return (
    <SettingsPanel
      settings={settings}
      onSave={save}
      onClose={close}
      onRestart={() => api.restartApp()}
    />
  )
}
