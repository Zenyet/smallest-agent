import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { SETTING_KEYS, type DesktopSettings } from '../../../main/config-env'
import type { ProviderDetection } from '../../../shared/channels'
import { api } from '../api'

// 每个字段的说明，直接对应 src/config.ts 里的默认值语义
const HINTS: Partial<Record<(typeof SETTING_KEYS)[number], string>> = {
  // 明文存储这件事以前挂在面板底部的 footer 里。footer 撤掉后没让这句消失——
  // 它是一条真实的安全披露（不引 keytar 是为了少一层跨平台打包复杂度），
  // 挪到用户实际填 key 的这一栏下面，比压在页脚更该被看到。
  DEEPSEEK_API_KEY: '以明文存在本地 userData 目录，不加密',
  DEEPSEEK_BASE_URL: '默认 https://api.deepseek.com/v1',
  DEEPSEEK_MODEL: '默认 deepseek-chat',
  FALLBACK_MODEL: '主模型连续失败时切换的备用模型',
  NOTES_DIR: 'RAG 检索的笔记目录，默认 ./notes',
  EMBEDDING_MODEL: '嵌入模型，默认 Xenova/bge-small-zh-v1.5',
  HF_ENDPOINT: '国内连不上 HuggingFace 时填 https://hf-mirror.com',
  STREAM: '填 0 关闭流式输出，填 1 开启',
  LLM_CACHE: '填 0 关闭磁盘缓存，填 1 开启',
  MAX_RETRIES: '单个模型调用失败时的重试次数，默认 2',
  MAX_TURNS: 'agent 循环最多转几圈，默认 10',
  MAX_CONTEXT_TOKENS: '历史超过这个估算值就压缩，默认 2000',
  KEEP_RECENT: '压缩时保留最近几条，默认 6',
}

// 这两个字段改了需要重建索引/重启应用才生效
const RESTART_REQUIRED = ['NOTES_DIR', 'EMBEDDING_MODEL'] as const

// 新的分组结构：General / Provider / Retrieval / Advanced
type SectionId = 'general' | 'provider' | 'retrieval' | 'advanced'

const SECTIONS: { id: SectionId; label: string; keys: readonly (typeof SETTING_KEYS)[number][] }[] = [
  { id: 'general', label: '通用', keys: ['STREAM', 'LLM_CACHE'] },
  { id: 'provider', label: 'Provider', keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'FALLBACK_MODEL'] },
  { id: 'retrieval', label: '检索', keys: ['NOTES_DIR', 'EMBEDDING_MODEL', 'HF_ENDPOINT'] },
  { id: 'advanced', label: '高级', keys: ['MAX_RETRIES', 'MAX_TURNS', 'MAX_CONTEXT_TOKENS', 'KEEP_RECENT'] },
]

