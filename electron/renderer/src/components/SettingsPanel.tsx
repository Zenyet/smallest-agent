import { SettingsButton, SettingsSwitch, SettingsDisclosure, SettingsSelect } from './settings/SettingsControls'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { DesktopSettings } from '../../../main/config-env'
import type { ProvidersView, RuntimeStatusEvent } from '../../../shared/channels'
import { RESTART_KEYS, type SettingsStatus } from '../../../shared/settings'
import { api } from '../api'
import { AUTO_FIELDS, SECTIONS, label, type SectionId } from '../settings-fields'
import { Icon } from './Icon'
import { ConnectionSettings } from './settings/ConnectionSettings'
import { MemorySettings } from './settings/MemorySettings'
import { SaveActions, SettingField, TechnicalFields } from './settings/SettingField'
import { useSettingsDraft, type SaveSettings } from './settings/useSettingsDraft'

export interface SettingsPanelHandle { requestClose: () => Promise<void> }
export function SettingsPanel({ settings, activeSection, providers, onToggleProvider, onSave, onRestart, runtimeStatus, projectPath, onClose, ref, initialMemoryTab = 'facts' }: {
  settings: DesktopSettings; activeSection: SectionId; providers?: ProvidersView
  onToggleProvider?: (id: string, enabled: boolean) => unknown
  onSave: SaveSettings; onRestart: () => Promise<void>; runtimeStatus?: RuntimeStatusEvent
  projectPath?: string; onClose?: () => void; ref?: Ref<SettingsPanelHandle>
  initialMemoryTab?: 'facts' | 'notes'
}) {
  const form = useSettingsDraft(settings, onSave)
  const [status, setStatus] = useState<SettingsStatus>()
  const [statusError, setStatusError] = useState('')
  const [actionError, setActionError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const [closing, setClosing] = useState(false)
  const [memoryTab, setMemoryTab] = useState<'facts' | 'notes'>(initialMemoryTab)
  const [searchService, setSearchService] = useState(settings.TAVILY_API_KEY && !settings.BRAVE_API_KEY ? 'TAVILY_API_KEY' : 'BRAVE_API_KEY')
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  const visited = useRef(new Set<SectionId>())
  visited.current.add(activeSection)
  const statusVersion = useRef(0)
  const refreshStatus = async () => {
    const version = ++statusVersion.current
    try { const next = await api.getSettingsStatus(); if (version === statusVersion.current) { setStatus(next); setStatusError('') } }
    catch { if (version === statusVersion.current) setStatusError('无法读取设置生效状态。') }
  }
  useEffect(() => { void refreshStatus(); return () => { statusVersion.current++ } }, [settings])
  const requestClose = async () => {
    setClosing(true); setActionError('')
    try {
      await form.flush()
      if (form.dirtyKeys().some(key => !AUTO_FIELDS.has(key))) setConfirmClose(true)
      else onClose?.()
    } catch { setActionError('还有修改未保存，请修正标记的字段后再返回。') }
    finally { setClosing(false) }
  }
  useImperativeHandle(ref, () => ({ requestClose }))
  const field = (name: string) => <SettingField key={name} name={name} form={form} inherited={status?.inheritedKeys.includes(name)} effectiveValue={status?.effective?.[name]} />
  const section = SECTIONS.find(s => s.id === activeSection)!
  const runAction = async (run: () => Promise<unknown>) => { setActionError(''); try { await run() } catch (err) { setActionError(err instanceof Error ? err.message : '操作失败，请重试。') } }
  return <div className="settings st-shell">
    <div className="st-scroll"><div className="st-content">
      <header className="st-page-header"><h2>{section.label}</h2><p>{section.description}</p></header>
      {visited.current.has('provider') && <div hidden={activeSection !== 'provider'}><ConnectionSettings form={form} status={status} available={runtimeStatus?.phase !== 'failed'} /></div>}
      {visited.current.has('agents') && <div hidden={activeSection !== 'agents'}>
        <div className="st-section-head"><h3>执行引擎</h3><span className="st-hint">启用后可在对话中选择</span></div>
        <div className="st-row"><span className="st-mark"><Icon name="bot" size={17} /></span><div className="st-grow"><strong>内置 Agent</strong><p className="st-hint">使用「模型连接」中的配置</p></div><span className="st-badge">{providers?.current === 'builtin' ? '当前会话' : '始终启用'}</span></div>
        {providers?.allProviders?.map(p => <div className="st-row" key={p.id}><div className="st-grow"><label htmlFor={`provider-${p.id}`}>{p.name}</label><p className="st-hint">{p.enabled ? '已启用；启动时检查本机环境' : '未启用'}{p.id === providers.current ? ' · 当前会话' : ''}</p></div>
          {onToggleProvider && <SettingsSwitch id={`provider-${p.id}`} aria-label={`${p.enabled ? '停用' : '启用'} ${p.name}`} checked={p.enabled} disabled={providerBusy === p.id} onCheckedChange={enabled => {
            setProviderBusy(p.id)
            void runAction(async () => { await onToggleProvider(p.id, enabled) }).finally(() => setProviderBusy(null))
          }} />}</div>)}
        <SettingsDisclosure className="st-details" title="添加引擎与权限说明"><p>外部 CLI 使用各自的登录、工具和权限设置。Codex / Claude Code 已通过订阅登录时，无需在「模型连接」中填写 API Key。首次使用可能需要准备适配器；启用不代表已经安装或登录。</p><p>新增引擎可编辑配置文件，重启应用后生效。</p><p className="st-code">{providers?.configPath ?? '配置路径暂不可用'}</p></SettingsDisclosure>
        <div className="st-section-head"><h3>内置 Agent 能力</h3></div>{field('SUBAGENT')}
        <div className="st-section-head"><h3>网络搜索</h3></div><p className="st-hint">选择一家配置即可；未配置时使用基础搜索。若两家都有凭据，按现有搜索策略选择。</p>
        <div className="st-field st-spaced"><span>搜索服务</span><SettingsSelect aria-label="搜索服务" value={searchService} onValueChange={setSearchService} options={[{ value: "BRAVE_API_KEY", label: "Brave Search" }, { value: "TAVILY_API_KEY", label: "Tavily" }]} /></div>
        {field(searchService)}<SaveActions names={[searchService]} form={form} /><TechnicalFields names={['SUBAGENT', 'BRAVE_API_KEY', 'TAVILY_API_KEY']} />
      </div>}
      {visited.current.has('memory') && <div hidden={activeSection !== 'memory'}>
        <div className="st-tabs" role="tablist" aria-label="记忆与资料">{[['facts', '长期记忆'], ['notes', '笔记资料']].map(([id, text]) => <SettingsButton type="button" className="st-tab" role="tab" tabIndex={memoryTab === id ? 0 : -1} key={id} id={`tab-${id}`} aria-selected={memoryTab === id} aria-controls={`panel-${id}`} onClick={() => setMemoryTab(id as 'facts' | 'notes')} onKeyDown={e => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'facts' : e.key === 'End' ? 'notes' : id === 'facts' ? 'notes' : 'facts'; setMemoryTab(next); document.getElementById(`tab-${next}`)?.focus() }
        }}><Icon name={id === 'facts' ? 'think' : 'doc'} size={13} />{text}</SettingsButton>)}</div>
        <div role="tabpanel" id="panel-facts" aria-labelledby="tab-facts" hidden={memoryTab !== 'facts'}>{field('AUTO_EXTRACT_FACTS')}<MemorySettings projectPath={projectPath} /></div>
        <div role="tabpanel" id="panel-notes" aria-labelledby="tab-notes" hidden={memoryTab !== 'notes'}>
          <div className="st-section-head"><h3>笔记知识库</h3><span className="st-badge">{runtimeStatus?.capabilities?.find(c => c.id === 'notes')?.detail ?? '状态暂不可用'}</span></div>
          <div className="st-surface st-pad st-stack">{field('NOTES_DIR')}<SettingsButton type="button" className="st-button st-fit" onClick={() => void runAction(async () => { const directory = await api.selectNotesDirectory(); if (directory) form.set('NOTES_DIR', directory) })}><Icon name="folder" size={14} />选择目录</SettingsButton>
            <SettingsDisclosure className="st-details" title="索引高级配置">{field('EMBEDDING_MODEL')}{field('HF_ENDPOINT')}</SettingsDisclosure>
            <SaveActions names={[...RESTART_KEYS]} form={form} title="保存资料配置" />
            <p className="st-hint">当前生效目录：{status?.applied.NOTES_DIR ?? '读取中…'}</p><p className="st-hint">保存目录或索引配置后，需要重启应用。索引在首次检索时初始化。</p>
          </div><TechnicalFields names={RESTART_KEYS} />
        </div>
      </div>}
      {visited.current.has('general') && <div hidden={activeSection !== 'general'}>{field('STREAM')}{field('LLM_CACHE')}<p className="st-notice">当前运行中的任务继续使用开始时的配置。</p><TechnicalFields names={['STREAM', 'LLM_CACHE']} /></div>}
      {visited.current.has('advanced') && <div className="st-advanced" hidden={activeSection !== 'advanced'}>
        <section className="st-settings-group" aria-label="执行配置">
        <div className="st-section-head"><h3>执行限制</h3><SettingsButton type="button" className="st-button st-quiet" disabled={form.pending > 0} onClick={() => { for (const key of ['MAX_TURNS', 'MAX_RETRIES']) form.set(key, ''); void form.commit(['MAX_TURNS', 'MAX_RETRIES']).catch(() => {}) }}>恢复此组默认值</SettingsButton></div>
        {field('MAX_TURNS')}{field('MAX_RETRIES')}
        <SettingsDisclosure className="st-details" title="上下文与采样">{field('MAX_CONTEXT_TOKENS')}{field('KEEP_RECENT')}{field('TEMPERATURE')}</SettingsDisclosure>
        </section>
        <section className="st-settings-group" aria-label="能力状态">
        <div className="st-section-head"><h3>能力状态</h3></div>
        <div className="st-row"><div className="st-grow"><strong>基础运行环境</strong><p className="st-hint">{runtimeStatus?.detail ?? '状态暂不可用'}</p></div><span className="st-badge">{runtimeStatus?.phase === 'ready' ? '已就绪' : runtimeStatus?.phase === 'failed' ? '未就绪' : '准备中'}</span></div>
        {runtimeStatus?.capabilities?.map(c => <div className="st-row" key={c.id}><div className="st-grow"><strong>{c.label}</strong><p className="st-hint">{c.detail}</p></div><span className={`st-badge ${c.state === 'failed' ? 'st-danger' : ''}`}>{{ idle: '按需准备', loading: '准备中', ready: '已就绪', failed: '失败' }[c.state]}</span></div>)}
        </section>
        <TechnicalFields names={['MAX_TURNS', 'MAX_RETRIES', 'MAX_CONTEXT_TOKENS', 'KEEP_RECENT', 'TEMPERATURE']} />
      </div>}
    </div></div>
    <footer className="st-footer">
      <div className="st-save-state" role="status" aria-live="polite">{form.pending ? '正在保存…' : form.dirtyKeys().length ? `有 ${form.dirtyKeys().length} 项修改未保存` : form.feedback || '普通偏好自动保存 · 凭据需手动保存'}{form.pending === 0 && form.feedback === '已保存' && !status?.pendingKeys.length ? ' · 下次使用时生效' : ''}</div>
      {statusError && <div className="st-actions st-hint"><span>{statusError}</span><SettingsButton type="button" className="st-button st-quiet" onClick={() => void refreshStatus()}>重试</SettingsButton></div>}
      {!!status?.pendingKeys.length && <div className="settings__warn st-notice st-warn"><div className="st-grow">已保存，重启后生效<p className="st-hint">{status.pendingKeys.map(label).join('、')}</p></div><SettingsButton type="button" className="st-button" disabled={form.pending > 0 || form.dirtyKeys().length > 0} onClick={() => void runAction(onRestart)}>立即重启</SettingsButton></div>}
      {actionError && <p className="settings__error st-error" role="alert">{actionError}</p>}
      {confirmClose && <div className="st-exit" role="alertdialog" aria-label="保存修改后返回"><p>还有配置未保存。如何返回对话？</p><div className="st-actions"><SettingsButton type="button" className="st-button st-primary" disabled={closing || form.pending > 0} onClick={() => void runAction(async () => { setClosing(true); try { await form.commit(form.dirtyKeys()); onClose?.() } finally { setClosing(false) } })}>保存并返回</SettingsButton><SettingsButton type="button" className="st-button" disabled={closing || form.pending > 0} onClick={() => { form.discard(form.dirtyKeys()); onClose?.() }}>放弃修改</SettingsButton><SettingsButton type="button" className="st-button st-quiet" disabled={closing} onClick={() => setConfirmClose(false)}>继续编辑</SettingsButton></div></div>}
    </footer>
  </div>
}
