// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { createRef } from 'react'
import { SettingsPanel, type SettingsPanelHandle } from '../../electron/renderer/src/components/SettingsPanel'
import { SECTIONS } from '../../electron/renderer/src/settings-fields'
import type { DesktopSettings } from '../../electron/main/config-env'
import { api } from '../../electron/renderer/src/api'

beforeEach(() => {
  vi.spyOn(api, 'getSettingsStatus').mockResolvedValue({ pendingKeys: [], applied: { NOTES_DIR: './notes' }, inheritedKeys: [] })
  vi.spyOn(api, 'getFacts').mockResolvedValue([])
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const defaults = { settings: {}, activeSection: 'provider' as const, onSave: async () => {}, onRestart: async () => {} }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

describe('设置改版', () => {
  it('导航按五个用户任务分组', () => {
    expect(SECTIONS.map(s => s.label)).toEqual(['模型连接', 'Agent 与工具', '记忆与资料', '对话偏好', '高级与诊断'])
  })
  it('凭据显式保存，只提交修改字段，不改变会话模型', async () => {
    const save = vi.fn(async () => {})
    render(<SettingsPanel {...defaults} settings={{ DEEPSEEK_API_KEY: 'old', ACTIVE_VENDOR: 'deepseek', ACTIVE_MODEL: 'deepseek-chat' }} onSave={save} />)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new-key' } })
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ DEEPSEEK_API_KEY: 'new-key' }, []))
  })
  it('清空凭据通过明确的 unset 操作提交', async () => {
    const save = vi.fn(async () => {})
    render(<SettingsPanel {...defaults} settings={{ DEEPSEEK_API_KEY: 'old' }} onSave={save} />)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({}, ['DEEPSEEK_API_KEY']))
  })
  it('添加服务只改变表单，已填写的草稿跨分区保留', async () => {
    const save = vi.fn(async () => {})
    const view = render(<SettingsPanel {...defaults} onSave={save} />)
    fireEvent.click(screen.getByRole('button', { name: '添加服务' }))
    fireEvent.click(screen.getByRole('combobox', { name: '服务类型' }))
    fireEvent.click(screen.getByRole('option', { name: 'Anthropic' }))
    fireEvent.click(screen.getByRole('button', { name: /^添加$/ }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'draft-key' } })
    view.rerender(<SettingsPanel {...defaults} onSave={save} activeSection="general" />)
    view.rerender(<SettingsPanel {...defaults} onSave={save} />)
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('draft-key')
    expect(save).not.toHaveBeenCalled()
  })
  it('未保存的凭据不能验证；验证成功后再编辑即失效', async () => {
    const check = vi.spyOn(api, 'checkConnection').mockResolvedValue({ ok: true, model: 'demo', checkedAt: 1000, message: '请求成功' })
    render(<SettingsPanel {...defaults} settings={{ DEEPSEEK_API_KEY: 'old' }} />)
    fireEvent.click(screen.getByRole('button', { name: '验证连接' }))
    await screen.findByText('文本请求可用')
    expect(check).toHaveBeenCalledWith('deepseek')
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new' } })
    expect(screen.queryByText('文本请求可用')).toBeNull()
    expect((screen.getByRole('button', { name: '验证连接' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('保存错误保留凭据草稿并允许重试', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('remote-secret')).mockResolvedValue(undefined)
    render(<SettingsPanel {...defaults} onSave={save} />)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new' } })
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await screen.findByText('保存失败，请重试。')
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('new')
    expect(screen.queryByText('remote-secret')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  })
  it('连续切换同一开关时按顺序保存最终选择', async () => {
    const first = deferred(), calls: DesktopSettings[] = []
    const save = vi.fn(async (patch: DesktopSettings) => { calls.push(patch); if (calls.length === 1) await first.promise })
    render(<SettingsPanel {...defaults} activeSection="general" settings={{ STREAM: '1' }} onSave={save} />)
    fireEvent.click(screen.getByRole('switch', { name: '逐字显示回答' }))
    fireEvent.click(screen.getByRole('switch', { name: '逐字显示回答' }))
    await act(async () => first.resolve())
    await waitFor(() => expect(calls).toEqual([{ STREAM: '0' }, { STREAM: '1' }]))
    expect(screen.getByRole('switch', { name: '逐字显示回答' }).getAttribute('aria-checked')).toBe('true')
  })
  it('快速修改两个设置不会提交旧表单快照', async () => {
    const save = vi.fn(async () => {})
    render(<SettingsPanel {...defaults} activeSection="general" onSave={save} />)
    fireEvent.click(screen.getByRole('switch', { name: '逐字显示回答' }))
    fireEvent.click(screen.getByRole('switch', { name: '复用相同请求的答案' }))
    await waitFor(() => expect(save.mock.calls).toEqual([[{ STREAM: '0' }, []], [{ LLM_CACHE: '0' }, []]]))
  })
  it('返回等待普通参数保存完成，失败时保留编辑', async () => {
    const job = deferred(), close = vi.fn(), ref = createRef<SettingsPanelHandle>()
    render(<SettingsPanel {...defaults} ref={ref} activeSection="advanced" onSave={() => job.promise} onClose={close} />)
    fireEvent.change(screen.getByLabelText('最大执行轮数'), { target: { value: '12' } })
    let exit!: Promise<void>
    act(() => { exit = ref.current!.requestClose() })
    expect(close).not.toHaveBeenCalled()
    await act(async () => { job.resolve(); await exit })
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('凭据草稿离开时提供保存、放弃或继续编辑', async () => {
    const close = vi.fn(), ref = createRef<SettingsPanelHandle>()
    render(<SettingsPanel {...defaults} ref={ref} onClose={close} />)
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'draft' } })
    await act(async () => ref.current!.requestClose())
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存并返回' }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })
  it('无效数字不会落盘，显示字段错误', async () => {
    const save = vi.fn(async () => {})
    render(<SettingsPanel {...defaults} activeSection="advanced" onSave={save} />)
    const input = screen.getByLabelText('最大执行轮数')
    fireEvent.change(input, { target: { value: '-1' } }); fireEvent.blur(input)
    await screen.findByText('请输入不小于 1 的整数')
    expect(save).not.toHaveBeenCalled()
  })
  it('后端的待生效状态跨分区和保存同步仍然显示', async () => {
    vi.mocked(api.getSettingsStatus).mockResolvedValue({ pendingKeys: ['NOTES_DIR'], applied: { NOTES_DIR: '/old' }, inheritedKeys: [] })
    const restart = vi.fn(async () => {})
    const view = render(<SettingsPanel {...defaults} activeSection="memory" initialMemoryTab="notes" settings={{ NOTES_DIR: '/new' }} onRestart={restart} />)
    await screen.findByText('已保存，重启后生效')
    expect(screen.getByText('当前生效目录：/old')).toBeTruthy()
    view.rerender(<SettingsPanel {...defaults} activeSection="general" settings={{ NOTES_DIR: '/new' }} onRestart={restart} />)
    expect(screen.getByText('已保存，重启后生效')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '立即重启' }))
    await waitFor(() => expect(restart).toHaveBeenCalledOnce())
  })
  it('导入先预览且仅提交目标服务凭据', async () => {
    vi.spyOn(api, 'detectProviders').mockResolvedValue([{ provider: 'claude', available: true }])
    vi.spyOn(api, 'importProvider').mockResolvedValue({ apiKey: 'imported', model: 'foreign-model' })
    const save = vi.fn(async () => {})
    render(<SettingsPanel {...defaults} onSave={save} />)
    fireEvent.click(screen.getByText('从本机 CLI 导入已有凭据'))
    fireEvent.click(screen.getByRole('button', { name: '检测已有配置' }))
    fireEvent.click(await screen.findByRole('button', { name: '预览导入' }))
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ ANTHROPIC_API_KEY: 'imported' }, []))
  })
  it('停用的引擎仍可重新启用，状态不冒充可连接', () => {
    const toggle = vi.fn()
    render(<SettingsPanel {...defaults} activeSection="agents" providers={{ options: [], current: 'builtin', models: [], permission: 'ask', configPath: '/tmp/providers.json', allProviders: [{ id: 'codex', name: 'Codex', enabled: false }] }} onToggleProvider={toggle} />)
    fireEvent.click(screen.getByRole('switch', { name: '启用 Codex' }))
    expect(toggle).toHaveBeenCalledWith('codex', true)
    expect(screen.getByText('未启用')).toBeTruthy()
  })
})