export function SettingsPanel({
  settings,
  onSave,
  onClose,
  onRestart,
}: {
  settings: DesktopSettings
  onSave: (patch: DesktopSettings) => Promise<void>
  onClose: () => void
  onRestart: () => Promise<void>
}) {
  const [draft, setDraft] = useState<DesktopSettings>(settings)
  const [error, setError] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<SectionId>(SECTIONS[0].id)
  const [detections, setDetections] = useState<ProviderDetection[]>([])
  const [importing, setImporting] = useState<string | null>(null)
  const debounceTimers = useRef<Record<string, NodeJS.Timeout>>({})

  // 检测本机 provider 配置（只在打开面板时调用一次）
  useEffect(() => {
    void api.detectProviders().then(setDetections).catch((err: unknown) => {
      console.error('[provider-detect] 探测失败：', err instanceof Error ? err.message : err)
    })
  }, [])

  // 检测是否改了需要重启的字段——横跨所有分组
  const needsRestart = RESTART_REQUIRED.some((key) => (draft[key] ?? '') !== (settings[key] ?? ''))
  const activeKeys = SECTIONS.find((s) => s.id === activeSection)?.keys ?? []

  // 自动保存：toggles 立即保存，text inputs 防抖后保存
  const persistField = (key: keyof DesktopSettings, value: string, immediate: boolean) => {
    const updated = { ...draft, [key]: value }
    setDraft(updated)

    if (immediate) {
      void onSave(updated).catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    } else {
      // 防抖：500ms 后写入
      if (debounceTimers.current[key]) {
        clearTimeout(debounceTimers.current[key])
      }
      debounceTimers.current[key] = setTimeout(() => {
        void onSave(updated).catch((err) => {
          setError(err instanceof Error ? err.message : String(err))
        })
      }, 500)
    }
  }

  // 清理所有定时器
  useEffect(() => {
    return () => {
      Object.values(debounceTimers.current).forEach(clearTimeout)
    }
  }, [])

  const handleRestart = async () => {
    setError(null)
    try {
      await onRestart()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // 导入 provider 配置：点击时才读密钥，填入表单，触发自动保存
  const handleImport = async (provider: 'claude' | 'codex') => {
    setImporting(provider)
    setError(null)
    try {
      const secret = await api.importProvider(provider)
      if (!secret) {
        setError(`无法读取 ${provider} 的配置`)
        return
      }

      // 填入表单（触发自动保存）
      const patch: DesktopSettings = {
        ...draft,
        DEEPSEEK_API_KEY: secret.apiKey,
      }
      if (secret.baseUrl) patch.DEEPSEEK_BASE_URL = secret.baseUrl
      if (secret.model) patch.DEEPSEEK_MODEL = secret.model

      setDraft(patch)
      // 立即保存（不防抖）
      await onSave(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(null)
    }
  }

  return (
    // settings 保留作测试锚点。
    // 以前这里是 fixed inset-0 的浮层（盖在主窗口上）；现在面板是独立
    // BrowserWindow 的内容，所以改成撑满自己那个窗口：h-full + flex-1
    // 贴着 #root 的 flex h-screen。fixed 在这里已经没有意义 ——
    // 没有别的东西要被它盖住了。
    <div className="settings flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {/* pl-20（80px）是给 macOS 红绿灯让的位：hiddenInset 保留那三个圆点，
          它们连按钮带边距占左上角约 78px。整条 header 是拖拽区（设置窗口同样
          没有原生标题栏），右边的关闭按钮单独标 no-drag，否则点不动。 */}
      <header className="flex h-11 items-center justify-between border-b border-line py-2 pr-4 pl-20 [-webkit-app-region:drag]">
        <h2 className="m-0 text-[13px] font-semibold">设置</h2>
        <button
          aria-label="关闭"
          onClick={onClose}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-chip border-none bg-transparent text-ink-2 hover:bg-hover [-webkit-app-region:no-drag]"
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：分组导航。以前是 w-56（224px）去对齐主窗口的侧边栏，但面板
            现在住在自己那个 ~700px 宽的窗口里，224px 的导航会把字段区挤窄；
            四个分组名都很短，w-40 够用。 */}
        <nav className="settings__nav flex w-40 flex-none flex-col border-r border-line p-2">
          <div className="flex flex-col gap-px">
            {SECTIONS.map((section) => {
              const isActive = section.id === activeSection
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`settings__nav-item flex h-7 items-center rounded-control px-2.5 text-left text-[12.5px] transition-colors duration-150 ${
                    isActive ? 'bg-surface font-medium text-ink' : 'text-ink-2 hover:bg-hover'
                  }`}
                  onClick={() => setActiveSection(section.id)}
                >
                  {section.label}
                </button>
              )
            })}
          </div>
        </nav>

        {/* 右：当前分组的字段 + 横跨所有分组的错误/重启提示 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4">
            {activeSection === 'provider' && (
              <>
                {/* 探测到的本机配置 */}
                {detections.length > 0 && (
                  <div className="flex flex-col gap-2 pb-3 border-b border-line">
                    <h3 className="m-0 text-[12px] font-semibold text-ink-2">检测到的配置</h3>
                    {detections.map((d) => {
                      const providerLabel = d.provider === 'claude' ? 'Claude Code' : d.provider === 'codex' ? 'Codex' : 'Gemini'
                      const canImport = d.available && (d.provider === 'claude' || d.provider === 'codex')
                      const isImporting = importing === d.provider

                      return (
                        <div key={d.provider} className="flex items-start gap-2 rounded-card bg-surface px-3 py-2 shadow-hairline">
                          <div className="flex-1">
                            <div className="text-[12.5px] font-medium text-ink">{providerLabel}</div>
                            {d.model && <div className="text-[11.5px] text-ink-3">模型：{d.model}</div>}
                            {d.baseUrl && <div className="text-[11.5px] text-ink-3">端点：{d.baseUrl}</div>}
                            {!d.available && d.reason && (
                              <div className="text-[11.5px] text-orange">{d.reason}</div>
                            )}
                          </div>
                          {canImport && (
                            <button
                              type="button"
                              disabled={isImporting}
                              onClick={() => void handleImport(d.provider as 'claude' | 'codex')}
                              className="flex h-6 cursor-pointer items-center rounded-chip border-none bg-accent px-2.5 text-[11.5px] font-medium text-page transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isImporting ? '导入中...' : '导入'}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* BYOK：手动填写字段 */}
                <h3 className="m-0 text-[12px] font-semibold text-ink-2">手动配置（BYOK）</h3>
              </>
            )}

            {activeKeys.map((key) => {
              const isRestartField = RESTART_REQUIRED.includes(key as typeof RESTART_REQUIRED[number])
              const fieldId = `setting-${key}`
              const isBooleanField = key === 'STREAM' || key === 'LLM_CACHE'

              return (
                <label key={key} className="field flex flex-col gap-1">
                  <span className="font-mono text-[11.5px] text-ink-2">{key}</span>
                  <input
                    id={fieldId}
                    aria-label={key}
                    aria-describedby={needsRestart && isRestartField ? 'restart-warning' : undefined}
                    type={key === 'DEEPSEEK_API_KEY' ? 'password' : 'text'}
                    value={draft[key] ?? ''}
                    onChange={(e) => persistField(key, e.target.value, isBooleanField)}
                    className="h-7 rounded-control bg-field px-2.5 font-[inherit] text-[13px] text-ink shadow-inset-field placeholder:text-ink-3 focus:outline-2 focus:outline-offset-[-1px] focus:outline-accent"
                  />
                  {HINTS[key] && <span className="text-[11.5px] text-ink-3">{HINTS[key]}</span>}
                </label>
              )
            })}
          </div>

          {(error || needsRestart) && (
            <div className="flex flex-col gap-2.5 border-t border-line px-4 py-3">
              {/* 显示验证错误 */}
              {error && (
                <div
                  className="settings__error m-0 rounded-card bg-red-tint px-2.5 py-1.5 text-[12.5px] text-red shadow-hairline"
                  aria-live="assertive"
                  role="alert"
                >
                  {error}
                </div>
              )}

              {/* 改笔记目录或 embedding 模型时显示警告 + 重启按钮 */}
              {needsRestart && (
                <div
                  className="settings__warn m-0 rounded-card bg-orange-tint px-2.5 py-1.5 text-[12.5px] text-orange shadow-hairline"
                  aria-live="polite"
                  id="restart-warning"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span>需要重启应用才能生效。</span>
                    <button
                      onClick={handleRestart}
                      className="flex h-7 flex-none cursor-pointer items-center rounded-control border-none bg-orange px-3 text-[12px] font-medium text-page shadow-btn transition-[background-color,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
                    >
                      立即重启
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 这里以前有个只放一句「API Key 以明文存储」的 footer。改完即生效之后
          它不再承载任何操作，只是白占一条高度，撤掉；那句披露挪进了
          DEEPSEEK_API_KEY 的 hint（见文件顶部 HINTS）。 */}
    </div>
  )
}
