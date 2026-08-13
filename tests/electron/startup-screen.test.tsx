// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { StartupScreen } from '../../electron/renderer/src/components/StartupScreen'

afterEach(cleanup)

describe('StartupScreen', () => {
  it('显示当前阶段的说明文字', () => {
    render(<StartupScreen status={{ phase: 'embedding', detail: '正在加载 embedding 模型…' }} onRetry={() => {}} />)
    expect(screen.getByText(/正在加载 embedding 模型/)).toBeTruthy()
  })

  it('把三个阶段都画出来，已完成的打勾', () => {
    const { container } = render(<StartupScreen status={{ phase: 'mcp', detail: '连接中' }} onRetry={() => {}} />)
    expect(container.querySelectorAll('.step')).toHaveLength(3)
    expect(container.querySelectorAll('.step--done')).toHaveLength(2)
  })

  it('首次启动提示模型下载可能较慢', () => {
    render(<StartupScreen status={{ phase: 'embedding', detail: 'x' }} onRetry={() => {}} />)
    expect(screen.getByText(/首次运行需要下载/)).toBeTruthy()
  })

  it('失败时显示错误详情和重试按钮', () => {
    let retried = 0
    render(<StartupScreen status={{ phase: 'failed', detail: 'MCP 起不来' }} onRetry={() => retried++} />)
    expect(screen.getByText(/MCP 起不来/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /重启/ }))
    expect(retried).toBe(1)
  })

  it('失败时不显示阶段进度（已经没意义了）', () => {
    const { container } = render(<StartupScreen status={{ phase: 'failed', detail: 'x' }} onRetry={() => {}} />)
    expect(container.querySelectorAll('.step')).toHaveLength(0)
  })

  it('ready 状态显示所有步骤完成', () => {
    const { container } = render(<StartupScreen status={{ phase: 'ready', detail: '就绪' }} onRetry={() => {}} />)
    expect(container.querySelectorAll('.step')).toHaveLength(3)
    expect(container.querySelectorAll('.step--done')).toHaveLength(3)
    expect(screen.getByText(/就绪/)).toBeTruthy()
  })

  it('重启按钮点击后禁用，防止重复触发', () => {
    render(<StartupScreen status={{ phase: 'failed', detail: 'x' }} onRetry={() => {}} />)
    const button = screen.getByRole('button', { name: /重启/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
  })
})
