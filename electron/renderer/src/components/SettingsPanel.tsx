import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { type DesktopSettings } from '../../../main/config-env'
import {
  ALL,
  CUSTOM_ID,
  CUSTOM_KEYS,
  CUSTOM_NAME,
  find as findVendor,
  isConfigured,
  nameOf,
} from '../../../main/vendors'
import {
  ADVANCED_MODEL_KEYS,
  GROUPS,
  REQUIRED,
  RESTART_REQUIRED,
  SECTIONS,
  hint,
  label,
  type SectionId,
} from '../settings-fields'
import type { ProviderDetection, ProvidersView } from '../../../shared/channels'
import { api } from '../api'

export function SettingsPanel({
  settings,
  activeSection,
  providers,
  onSave,
  onRestart,
}: {
  settings: DesktopSettings
  /** 当前在哪一页。**由 App 传进来**，不是这里的本地状态 ——
   *  左栏的 SettingsNav 也要读它来画选中态，见 App.tsx 里那段说明。 */
  activeSection: SectionId
  /** Agent 模式那页要列的引擎。不传就只显示说明文字 */
  providers?: ProvidersView
  onSave: (patch: DesktopSettings) => Promise<void>
  onRestart: () => Promise<void>
}) {
  const [draft, setDraft] = useState<DesktopSettings>(settings)
  const [error, setError] = useState<string | null>(null)
  const [detections, setDetections] = useState<ProviderDetection[]>([])
  /**
   * 凭据表单当前填哪一家。**组件内 state，不落盘** —— 见凭据页那段说明：
   * 它是表单作用域，不是「谁答我的问题」（那个在 composer）。
   *
   * 初值挑一个已经配好的，没有就用第一家 —— 打开设置页时停在「我配过的
   * 那家」比停在固定的第一家更可能是用户想看的。
   */
  const [formVendor, setFormVendor] = useState<string>(() => {
    const get = (key: string) => settings[key]
    const configured = [...ALL.map((v) => v.id), CUSTOM_ID].find((id) => isConfigured(id, get))
    return configured ?? ALL[0].id
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
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

  // 自动保存：toggles 立即保存，text inputs 防抖后保存
  const persistField = (key: string, value: string, immediate: boolean) => {
    const updated = { ...draft, [key]: value }
    setDraft(updated)

    if (immediate) {
      void onSave(updated).catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    } else {
      if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key])
      debounceTimers.current[key] = setTimeout(() => {
        void onSave(updated).catch((err) => {
          setError(err instanceof Error ? err.message : String(err))
        })
      }, 500)
    }
  }

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

  // 导入 provider 配置：点击时才读密钥，填入表单，触发自动保存。
  //
  // 导入的目标键跟着当前选中的厂商走 —— 原来写死 DEEPSEEK_API_KEY，
  // 多厂商之后那样会把 Claude 的 key 塞进 DeepSeek 那一栏。
  const handleImport = async (provider: 'claude' | 'codex') => {
    setImporting(provider)
    setError(null)
    try {
      const secret = await api.importProvider(provider)
      if (!secret) {
        setError(`无法读取 ${provider} 的配置`)
        return
      }
      // claude → anthropic，codex → openai。探测出来的凭据属于那一家，
      // 填到别家的栏里会得到一个 401。
      const vendorId = provider === 'claude' ? 'anthropic' : 'openai'
      const keyEnv = findVendor(vendorId)?.keyEnv
      const patch: DesktopSettings = { ...draft }
      if (keyEnv) patch[keyEnv] = secret.apiKey
      // 顺便把它选成当前厂商 —— 用户点「导入」的意图就是要用它
      patch.ACTIVE_VENDOR = vendorId
      // 探测到的模型名**只在它属于这家厂商时**才采用。
      //
      // 这里原来是无条件 `patch.ACTIVE_MODEL = secret.model`，而 secret.model
      // 来自被导入的那份 CLI 配置（~/.claude/settings.json 的 model、
      // ~/.codex/config.toml 的 model =）—— 那个字段可以是任何字符串，
      // 包括别家的模型名。写进去就得到 {厂商:anthropic, 模型:deepseek-reasoner}
      // 这种脏组合，发请求时服务端回「Invalid Anthropic API Key」，
      // 把人往错的方向引（key 是好的，错的是模型名）。
      //
      // 认不出就**不写**，让它退回该厂商的默认模型（resolveActiveProvider 里
      // 的 defaultModel 兜底）—— 导入的主要目的是那把 key，模型用户随后
      // 在 composer 左下角自己选。
      const vendorModels = findVendor(vendorId)?.models ?? []
      if (secret.model && vendorModels.some((m) => m.id === secret.model)) {
        patch.ACTIVE_MODEL = secret.model
      } else {
        // 之前可能残留了一个别家的模型名，清掉 —— 不清的话这次导入
        // 反而把脏组合保留下来了
        patch.ACTIVE_MODEL = ''
      }
      setDraft(patch)
      await onSave(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(null)
    }
  }

  // 这一页要渲染哪些组。全部走 GROUPS 那张静态表 —— 凭据页以前是动态的
  // （跟着「当前选中哪家」只显示那一家的 key 栏），现在九家一起摊开，
  // 因为「选哪家」已经不是设置页的职责了。
  const groups: [string, string[]][] = GROUPS[activeSection] ?? []

  /**
   * 当前选中那家厂商要填哪些栏。
   *
   * 内置九家只有一栏（key）—— 它们的 baseUrl 是常量，模型清单在 vendors.ts 里。
   * 自定义端点要四栏：地址、key、模型清单、搜索工具 —— 我们对它一无所知，
   * 全靠用户告诉我们。
   */
  const vendorFields: string[] =
    formVendor === CUSTOM_ID ? [...CUSTOM_KEYS] : [findVendor(formVendor)?.keyEnv ?? ''].filter(Boolean)

  /**
   * 一行字段。两处共用：厂商凭据卡 / 高级参数卡，以及下面按 GROUPS 渲染的
   * 那些分区。抽出来是因为这两处的行内容完全一样，复制一份迟早分叉
   * （比如密码框的判断只改了一处）。
   *
   * `divider` 控制上边框 —— 卡片里第一行不要，后续行要。
   */
  const renderField = (key: string, divider: boolean) => {
    const isRestartField = (RESTART_REQUIRED as readonly string[]).includes(key)
    const isBooleanField = key === 'STREAM' || key === 'LLM_CACHE'
    const isSecret = key.endsWith('_API_KEY')
    const text = label(key)
    const h = hint(key)
    return (
      <div
        key={key}
        // items-start 而不是 center：左列可能有三行（标题 + 键名 + 说明），
        // 居中会让输入框飘到中间、跟标题对不上
        className={`flex items-start gap-4 py-3 ${divider ? 'border-t border-line' : ''}`}
      >
        <label htmlFor={`setting-${key}`} className="field flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex items-center gap-1">
            <span className="text-[12.5px] font-medium text-ink">{text || key}</span>
            {REQUIRED.includes(key) && <span className="text-[12.5px] text-red">*</span>}
          </span>
          {/* 键名给「想手改 settings.json 的人」看，不该跟标题抢注意力。
              label 兜底成空串时标题已经是键名了，这里就不重复一遍 */}
          {text && <span className="font-mono text-[11px] text-ink-3">{key}</span>}
          {h && <span className="text-[11.5px] text-ink-3">{h}</span>}
        </label>
        {/* 输入框定宽而不是 flex-1：所有输入框右边缘要对齐，
            flex-1 会让它随左列文字长短伸缩、宽度参差不齐 */}
        <input
          id={`setting-${key}`}
          aria-label={key}
          aria-describedby={needsRestart && isRestartField ? 'restart-warning' : undefined}
          type={isSecret ? 'password' : 'text'}
          value={draft[key] ?? ''}
          onChange={(e) => persistField(key, e.target.value, isBooleanField)}
          className="h-7 w-[300px] flex-none rounded-control bg-field px-2.5 font-[inherit] text-[13px] text-ink shadow-inset-field placeholder:text-ink-3 focus:outline-2 focus:outline-offset-[-1px] focus:outline-accent"
        />
      </div>
    )
  }

  // 「已配几家」是唯一能表达「至少配一家才能对话」这条要求的地方 ——
  // 它不是任何单个字段的属性，所以不能用必填星号表达（那会在九家里每家都
  // 标一个红星，而且是错的，填一家就够）。
  const get = (key: string) => draft[key]
  const configuredNames = [...ALL.map((v) => v.id), CUSTOM_ID]
    .filter((id) => isConfigured(id, get))
    .map((id) => nameOf(id) ?? '')
    .filter(Boolean)

  // 这一页的标题。以前是顶栏里一个固定的「设置」，那条顶栏现在没了 ——
  // 「我在设置里」由左栏的导航说，而顶栏再重复一次「设置」两个字，占掉
  // 44px 却没说出用户不知道的事。换成当前分区名：那是这一屏真正的标题。
  const sectionLabel = SECTIONS.find((s) => s.id === activeSection)?.label ?? ''

  return (
    // 整个内容区就是这一栏（左边是 SettingsNav）。没有内层导航、没有顶栏。
    <div className="settings flex h-full min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 内容限宽 760 并居中。比对话区的 720 宽一点 —— 表单是两列
              （标签 + 输入框），挤在 720 里输入框会太窄。760 取自 waku 的
              SETTINGS_CONTENT_MAX_WIDTH，gpui 侧同一个数。
              不限宽的话在宽窗口上标签贴左、输入框贴右，中间一片空白。 */}
          <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-[18px] overflow-y-auto px-6 py-5">
            {/* 页标题。红绿灯在左栏那边，这里不用留位，但顶上仍要一条可拖拽区
                ——否则窗口顶部这一整条只能靠左栏那 224px 拖动。 */}
            <div className="flex flex-none items-center [-webkit-app-region:drag]">
              <h2 className="m-0 text-[15px] font-semibold text-ink">{sectionLabel}</h2>
            </div>
            {/* --- 凭据页：已配几家 + 探测到的本机配置 ---
                这里没有厂商选择器。「用哪家、哪个模型」由 composer 左下角的
                选择器决定（ModelPicker.tsx）—— 那是提问的时刻，也是这个信息
                唯一该出现的地方。设置页只管一件事：把手上有的 key 填进去。 */}
            {/* --- 凭据页 ---
                ## 这个 select 选的不是「谁答我的问题」
                
                它只决定**这张表单现在填哪家的 key**（表单作用域），不写
                ACTIVE_VENDOR。「下一条消息谁来答」由 composer 左下角那个
                选择器决定 —— 那是提问的时刻，也是那个信息唯一该出现的地方。
                
                两者混用会让同一个事实有两个来源，而它们迟早不一致（上一版
                就是那样，撞出过 {厂商:anthropic, 模型:deepseek-reasoner}
                这种脏组合）。所以这里刻意用**组件内 state**，不落盘。
                
                为什么不像上一版那样九家一起摊开：九个 key 输入框里八个永远
                是空的，用户要在一屏长表单里找自己那一家。选一家、填一栏，
                比滚动九栏快。 */}
            {activeSection === 'provider' && (
              <div className="flex flex-col gap-3.5">
                <div
                  className={`text-[11.5px] ${configuredNames.length === 0 ? 'text-orange' : 'text-ink-3'}`}
                >
                  {configuredNames.length === 0
                    ? '还没配任何 key。选一家填上，或者用自定义端点指向本地 / 第三方服务。'
                    : `已配 ${configuredNames.length} 项：${configuredNames.join('、')}`}
                </div>

                {/* 厂商选择 + 那一家的凭据栏 */}
                <div className="flex flex-col rounded-[12px] border border-line-strong bg-surface px-4 py-1">
                  <div className="flex h-[34px] flex-none items-center text-[11px] font-semibold text-ink-3">
                    厂商凭据
                  </div>

                  <div className="flex items-start gap-4 py-3">
                    <label htmlFor="vendor-select" className="field flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="text-[12.5px] font-medium text-ink">厂商</span>
                      <span className="text-[11.5px] text-ink-3">
                        选一家，下面填它的凭据。这里只决定填哪家的 key —— 用哪家答话在对话框左下角选。
                      </span>
                    </label>
                    <select
                      id="vendor-select"
                      aria-label="厂商"
                      value={formVendor}
                      onChange={(e) => setFormVendor(e.target.value)}
                      className="h-7 w-[300px] flex-none rounded-control bg-field px-2 font-[inherit] text-[13px] text-ink shadow-inset-field focus:outline-2 focus:outline-offset-[-1px] focus:outline-accent"
                    >
                      {ALL.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                          {isConfigured(v.id, get) ? ' ✓' : ''}
                        </option>
                      ))}
                      {/* 自定义端点放最后：它不是「一家厂商」，而是「其它任何
                          OpenAI 兼容的地址」，语义上是兜底项 */}
                      <option value={CUSTOM_ID}>
                        {CUSTOM_NAME}
                        {isConfigured(CUSTOM_ID, get) ? ' ✓' : ''}
                      </option>
                    </select>
                  </div>

                  {/* 选中那一家的字段。自定义端点要多填几栏（地址、模型清单、
                      搜索工具）—— 内置九家的地址是常量，没得填。 */}
                  {vendorFields.map((key) => renderField(key, true))}
                </div>

                {/* 高级参数：默认收起。
                    绝大多数人一辈子不需要动温度，而它摆在 key 旁边会让「配置
                    模型」看起来比实际复杂 —— 用户以为这些都得填。 */}
                <div className="flex flex-col rounded-[12px] border border-line-strong bg-surface px-4 py-1">
                  <div className="flex h-[42px] flex-none items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12.5px] font-medium text-ink">高级参数</span>
                      <span className="text-[11px] text-ink-3">
                        采样行为。不确定就别动 —— 默认值适合调工具的场景。
                      </span>
                    </div>
                    {/* 原生 checkbox + role=switch：可访问性上它就是个开关，
                        而自绘一个 div 要自己补键盘操作和焦点环 */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={showAdvanced}
                      aria-label="高级参数"
                      onClick={() => setShowAdvanced((v) => !v)}
                      className={`relative flex h-[18px] w-[32px] flex-none cursor-pointer items-center rounded-full border-none px-0.5 transition-colors duration-150 ${
                        showAdvanced ? 'bg-accent' : 'bg-field'
                      }`}
                    >
                      <span
                        className={`block size-[14px] rounded-full bg-page transition-transform duration-150 ${
                          showAdvanced ? 'translate-x-[14px]' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                  {showAdvanced && (
                    <div className="flex flex-col border-t border-line">
                      {ADVANCED_MODEL_KEYS.map((key) => renderField(key, false))}
                    </div>
                  )}
                </div>

                {/* 探测到的本机配置 */}
                {detections.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="m-0 text-[12px] font-semibold text-ink-2">检测到的配置</h3>
                    {detections.map((d) => {
                      const providerLabel =
                        d.provider === 'claude' ? 'Claude Code' : d.provider === 'codex' ? 'Codex' : 'Gemini'
                      const canImport = d.available && (d.provider === 'claude' || d.provider === 'codex')
                      const isImporting = importing === d.provider
                      return (
                        <div
                          key={d.provider}
                          className="flex items-start gap-2 rounded-card bg-surface px-3 py-2 shadow-hairline"
                        >
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
              </div>
            )}

            {activeSection === 'agents' && (
              <div className="flex flex-col gap-3.5">
                <div className="text-[12.5px] text-ink-2">
                  「这一轮由谁来跑」。内置 agent 是本仓库实现的 ReAct 循环；外部 CLI
                  走 ACP 标准协议，模型逻辑在它自己的进程里。每个会话各记各的 ——
                  在 composer 左下角切换。
                </div>

                {providers?.options.map((o) => {
                  const isCurrent = o.id === providers.current
                  return (
                    <div
                      key={o.id}
                      className="flex items-center gap-2 rounded-card border border-line bg-surface p-3"
                    >
                      <Icon name={o.external ? 'terminal' : 'bot'} size={14} />
                      <div className="flex flex-1 flex-col gap-0.5">
                        <div className="text-[12.5px] font-medium text-ink">{o.name}</div>
                        <div className="text-[11.5px] text-ink-3">
                          {o.external
                            ? '外部 CLI，走 ACP 协议。工具和权限由它自己管。'
                            : '本仓库实现的 ReAct 循环。工具走 MCP，历史存本地。'}
                        </div>
                      </div>
                      {isCurrent && (
                        <span className="rounded-full bg-accent-tint px-2 py-px text-[11px] text-accent-ink">
                          当前会话
                        </span>
                      )}
                    </div>
                  )
                })}

                {/* 这一页**不做成表单**：外部 CLI 的配置（命令、参数、环境变量）
                    是从各家 README 粘过来的，表单会强迫用户把一行命令拆成
                    几个输入框。给出文件路径，让他直接改那份 JSON。 */}
                <div className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-3">
                  <div className="text-[12.5px] font-medium text-ink">加一个外部 CLI</div>
                  <div className="text-[11.5px] text-ink-3">
                    改这个文件，然后重启应用。预置了 Claude Code、Codex、Gemini CLI、Pi、
                    DeepSeek Harness 五家，默认都是关着的（它们要 npx 拉包、还要各自登录）——
                    把想用的那家 <code className="font-mono">disabled</code> 去掉即可。
                  </div>
                  {providers?.configPath && (
                    <div className="mt-1 font-mono text-[11px] break-all text-ink-3">
                      {providers.configPath}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* --- 表单字段：每组一张卡片 --- */}
            {groups.map(([groupName, keys]) => (
              <div
                key={groupName}
                className="flex flex-col rounded-[12px] border border-line-strong bg-surface px-4 py-1"
              >
                {/* 卡片头：小号、灰、加粗 */}
                <div className="flex h-[34px] flex-none items-center text-[11px] font-semibold text-ink-3">
                  {groupName}
                </div>
                <div className="flex flex-col">
                  {/* field 类名等细节都在 renderField 里 —— 这一处和上面
                      厂商凭据卡共用同一个实现，复制一份迟早分叉 */}
                  {keys.map((key, i) => renderField(key, i > 0))}
                </div>
              </div>
            ))}
          </div>

          {(error || needsRestart) && (
            <div className="flex flex-col gap-2.5 border-t border-line px-4 py-3">
              {error && (
                <div
                  className="settings__error m-0 rounded-card bg-red-tint px-2.5 py-1.5 text-[12.5px] text-red shadow-hairline"
                  aria-live="assertive"
                  role="alert"
                >
                  {error}
                </div>
              )}
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
    </div>
  )
}
