// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { SettingsDisclosure, SettingsInput, SettingsSelect, SettingsSwitch } from '../../electron/renderer/src/components/settings/SettingsControls'

afterEach(cleanup)
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Charlie' }]
it('下拉键盘导航只在确认后提交，Escape 取消，焦点保留在触发器', () => {
  const change = vi.fn()
  render(<SettingsSelect aria-label="服务" value="a" onValueChange={change} options={options} />)
  const trigger = screen.getByRole('combobox')
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(trigger, { key: 'End' })
  expect(change).not.toHaveBeenCalled()
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(change).toHaveBeenCalledWith('b')
  expect(screen.queryByRole('listbox')).toBeNull()
})
it('下拉支持首字母查找、点击选择和点击外部关闭', () => {
  const change = vi.fn()
  render(<SettingsSelect aria-label="服务" value="a" onValueChange={change} options={options} />)
  const trigger = screen.getByRole('combobox')
  fireEvent.keyDown(trigger, { key: 'c' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(change).toHaveBeenCalledWith('c')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
  expect(change).toHaveBeenLastCalledWith('b')
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('listbox')).toBeNull()
})
it('折叠使用 SVG 并保留编辑值，收起后内容不再进入可访问树', () => {
  render(<SettingsDisclosure title="高级配置"><SettingsInput aria-label="草稿" defaultValue="" /></SettingsDisclosure>)
  expect(screen.queryByRole('textbox')).toBeNull()
  const toggle = screen.getByRole('button', { name: '高级配置' })
  expect(toggle.querySelector('svg')).not.toBeNull()
  fireEvent.click(toggle)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留' } })
  fireEvent.click(toggle)
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(toggle)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('保留')
})
it('开关通过 aria-checked 表达状态且禁用时不可切换', () => {
  function Example() {
    const [checked, setChecked] = useState(false)
    return <SettingsSwitch aria-label="偏好" checked={checked} onCheckedChange={setChecked} disabled={checked} />
  }
  render(<Example />)
  const toggle = screen.getByRole('switch')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
})
