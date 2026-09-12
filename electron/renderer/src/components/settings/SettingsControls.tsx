import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react'
import { Icon } from '../Icon'

/** Settings primitives own their appearance; semantic HTML retains IME and keyboard support. */
export const SettingsButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function SettingsButton({ className = 'st-button', type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={`st-control ${className}`} {...props} />
})
export const SettingsInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function SettingsInput({ className = '', type, ...props }, ref) {
  return <input ref={ref} type={type} className={`st-text-input ${className}`} {...props} />
})
export const SettingsTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function SettingsTextarea({ className = '', ...props }, ref) {
  return <textarea ref={ref} className={`st-text-input st-textarea ${className}`} {...props} />
})
export function SettingsSwitch({ checked, onCheckedChange, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <SettingsButton {...props} className="st-switch" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)}><span className="st-switch-thumb" /></SettingsButton>
}
export function SettingsDisclosure({ title, children, className = 'st-details' }: { title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className={className}>
    <SettingsButton className="st-disclosure-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Icon name="chevron" size={13} rotated={!open} /><span>{title}</span></SettingsButton>
    <div id={id} hidden={!open} className="st-disclosure-content">{children}</div>
  </div>
}
export function SettingsSelect({ value, onValueChange, options, 'aria-label': label, disabled = false }: {
  value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[]; 'aria-label': string; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const search = useRef({ text: '', time: 0 })
  const selected = Math.max(0, options.findIndex(option => option.value === value))
  const show = () => { setActive(selected); setOpen(true) }
  const choose = (index: number) => { if (options[index]) onValueChange(options[index].value); setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: 'nearest' }) }, [open, active, id])
  return <div ref={root} className="st-select" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
    <SettingsButton ref={trigger} className="st-select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" aria-activedescendant={open ? `${id}-${active}` : undefined} disabled={disabled || !options.length}
      onClick={() => open ? setOpen(false) : show()} onKeyDown={e => {
        if (e.key === 'Tab') { setOpen(false); return }
        if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }; return }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
          e.preventDefault()
          if (!open) { show(); return }
          if (e.key === 'Enter' || e.key === ' ') { choose(active); return }
          setActive(e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now(); search.current = { text: (now - search.current.time < 700 ? search.current.text : '') + e.key.toLowerCase(), time: now }
          const match = options.findIndex(option => option.label.toLowerCase().startsWith(search.current.text))
          if (match >= 0) { setActive(match); setOpen(true) }
        }
      }}><span>{options.find(option => option.value === value)?.label ?? '请选择'}</span><Icon name="chevron" size={14} className={open ? 'rotate-180' : ''} /></SettingsButton>
    {open && <div id={id} role="listbox" aria-label={label} className="st-select-menu">{options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value} className={`st-select-option ${active === index ? 'is-active' : ''}`} onPointerMove={() => setActive(index)} onMouseDown={e => e.preventDefault()} onClick={() => choose(index)}><span>{option.label}</span>{option.value === value && <Icon name="check" size={13} />}</div>)}</div>}
  </div>
}
