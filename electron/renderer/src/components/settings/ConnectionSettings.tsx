import { SettingsButton, SettingsDisclosure, SettingsSelect } from './SettingsControls'
import { useRef, useState } from 'react'
import { ALL, CUSTOM_ID, CUSTOM_KEYS, CUSTOM_NAME, apiKeySetting, isConfigured, nameOf } from '../../../../main/vendors'
import type { ConnectionCheck, SettingsStatus } from '../../../../shared/settings'
import type { ProviderDetection } from '../../../../shared/channels'
import { api } from '../../api'
import { Icon } from '../Icon'
import { SaveActions, SettingField } from './SettingField'
import type { SettingsDraft } from './useSettingsDraft'

export const connectionFields = (id: string) => id === CUSTOM_ID ? [...CUSTOM_KEYS] : [apiKeySetting(id)!]
export function ConnectionSettings({ form, status, available = true }: { form: SettingsDraft; status?: SettingsStatus; available?: boolean }) {
  const configured = [...ALL.map(v => v.id), CUSTOM_ID].filter(id => isConfigured(id, key => form.saved[key]))
  const [added, setAdded] = useState<string[]>(() => configured.length ? configured : [ALL[0].id])
  const [selected, setSelected] = useState(configured[0] ?? ALL[0].id)
  const [adding, setAdding] = useState(false)
  const [candidate, setCandidate] = useState(ALL[0].id)
  const [checks, setChecks] = useState<Record<string, ConnectionCheck & { signature: string }>>({})
  const [checking, setChecking] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [detections, setDetections] = useState<ProviderDetection[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [preview, setPreview] = useState<'claude' | 'codex' | null>(null)
  const checkVersion = useRef(0)
  const rows = [...new Set([...added, ...configured])]
  const signature = (id: string) => JSON.stringify(connectionFields(id).map(key => form.saved[key] ?? ''))
  async function verify(id: string) {
    const version = ++checkVersion.current, savedSignature = signature(id)
    setChecking(id); setError('')
    try {
      const result = await api.checkConnection(id)
      if (version === checkVersion.current) setChecks(old => ({ ...old, [id]: { ...result, signature: savedSignature } }))
    } catch { setError('暂时无法验证连接，请确认应用已启动完成后重试。') }
    finally { if (version === checkVersion.current) setChecking(null) }
  }
  async function detect() {
    setDetecting(true); setError('')
    try { setDetections(await api.detectProviders()) } catch { setError('无法读取本机配置，请重试。') }
    finally { setDetecting(false) }
  }
  async function importSecret() {
    if (!preview) return
    const source = preview, id = source === 'claude' ? 'anthropic' : 'openai', key = apiKeySetting(id)!
    setImporting(source); setError('')
    try {
      const secret = await api.importProvider(source)
      if (!secret) throw new Error()
      form.set(key, secret.apiKey)
      await form.commit([key])
      setAdded(old => [...new Set([...old, id])]); setSelected(id); setPreview(null)
    } catch { setError('导入失败；已有配置保持不变，可重新尝试。') }
    finally { setImporting(null) }
  }
  return <>
    <div className="st-section-head"><h3>模型服务</h3><SettingsButton type="button" className="st-button" onClick={() => { setCandidate([...ALL.map(v => v.id), CUSTOM_ID].find(id => !rows.includes(id)) ?? selected); setAdding(v => !v) }}><Icon name="plus" size={13} />添加服务</SettingsButton></div>
    {adding && <div className="st-surface st-pad st-stack">
      <div className="st-field"><span>服务类型</span><SettingsSelect aria-label="服务类型" value={candidate} onValueChange={setCandidate} options={[...ALL.map(v => ({ value: v.id, label: v.name })), { value: CUSTOM_ID, label: CUSTOM_NAME }]} /></div>
      <div className="st-actions"><SettingsButton type="button" className="st-button st-primary" onClick={() => { setAdded(old => [...new Set([...old, candidate])]); setSelected(candidate); setAdding(false) }}>添加</SettingsButton><SettingsButton type="button" className="st-button st-quiet" onClick={() => setAdding(false)}>取消</SettingsButton></div>
    </div>}
    <div className="st-stack">{rows.map(id => {
      const names = connectionFields(id), open = selected === id, dirty = names.some(form.dirty)
      const configured = isConfigured(id, key => form.saved[key])
      const inherited = names.some(key => status?.inheritedKeys.includes(key))
      const check = checks[id]?.signature === signature(id) ? checks[id] : undefined
      const statusText = dirty ? '未保存' : checking === id ? '验证中…' : check ? check.ok ? '文本请求可用' : '验证失败' : configured ? '已保存 · 未验证' : inherited ? '来自启动环境' : '未配置'
      return <section key={id} className="st-surface">
        <SettingsButton type="button" className="st-connection-head" aria-expanded={open} onClick={() => setSelected(open ? '' : id)}>
          <span className="st-mark"><Icon name={id === CUSTOM_ID ? 'terminal' : 'globe'} size={17} /></span>
          <span className="st-grow"><strong>{nameOf(id)}</strong><span className="st-hint">{id === CUSTOM_ID ? '本地或兼容服务' : 'API 服务'}</span></span>
          <span className={`st-badge ${dirty ? 'st-warn' : check && !dirty ? check.ok ? 'st-success' : 'st-danger' : configured ? 'st-warn' : ''}`}>{statusText}</span>
          <Icon name="chevron" size={13} className={open ? 'rotate-180' : ''} />
        </SettingsButton>
        {open && <div className="st-connection-body st-stack">
          {names.map(key => <SettingField key={key} name={key} form={form} inherited={status?.inheritedKeys.includes(key)} />)}
          <div className="st-actions"><SaveActions names={names} form={form} title={id === CUSTOM_ID ? '保存连接' : '保存凭据'} />
            <SettingsButton type="button" className={`st-button ${!dirty ? 'st-primary' : ''}`} disabled={!available || dirty || !configured || Boolean(checking) || form.pending > 0} onClick={() => void verify(id)}><Icon name="cache" size={13} />{checking === id ? '验证中…' : '验证连接'}</SettingsButton>
          </div>
          {check && !dirty && <div className={check.ok ? 'st-hint st-success-text' : 'st-error'} role="status">{check.message}<div className="st-hint">测试模型：{check.model} · {new Date(check.checkedAt).toLocaleTimeString()}</div></div>}
          <p className="st-hint">{available ? '验证会发送一次最小文本请求，可能产生少量模型用量。' : '保存配置并重启应用后，即可验证连接。'}</p>
          <SettingsDisclosure className="st-details" title="凭据来源与开发者字段"><p>凭据保存在本机。清空并保存会移除此处的值；若启动环境仍有配置，应用可能继续使用它。移除不等于停用服务。</p><p className="st-code">{names.join(' · ')}</p></SettingsDisclosure>
        </div>}
      </section>
    })}</div>
    <SettingsDisclosure className="st-details" title="从本机 CLI 导入已有凭据"><p>导入只更新目标服务的凭据，保留当前对话的模型选择。</p>
      <SettingsButton type="button" className="st-button" disabled={detecting} onClick={() => void detect()}>{detecting ? '正在检测…' : '检测已有配置'}</SettingsButton>
      {detections?.map(d => <div className="st-row" key={d.provider}><div className="st-grow"><strong>{d.provider === 'claude' ? 'Claude Code' : d.provider === 'codex' ? 'Codex' : 'Gemini CLI'}</strong><p className="st-hint">{d.available ? '检测到配置，可预览导入' : d.reason ?? '未找到可导入的配置'}</p></div>
        {d.available && (d.provider === 'claude' || d.provider === 'codex') && <SettingsButton type="button" className="st-button" onClick={() => setPreview(d.provider as 'claude' | 'codex')}>预览导入</SettingsButton>}</div>)}
      {preview && <div className="st-notice"><p>{preview === 'claude' ? 'Claude Code → Anthropic' : 'Codex → OpenAI'}：仅导入 API Key。将覆盖该服务当前保存的凭据。</p><div className="st-actions"><SettingsButton type="button" className="st-button st-primary" disabled={Boolean(importing) || form.pending > 0} onClick={() => void importSecret()}>{importing ? '正在导入…' : '确认导入'}</SettingsButton><SettingsButton type="button" className="st-button" disabled={Boolean(importing)} onClick={() => setPreview(null)}>取消</SettingsButton></div></div>}
    </SettingsDisclosure>
    {error && <p className="st-error" role="alert">{error}</p>}
  </>
}
