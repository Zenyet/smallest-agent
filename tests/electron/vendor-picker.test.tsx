// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { VendorPicker } from '../../electron/renderer/src/components/VendorPicker'

// jsdom 没实现 popover。组件内部已经 try/catch 了，但补上桩才能让
// 「开着」这个状态在测试里成立。和 model-picker.test.tsx 同一套。
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const open = new WeakSet<HTMLElement>()
  proto.showPopover = function (this: HTMLElement) {
    open.add(this)
  }
  proto.hidePopover = function (this: HTMLElement) {
    open.delete(this)
  }
  const realMatches = HTMLElement.prototype.matches
  proto.matches = function (this: HTMLElement, sel: string) {
    if (sel === ':popover-open') return open.has(this)
    return realMatches.call(this, sel)
  }
})

afterEach(cleanup)

describe('VendorPicker', () => {
  const props = {
    current: 'anthropic',
    isConfigured: (id: string) => id === 'anthropic' || id === 'openai',
    onPick: () => {},
  }

  it('渲染：显示当前厂商名', () => {
    render(<VendorPicker {...props} />)
    expect(screen.getByRole('button', { name: /Anthropic/ }).textContent).toContain('Anthropic')
  })

  it('点击展开浮层，列出所有厂商 + 自定义端点', () => {
    render(<VendorPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    const listbox = screen.getByRole('listbox', { hidden: true })
    expect(listbox).toBeTruthy()
    // 九家内置 + 自定义端点 = 10 个选项
    expect(screen.getAllByRole('option', { hidden: true })).toHaveLength(10)
  })

  it('已配的选项后面打勾', () => {
    render(<VendorPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    const anthropic = screen.getByRole('option', { hidden: true, name: /Anthropic/ })
    const openai = screen.getByRole('option', { hidden: true, name: /OpenAI/ })
    const google = screen.getByRole('option', { hidden: true, name: /Google/ })
    expect(anthropic.textContent).toContain('✓')
    expect(openai.textContent).toContain('✓')
    expect(google.textContent).not.toContain('✓')
  })

  it('选中项用 accent-tint 高亮', () => {
    render(<VendorPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    const anthropic = screen.getByRole('option', { hidden: true, name: /Anthropic/ })
    expect(anthropic.className).toContain('bg-accent-tint')
  })

  it('浮层用和其它选择器同一套外观（无 border、有 shadow-overlay）', () => {
    render(<VendorPicker {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    const listbox = screen.getByRole('listbox', { hidden: true })
    expect(listbox.className).toMatch(/shadow-overlay\b/)
    expect(listbox.className).not.toMatch(/\bborder(-|\b)/)
  })
})
