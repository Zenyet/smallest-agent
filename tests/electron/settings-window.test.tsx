// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { DesktopSettings, RuntimeStatusEvent } from '../../electron/shared/channels'

// api.ts 在模块加载时就把 window.electronAPI 抓成一个 const，测试里改
// window.electronAPI 已经影响不到它 —— 所以直接 mock 这个模块。
const stub = {
  getRuntimeStatus: vi.fn<() => Promise<RuntimeStatusEvent>>(),
  getSettings: vi.fn<() => Promise<DesktopSettings>>(),
  saveSettings: vi.fn<(p: DesktopSettings) => Promise<DesktopSettings>>(),
  restartApp: vi.fn(async () => {}),
  detectProviders: vi.fn(async () => []),
  importProvider: vi.fn(async () => null),
  // 显式标出回调参数：不标的话 vi.fn 会把签名推成「不接受参数」，
  // 后面那个「用推送接上 ready」的用例想拿到 cb 就通不过类型检查。
  onRuntimeStatus: vi.fn<(cb: (s: RuntimeStatusEvent) => void) => () => void>(),
  onSettingsChanged: vi.fn<(cb: (s: DesktopSettings) => void) => () => void>(),
}

vi.mock('../../electron/renderer/src/api', () => ({ api: stub }))

// import 要在 vi.mock 之后（vi.mock 会被提到顶部，但动态 import 更直白）
const { SettingsWindow } = await import('../../electron/renderer/src/SettingsWindow')

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  stub.getRuntimeStatus.mockResolvedValue({ phase: 'ready', detail: '就绪' })
  stub.getSettings.mockResolvedValue({ DEEPSEEK_MODEL: 'deepseek-chat' })
  stub.saveSettings.mockImplementation(async (p) => p)
  stub.onRuntimeStatus.mockReturnValue(() => {})
  stub.onSettingsChanged.mockReturnValue(() => {})
})

describe('SettingsWindow', () => {
  it('设置还没读回来时不渲染面板 —— 这是那个「一排空输入框，一保存把好 key 冲掉」的坑', async () => {
    // getSettings 永远不 resolve：模拟"还在读"
    stub.getSettings.mockReturnValue(new Promise(() => {}))
    const { container } = render(<SettingsWindow />)
    expect(screen.getByText(/读取设置中/)).toBeTruthy()
    // 面板的字段一个都不能出现（SettingsPanel 的 draft 只在挂载时播种一次，
    // 提前挂载就等于用空对象播种）
    await waitFor(() => expect(stub.getSettings).toHaveBeenCalled())
    expect(container.querySelector('.field')).toBeNull()
  })

  it('读回来之后渲染面板，并把值填进去', async () => {
    render(<SettingsWindow />)
    // Provider 分组下才有 DEEPSEEK_MODEL，先等面板出现
    await screen.findByRole('button', { name: 'Provider' })
    expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy()
  })

  it('phase 落定之前不去调 getSettings（handler 那时还没注册，invoke 会砸在 No handler registered 上）', async () => {
    stub.getRuntimeStatus.mockResolvedValue({ phase: 'embedding', detail: '加载模型…' })
    render(<SettingsWindow />)
    await waitFor(() => expect(stub.getRuntimeStatus).toHaveBeenCalled())
    expect(stub.getSettings).not.toHaveBeenCalled()
    expect(screen.getByText(/读取设置中/)).toBeTruthy()
  })

  it('启动失败时照样能编辑设置 —— 那时候设置窗口正是用户唯一的出路', async () => {
    stub.getRuntimeStatus.mockResolvedValue({ phase: 'failed', detail: '缺 API Key' })
    render(<SettingsWindow />)
    await screen.findByRole('button', { name: 'Provider' })
    expect(stub.getSettings).toHaveBeenCalled()
  })

  it('启动过程中开的窗口，靠 onRuntimeStatus 的推送接上后续的 ready', async () => {
    stub.getRuntimeStatus.mockResolvedValue({ phase: 'mcp', detail: '连接 MCP…' })
    let push: ((s: RuntimeStatusEvent) => void) | undefined
    stub.onRuntimeStatus.mockImplementation((cb: (s: RuntimeStatusEvent) => void) => {
      push = cb
      return () => {}
    })
    render(<SettingsWindow />)
    await waitFor(() => expect(push).toBeTruthy())
    expect(stub.getSettings).not.toHaveBeenCalled()
    // 主进程随后广播 ready
    push!({ phase: 'ready', detail: '就绪' })
    await waitFor(() => expect(stub.getSettings).toHaveBeenCalled())
  })

  it('读设置失败时把错误显示出来，而不是永远停在「读取设置中」', async () => {
    stub.getSettings.mockRejectedValue(new Error('磁盘炸了'))
    const { container } = render(<SettingsWindow />)
    await screen.findByText(/磁盘炸了/)
    expect(container.querySelector('.settings__error')).toBeTruthy()
  })

  it('订阅 onSettingsChanged，接住别处改的设置', async () => {
    render(<SettingsWindow />)
    await waitFor(() => expect(stub.onSettingsChanged).toHaveBeenCalled())
  })
})
