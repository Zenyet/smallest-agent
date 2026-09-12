// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectTaskCard, ProjectTaskStarter } from '../../electron/renderer/src/components/ProjectTaskCard'
import type { ProjectTask } from '../../electron/shared/project-task'

afterEach(cleanup)
const task: ProjectTask = {
  id: 'task', sessionId: 's', projectId: 'p', projectPath: '/project', projectName: 'sample', prompt: '理解项目',
  status: 'review', createdAt: 1, updatedAt: 2, revision: 2, toolCount: 1,
  sources: [{ path: 'README.md', excerpt: 'pnpm test', truncated: false }], answer: '运行方式见 README.md。',
}

it('从项目入口启动，明确说明只读执行', () => {
  const start = vi.fn()
  render(<ProjectTaskStarter projectName="sample" onStart={start} />)
  expect(screen.getByText(/只读/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '理解项目' }))
  expect(start).toHaveBeenCalledOnce()
})

it('待验收成果可查看来源、采用和导出；取消导出不显示成功', async () => {
  const accept = vi.fn(async () => {})
  const exportTask = vi.fn(async () => null)
  render(<ProjectTaskCard task={task} onAccept={accept} onExport={exportTask} />)
  expect(screen.getByText('待验收')).toBeTruthy()
  fireEvent.click(screen.getByText(/查看读取依据/))
  fireEvent.click(screen.getByText('README.md'))
  expect(screen.getByText('pnpm test')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '采用成果' }))
  await waitFor(() => expect(accept).toHaveBeenCalledOnce())
  await waitFor(() => expect((screen.getByRole('button', { name: '导出 Markdown' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }))
  await waitFor(() => expect(exportTask).toHaveBeenCalledOnce())
  expect(screen.queryByText('已导出 Markdown')).toBeNull()
})

it('失败或中断的任务不提供采用按钮', () => {
  const { rerender } = render(<ProjectTaskCard task={{ ...task, status: 'failed', error: '没有依据' }} onAccept={async () => {}} onExport={async () => null} />)
  expect(screen.getByText('没有依据')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '采用成果' })).toBeNull()
  expect(screen.queryByRole('button', { name: '导出 Markdown' })).toBeNull()
  rerender(<ProjectTaskCard task={{ ...task, status: 'stopped' }} onAccept={async () => {}} onExport={async () => null} />)
  expect(screen.getByText('已停止')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '采用成果' })).toBeNull()
})
