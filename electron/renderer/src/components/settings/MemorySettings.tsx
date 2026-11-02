import { SettingsButton, SettingsTextarea, SettingsDisclosure } from './SettingsControls'
import { useEffect, useRef, useState } from 'react'
import type { Fact } from '../../../../shared/channels'
import { api } from '../../api'
import { Icon } from '../Icon'

export function MemorySettings({ projectPath }: { projectPath?: string }) {
  const [facts, setFacts] = useState<Fact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [scope, setScope] = useState('all')
  const [editing, setEditing] = useState<Fact | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<Fact | null>(null)
  const requestVersion = useRef(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const editTrigger = useRef<HTMLButtonElement | null>(null)
  const finishEditing = () => { setEditing(null); setActionError(''); requestAnimationFrame(() => editTrigger.current?.focus()) }
  const read = async () => {
    const version = ++requestVersion.current
    setLoading(true); setError('')
    try { const next = await api.getFacts(); if (version === requestVersion.current) setFacts(next) }
    catch { if (version === requestVersion.current) setError('读取记忆失败，请重试。') }
    finally { if (version === requestVersion.current) setLoading(false) }
  }
  useEffect(() => {
    void read()
    const off = api.onFactsChanged(next => { requestVersion.current++; setFacts(next); setLoading(false); setError('') })
    return () => { requestVersion.current++; off() }
  }, [])
  useEffect(() => { if (editing) input.current?.focus() }, [editing])
  const action = async (run: () => Promise<Fact[]>, success?: () => void) => {
    setBusy(true); setActionError('')
    try { setFacts(await run()); success?.() }
    catch (err) { setActionError(err instanceof Error ? err.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }
  const filtered = facts.filter(f => scope === 'all' || (scope === 'global' ? f.scope === 'global' : f.scope === `project:${projectPath}`)).sort((a, b) => b.updatedAt - a.updatedAt)
  const scopeText = (factScope: string) => factScope === 'global' ? '全局 · 所有项目' : `项目 · ${factScope.slice(8)}`
  const saveEditing = () => {
    if (!editing || !value.trim() || busy || value.trim() === editing.value) return
    void action(() => api.updateFact(editing.key, editing.scope, value.trim()), finishEditing)
  }
  return <section className="memory-module" aria-label="长期记忆">
    <div className="memory-overview">
      <div className="memory-overview-title"><span className="memory-title-icon"><Icon name="think" size={16} /></span><div><h3>已记住的内容</h3><p className="st-hint">管理 Agent 从对话中整理出的偏好和项目约定</p></div></div>
      <div className="memory-count"><strong>{filtered.length}</strong><span>条记录</span></div>
    </div>
    <div className="memory-toolbar">
      <span className="memory-toolbar-label">查看范围</span>
      <div className="st-filters" aria-label="记忆范围">{[['all', '全部'], ['project', '当前项目'], ['global', '全局']].map(([id, text]) => <SettingsButton type="button" className="st-filter" key={id} aria-pressed={scope === id} disabled={Boolean(editing) || busy || (id === 'project' && !projectPath)} onClick={() => setScope(id)}>{text}</SettingsButton>)}</div>
    </div>
    {loading ? <div className="memory-state"><span className="memory-state-icon"><Icon name="think" size={16} /></span><p role="status">正在读取记忆…</p></div> : error ? <div className="st-notice memory-state"><p className="st-error" role="alert">{error}</p><SettingsButton type="button" className="st-button" onClick={() => void read()}>重新读取</SettingsButton></div> : filtered.length === 0 ? <div className="memory-state memory-empty"><span className="memory-state-icon"><Icon name="think" size={16} /></span><strong>{facts.length === 0 ? '还没有记住任何内容' : '这个范围内还没有记忆'}</strong><p>{facts.length === 0 ? '在对话中告诉 Agent“记住这件事”，它会在这里整理成可管理的内容。' : '切换查看范围，或在对话中继续补充项目约定。'}</p></div> : null}
    {!loading && filtered.length > 0 && <div className="memory-list">{filtered.map(f => {
      const active = editing?.key === f.key && editing?.scope === f.scope
      return <article className={`st-fact ${active ? 'is-editing' : ''}`} key={`${f.scope}:${f.key}`}>
        <span className="st-fact-icon"><Icon name="think" size={14} /></span>
        <div className="st-grow st-fact-main">
          <div className="st-fact-copy"><p className="st-fact-value">{f.value}</p></div>
          <div className="st-fact-meta"><span className="st-scope-chip">{scopeText(f.scope)}</span>{active ? <span className="st-editing-chip">正在编辑</span> : <SettingsDisclosure className="st-fact-details" title="查看详情"><code>{f.key}</code><span> · {new Date(f.updatedAt).toLocaleString()}</span></SettingsDisclosure>}</div>
          {active && actionError && <p className="st-error" role="alert">{actionError}</p>}
        </div>
        <div className={`st-fact-actions ${active ? 'is-editing' : ''}`}>
          {active ? <span className="st-fact-editing-label">编辑面板已打开</span> : <>
          <SettingsButton type="button" className="st-icon-button" disabled={busy || Boolean(editing)} aria-label={`编辑「${f.value}」`} title="编辑记忆" onClick={e => {
            editTrigger.current = e.currentTarget; setEditing(f); setValue(f.value); setActionError('')
          }}><Icon name="edit" size={14} /></SettingsButton>
          <SettingsButton type="button" className="st-icon-button st-danger-button" disabled={busy || Boolean(editing)} aria-label={`忘掉「${f.value}」`} title="忘掉这条记忆" onClick={() => void action(() => api.forgetFact(f.key, f.scope, f.updatedAt), () => setUndo(f))}><Icon name="trash" size={14} /></SettingsButton>
          </>}
        </div>
      </article>
    })}</div>}
    {editing && <div className="memory-editor-backdrop">
      <section className="memory-editor" role="dialog" aria-modal="true" aria-labelledby="memory-editor-title">
        <header className="memory-editor-header"><div className="memory-editor-heading"><span className="memory-editor-icon"><Icon name="edit" size={15} /></span><div><h4 id="memory-editor-title">编辑记忆</h4><p className="st-hint">{scopeText(editing.scope)}</p></div></div><SettingsButton type="button" className="st-icon-button" aria-label="关闭编辑器" title="关闭" disabled={busy} onClick={finishEditing}><Icon name="close" size={14} /></SettingsButton></header>
        <div className="memory-editor-context"><span>当前内容</span><p>{editing.value}</p></div>
        <label className="memory-editor-label" htmlFor="memory-editor-input">更新后的内容</label>
        <SettingsTextarea ref={input} id="memory-editor-input" aria-label="修改记忆" aria-describedby="memory-edit-hint" aria-invalid={Boolean(actionError)} rows={4} maxLength={1000} value={value} disabled={busy} onChange={e => setValue(e.target.value)} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape' && !busy) { e.preventDefault(); finishEditing() }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEditing() }
        }} />
        <div className="memory-editor-footer"><span className="st-hint" id="memory-edit-hint">{busy ? '正在保存…' : `${value.length}/1000 · Ctrl / ⌘ + Enter 保存 · Esc 取消`}</span><div className="st-actions"><SettingsButton type="button" className="st-button st-quiet" disabled={busy} onClick={finishEditing}>取消</SettingsButton><SettingsButton type="button" className="st-button st-primary" disabled={busy || !value.trim() || value.trim() === editing.value} onClick={saveEditing}><Icon name="check" size={13} />保存记忆</SettingsButton></div></div>
        {actionError && <p className="st-error" role="alert">{actionError}</p>}
      </section>
    </div>}
    {!editing && actionError && <p className="st-error" role="alert">{actionError}</p>}
    {undo && <div className="st-notice st-actions memory-undo"><span className="st-grow">已忘记这条记忆</span><SettingsButton type="button" className="st-button" disabled={busy || Boolean(editing)} onClick={() => void action(() => api.restoreFact(undo.key, undo.scope), () => setUndo(null))}>撤销</SettingsButton></div>}
    <p className="st-hint st-spaced memory-footnote">修改记忆不会改写原对话。关闭自动整理后，仍可在对话中要求“记住…”。</p>
  </section>
}
