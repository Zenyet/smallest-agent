// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ProviderPicker } from '../../electron/renderer/src/components/ProviderPicker'
import { PermissionPicker } from '../../electron/renderer/src/components/PermissionPicker'
import { CliModelPicker } from '../../electron/renderer/src/components/CliModelPicker'
import type { ProvidersView } from '../../electron/shared/channels'

// jsdom 没实现 popover。补一个最小桩只维持开关状态 —— 真正的 light dismiss
// 是平台行为，这里验不了（和 model-picker.test.tsx 同一条）。
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

const view = (over: Partial<ProvidersView> = {}): ProvidersView => ({
  options: [
    { id: 'builtin', name: '内置 agent', external: false },
    { id: 'claude-code', name: 'Claude Code', external: true },
  ],
  current: 'builtin',
  models: [],
  permission: 'ask',
  configPath: '/tmp/providers.json',
  ...over,
})

describe('ProviderPicker', () => {
  // 模板里五家都是 disabled，所以「只有内置一个可选」是**默认状态**。
  // 点开只有一项的下拉是空动作 —— 显示成纯文本反而诚实。
  it('只有一个可选时不做成菜单', () => {
    render(
      <ProviderPicker
        view={view({ options: [{ id: 'builtin', name: '内置 agent', external: false }] })}
        onPick={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: '引擎' })).toBeNull()
    expect(screen.getByText('内置 agent')).toBeTruthy()
  })

  it('多个可选时才给下拉', () => {
    render(<ProviderPicker view={view()} onPick={() => {}} />)
    expect(screen.getByRole('button', { name: '引擎' })).toBeTruthy()
  })

  it('列出所有引擎，标出当前那个', () => {
    render(<ProviderPicker view={view({ current: 'claude-code' })} onPick={() => {}} />)
    const opts = screen.getAllByRole('option', { hidden: true })
    expect(opts.map((o) => o.textContent)).toEqual(['内置 agent', 'Claude Code'])
    const selected = opts.filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toBe('Claude Code')
  })

  it('选一个交出它的 id', () => {
    const picked: string[] = []
    render(<ProviderPicker view={view()} onPick={(id) => picked.push(id)} />)
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code', hidden: true }))
    expect(picked).toEqual(['claude-code'])
  })

  // 浮层定位那三个 style 是在对付 UA 的 `[popover] { inset: 0; margin: auto }`。
  // 见 ModelPicker.tsx 那段 —— 掉了浮层会被钉在视口顶端
  it('让开 UA 默认的 inset', () => {
    const { container } = render(<ProviderPicker view={view()} onPick={() => {}} />)
    const panel = container.querySelector('[role="listbox"]') as HTMLElement
    expect(panel.style.top).toBe('auto')
    expect(panel.style.right).toBe('auto')
    expect(panel.style.margin).toBe('0px')
  })

  it('浮层用和其它浮层同一套外观', () => {
    const { container } = render(<ProviderPicker view={view()} onPick={() => {}} />)
    const cls = container.querySelector('[role="listbox"]')!.className
    expect(cls).toMatch(/bg-overlay\b/)
    expect(cls).toMatch(/border-line-strong/)
    expect(cls).toMatch(/rounded-card/)
  })
})

describe('PermissionPicker', () => {
  it('三档都列出来', () => {
    render(<PermissionPicker current="ask" onPick={() => {}} />)
    const opts = screen.getAllByRole('option', { hidden: true })
    expect(opts).toHaveLength(3)
    // 每档在选项行里至少出现一次
    expect(screen.getAllByText('只读').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('询问').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('自动').length).toBeGreaterThanOrEqual(1)
  })

  // 「只读」「自动」这种词自己说不清后果 —— 用户要知道选了它磁盘会发生什么
  it('每一项带一句说明后果的话', () => {
    render(<PermissionPicker current="ask" onPick={() => {}} />)
    expect(screen.getByText(/一律拒绝/)).toBeTruthy()
    expect(screen.getByText(/不问直接放行/)).toBeTruthy()
  })

  it('触发按钮显示当前那档', () => {
    render(<PermissionPicker current="auto" onPick={() => {}} />)
    expect(screen.getByRole('button', { name: '权限' }).textContent).toBe('自动')
  })

  it('标出当前那一项', () => {
    render(<PermissionPicker current="readonly" onPick={() => {}} />)
    const selected = screen
      .getAllByRole('option', { hidden: true })
      .filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toMatch(/只读/)
  })

  it('选一档交出它的 id', () => {
    const picked: string[] = []
    render(<PermissionPicker current="ask" onPick={(m) => picked.push(m)} />)
    fireEvent.click(screen.getByRole('option', { name: /自动/, hidden: true }))
    expect(picked).toEqual(['auto'])
  })
})

describe('CliModelPicker', () => {
  const withModels = view({
    current: 'claude-code',
    models: [
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    ],
    currentModel: 'claude-opus-5',
  })

  // 一家 CLI 的模型列表没有第二层，所以这边**不分组**（内置那个按厂商分组）
  it('平铺列出，不分组', () => {
    render(<CliModelPicker view={withModels} onPick={() => {}} />)
    const opts = screen.getAllByRole('option', { hidden: true })
    expect(opts.map((o) => o.textContent)).toEqual(['Claude Opus 5', 'Claude Sonnet 5'])
  })

  it('触发按钮显示当前模型名', () => {
    render(<CliModelPicker view={withModels} onPick={() => {}} />)
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe('Claude Opus 5')
  })

  it('选一个交出它的 id', () => {
    const picked: string[] = []
    render(<CliModelPicker view={withModels} onPick={(id) => picked.push(id)} />)
    fireEvent.click(screen.getByRole('option', { name: 'Claude Sonnet 5', hidden: true }))
    expect(picked).toEqual(['claude-sonnet-5'])
  })

  // 认不出当前模型时显示 id 本身，不是空标签（和 ModelPicker 同一条）
  it('认不出当前模型时显示 id', () => {
    render(
      <CliModelPicker view={{ ...withModels, currentModel: '被删掉的' }} onPick={() => {}} />,
    )
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe('被删掉的')
  })

  it('一个模型都没声明时显示「默认模型」', () => {
    render(
      <CliModelPicker
        view={{ ...withModels, models: [], currentModel: undefined }}
        onPick={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '模型' }).textContent).toBe('默认模型')
  })
})
