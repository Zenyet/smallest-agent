import { SettingsButton, SettingsInput, SettingsSwitch, SettingsDisclosure } from './SettingsControls'
import { useState } from 'react'
import { Icon } from '../Icon'
import { AUTO_FIELDS, BOOLEAN_FIELDS, SETTING_DEFAULTS, hint, label } from '../../settings-fields'
import { NUMBER_RULES } from '../../../../shared/settings'
import type { SettingsDraft } from './useSettingsDraft'

export function SettingField({ name, form, inherited = false, effectiveValue }: {
  name: string; form: SettingsDraft; inherited?: boolean; effectiveValue?: string
}) {
  const [visible, setVisible] = useState(false)
  const title = label(name), error = form.errors[name]
  const value = form.values[name] ?? ''
  const rule = NUMBER_RULES[name]
  const secret = name.endsWith('_API_KEY')
  const save = () => { if (AUTO_FIELDS.has(name)) void form.commit([name]).catch(() => {}) }
  const description = <>
    {hint(name) && <p className="st-hint" id={`hint-${name}`}>{hint(name)}</p>}
    {inherited && !value && <p className="st-hint">当前使用启动环境中的配置；保存将覆盖它。</p>}
  </>
  if (BOOLEAN_FIELDS.has(name)) return (
    <div className="st-row field">
      <div className="st-grow"><label htmlFor={`setting-${name}`}>{title}</label>{description}
        {error && <p className="st-error" role="alert">{error}</p>}</div>
      <SettingsSwitch id={`setting-${name}`} aria-label={title}
        checked={(form.values[name] || effectiveValue || SETTING_DEFAULTS[name]) !== '0'}
        onCheckedChange={checked => { form.set(name, checked ? '1' : '0'); save() }} />
    </div>
  )
  return (
    <div className={`st-field field ${rule ? 'st-number-row' : ''}`}>
      <div className="st-grow"><label htmlFor={`setting-${name}`}>{title}</label>{description}</div>
      <div className={rule ? 'st-number-control' : 'st-grow'}>
        <div className="st-input-line">
          <SettingsInput id={`setting-${name}`} aria-label={title} type={secret && !visible ? 'password' : rule ? 'number' : 'text'}
            min={rule?.min} max={rule?.max} step={rule?.integer ? 1 : rule ? 0.1 : undefined}
            autoComplete="off" spellCheck={false} value={value} placeholder={effectiveValue || (inherited ? '使用启动环境配置' : SETTING_DEFAULTS[name] ?? '')}
            aria-invalid={Boolean(error)} aria-describedby={error ? `error-${name}` : hint(name) ? `hint-${name}` : undefined}
            onChange={e => form.set(name, e.target.value)} onBlur={save}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save() } }} />
          {secret && <SettingsButton type="button" className="st-button" aria-label={`${visible ? '隐藏' : '显示'} ${title}`} onClick={() => setVisible(v => !v)}>{visible ? '隐藏' : '显示'}</SettingsButton>}
        </div>
        {error && <p id={`error-${name}`} className="st-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
export function TechnicalFields({ names }: { names: readonly string[] }) {
  return <SettingsDisclosure className="st-details" title="开发者字段"><p className="st-code">{names.join(' · ')}</p></SettingsDisclosure>
}
export function SaveActions({ names, form, title = '保存配置' }: { names: string[]; form: SettingsDraft; title?: string }) {
  const dirty = names.some(form.dirty)
  return <div className="st-actions">
    <SettingsButton type="button" className={`st-button ${dirty ? 'st-primary' : ''}`} disabled={!dirty || form.pending > 0} onClick={() => void form.commit(names).catch(() => {})}>{form.pending ? '正在保存…' : title}</SettingsButton>
    {dirty && <SettingsButton type="button" className="st-button st-quiet" disabled={form.pending > 0} onClick={() => form.discard(names)}>放弃修改</SettingsButton>}
    {dirty && <span className="st-hint"><Icon name="dot" size={9} /> 未保存</span>}
  </div>
}
