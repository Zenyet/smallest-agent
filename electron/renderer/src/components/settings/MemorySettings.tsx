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
  return <>
    <div className="st-section-head"><h3>已记住的内容</h3><span className="st-hint">{facts.length} 条</span></div>
    <div className="st-filters" aria-label="记忆范围">{[['all', '全部'], ['project', '当前项目'], ['global', '全局']].map(([id, text]) => <SettingsButton type="button" className="st-filter" key={id} aria-pressed={scope === id} disabled={Boolean(editing) || busy || (id === 'project' && !projectPath)} onClick={() => setScope(id)}>{text}</SettingsButton>)}</div>
    {loading ? <p className="st-hint" role="status">正在读取记忆…</p> : error ? <div className="st-notice"><p className="st-error" role="alert">{error}</p><SettingsButton type="button" className="st-button" onClick={() => void read()}>重新读取</SettingsButton></div> : filtered.length === 0 ? <p className="st-empty">{facts.length === 0 ? '还没有记住任何事实。在对话中告诉它“我住在深圳”或项目约定，即可开始。' : '这个范围内还没有记忆。'}</p> : null}
    {!loading && filtered.map(f => {
      const active = editing?.key === f.key && editing?.scope === f.scope
      const save = () => { if (value.trim() && !busy) void action(() => api.updateFact(f.key, f.scope, value.trim()), finishEditing) }
      return <div className={`st-fact ${active ? 'is-editing' : ''}`} key={`${f.scope}:${f.key}`}>
        <div className="st-grow">
          <div className="st-fact-copy">{active ? <>
            <span className="st-fact-mirror" aria-hidden="true">{value + '\n'}</span>
            <SettingsTextarea ref={input} aria-label="修改记忆" aria-describedby="memory-edit-hint" aria-invalid={Boolean(actionError)} rows={1} value={value} disabled={busy} onChange={e => setValue(e.target.value)} onKeyDown={e => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Escape' && !busy) { e.preventDefault(); finishEditing() }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
            }} />
          </> : <p>{f.value}</p>}</div>
          <p className="st-hint">{f.scope === 'global' ? '全局 · 所有项目' : `项目 · ${f.scope.slice(8)}`}</p>
          {active ? <p className="st-hint st-edit-hint" id="memory-edit-hint">{busy ? '正在保存…' : 'Ctrl / ⌘ + Enter 保存 · Esc 取消'}</p> : <SettingsDisclosure className="st-fact-details" title="详情"><code>{f.key}</code><span> · {new Date(f.updatedAt).toLocaleString()}</span></SettingsDisclosure>}
          {active && actionError && <p className="st-error" role="alert">{actionError}</p>}
        </div>
        <div className="st-fact-actions">
          <SettingsButton type="button" className={`st-icon-button ${active ? 'st-save-icon' : ''}`} disabled={busy || (active ? !value.trim() || value.trim() === f.value : Boolean(editing))} aria-label={active ? '保存记忆' : `编辑「${f.value}」`} title={active ? '保存记忆' : '编辑记忆'} onClick={e => {
            if (active) save()
            else { editTrigger.current = e.currentTarget; setEditing(f); setValue(f.value); setActionError('') }
          }}><Icon name={active ? 'check' : 'edit'} size={14} /></SettingsButton>
          {active ? <SettingsButton className="st-icon-button" disabled={busy} aria-label="取消" title="取消编辑" onClick={finishEditing}><Icon name="close" size={14} /></SettingsButton> :
          <SettingsButton type="button" className="st-icon-button st-danger-button" disabled={busy || Boolean(editing)} aria-label={`忘掉「${f.value}」`} title="忘掉这条记忆" onClick={() => void action(() => api.forgetFact(f.key, f.scope, f.updatedAt), () => setUndo(f))}><Icon name="trash" size={14} /></SettingsButton>}
        </div>
      </div>
    })}
    {!editing && actionError && <p className="st-error" role="alert">{actionError}</p>}
    {undo && <div className="st-notice st-actions"><span className="st-grow">已忘记这条记忆</span><SettingsButton type="button" className="st-button" disabled={busy || Boolean(editing)} onClick={() => void action(() => api.restoreFact(undo.key, undo.scope), () => setUndo(null))}>撤销</SettingsButton></div>}
    <p className="st-hint st-spaced">修改记忆不会改写原对话。关闭自动整理后，仍可在对话中要求“记住…”。</p>
  </>
}
