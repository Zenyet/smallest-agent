import { useEffect, useRef, useState } from 'react'
import type { DesktopSettings } from '../../../../main/config-env'
import { AUTO_FIELDS, BOOLEAN_FIELDS } from '../../settings-fields'
import { numberError } from '../../../../shared/settings'

export type SaveSettings = (patch: DesktopSettings, unset?: string[]) => Promise<unknown>
export function useSettingsDraft(settings: DesktopSettings, onSave: SaveSettings) {
  const saved = useRef({ ...settings })
  const draft = useRef({ ...settings })
  const versions = useRef<Record<string, number>>({})
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const queuedValues = useRef(new Map<string, { value: string; id: number }>())
  const nextId = useRef(0)
  const saveFn = useRef(onSave)
  saveFn.current = onSave
  const mounted = useRef(true)
  const [, redraw] = useState(0)
  const [pending, setPending] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const update = () => { if (mounted.current) redraw(n => n + 1) }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const keys = new Set([...Object.keys(saved.current), ...Object.keys(settings)])
    for (const key of keys) {
      if ((draft.current[key] ?? '') === (saved.current[key] ?? '')) draft.current[key] = settings[key]
    }
    saved.current = { ...settings }
    update()
  }, [settings])
  const dirty = (key: string) => (draft.current[key] ?? '').trim() !== (saved.current[key] ?? '')
  const dirtyKeys = () => Object.keys(draft.current).filter(dirty)
  const set = (key: string, value: string) => {
    draft.current[key] = value
    versions.current[key] = (versions.current[key] ?? 0) + 1
    setErrors(old => { const next = { ...old }; delete next[key]; return next })
    setFeedback('')
    update()
  }
  const discard = (keys: string[]) => {
    for (const key of keys) { draft.current[key] = saved.current[key]; versions.current[key] = (versions.current[key] ?? 0) + 1 }
    setErrors(old => Object.fromEntries(Object.entries(old).filter(([key]) => !keys.includes(key))))
    update()
  }
  const commit = (keys: string[]): Promise<void> => {
    const changed = keys.filter(key => dirty(key) || (queuedValues.current.has(key) && queuedValues.current.get(key)!.value !== (draft.current[key] ?? '').trim()))
    if (!changed.length) return queue.current.then(() => {})
    for (const key of changed) {
      const error = numberError(key, draft.current[key] ?? '')
      if (error) { setErrors(old => ({ ...old, [key]: error })); return Promise.reject(new Error(error)) }
    }
    const values = Object.fromEntries(changed.map(key => [key, (draft.current[key] ?? '').trim()]))
    const id = ++nextId.current
    for (const key of changed) queuedValues.current.set(key, { value: values[key], id })
    const version = Object.fromEntries(changed.map(key => [key, versions.current[key]]))
    const patch = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''))
    const unset = changed.filter(key => values[key] === '')
    setPending(n => n + 1)
    setFeedback('正在保存…')
    const work = queue.current.catch(() => {}).then(async () => {
      try {
        await saveFn.current(patch, unset)
        for (const key of changed) {
          if (values[key]) saved.current[key] = values[key]
          else delete saved.current[key]
          if (versions.current[key] === version[key]) draft.current[key] = values[key]
        }
        if (mounted.current) {
          setErrors(old => Object.fromEntries(Object.entries(old).filter(([key]) => !changed.includes(key))))
          setFeedback('已保存')
          update()
        }
      } catch {
        if (mounted.current) {
          const current = changed.filter(key => versions.current[key] === version[key])
          for (const key of current) if (BOOLEAN_FIELDS.has(key)) draft.current[key] = saved.current[key]
          setErrors(old => ({ ...old, ...Object.fromEntries(current.map(key => [key, '保存失败，请重试。'])) }))
          setFeedback('保存失败，修改尚未完成。')
          update()
        }
        throw new Error('保存失败，请重试。')
      } finally {
        for (const key of changed) if (queuedValues.current.get(key)?.id === id) queuedValues.current.delete(key)
        if (mounted.current) setPending(n => n - 1)
      }
    })
    queue.current = work
    // Handle rejection even if the view closes; callers can still await the original promise.
    void work.catch(() => {})
    return work
  }
  const flush = async () => {
    await queue.current.catch(() => {})
    await commit(dirtyKeys().filter(key => AUTO_FIELDS.has(key)))
  }
  return { values: draft.current, saved: saved.current, errors, feedback, pending, dirty, dirtyKeys, set, discard, commit, flush }
}
export type SettingsDraft = ReturnType<typeof useSettingsDraft>
