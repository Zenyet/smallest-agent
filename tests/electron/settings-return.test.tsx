// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { App } from '../../electron/renderer/src/App'
import { api } from '../../electron/renderer/src/api'

beforeEach(() => {
  vi.spyOn(api, 'getRuntimeStatus').mockResolvedValue({ phase: 'ready', detail: 'ready' })
  vi.spyOn(api, 'getSettings').mockResolvedValue({ DEEPSEEK_API_KEY: 'demo' })
  vi.spyOn(api, 'getSettingsStatus').mockResolvedValue({ pendingKeys: [], applied: {}, inheritedKeys: [] })
  vi.spyOn(api, 'listSessions').mockResolvedValue([{ id: 's', title: 'Test chat', updatedAt: 1 }])
  vi.spyOn(api, 'loadSession').mockResolvedValue([])
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('opening and closing settings preserves the chat draft', async () => {
  render(<App />)
  await waitFor(() => expect(screen.getByRole('button', { name: '设置' })).toBeTruthy())
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'Keep this unsent question' } })
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  await screen.findByRole('heading', { name: '模型连接' })
  fireEvent.click(screen.getByRole('button', { name: '返回对话' }))
  await waitFor(() => expect(screen.queryByRole('heading', { name: '模型连接' })).toBeNull())
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this unsent question')
})
