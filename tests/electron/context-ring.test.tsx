// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ContextUsage } from '../../electron/renderer/src/components/TokenUsage'
import { modelContext, contextPercent } from '../../electron/shared/model-context'
import type { ChatMessage } from '../../electron/renderer/src/chat-reducer'
afterEach(cleanup)
const messages = (used: number): ChatMessage[] => [{ role: 'assistant', content: 'ok', tools: [], streaming: false, usages: [{ model: 'gpt-5.2', vendorId: 'openai', contextTokens: used }] }]
it('容量按 provider 和精确模型匹配，支持显式配置且拒绝错误值', () => {
  expect(modelContext('openai', 'gpt-5.2')).toBe(400000)
  expect(modelContext('codex', 'gpt-5.2')).toBe(400000)
  expect(modelContext('custom', 'gpt-5.2')).toBeUndefined()
  expect(modelContext('openai', 'gpt-5.2-fake')).toBeUndefined()
  expect(modelContext('custom', 'local', 8192)).toBe(8192)
  expect(modelContext('custom', 'local', -1)).toBeUndefined()
})
it.each([[0, 0], [200000, 50], [400000, 100], [500000, 100]])('圆环 %s token 正确映射为 %s%%', (used, percent) => {
  expect(contextPercent(used, 400000)).toBe(percent)
  const { container } = render(<ContextUsage messages={messages(used)} draft="" vendor="openai" model="gpt-5.2" capacity={400000} />)
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain(`${percent}%`)
  const circles = container.querySelectorAll('circle')
  if (percent) expect(circles[1].getAttribute('stroke-dasharray')).toBe(`${percent} 100`)
})
it('切换模型或服务不复用旧测量，未知不显示零或满环', () => {
  const { rerender } = render(<ContextUsage messages={messages(100000)} draft="" vendor="openai" model="gpt-5.2" capacity={400000} />)
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('25%')
  rerender(<ContextUsage messages={messages(100000)} draft="" vendor="openai" model="gpt-4o" capacity={128000} />)
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('占用 —')
  rerender(<ContextUsage messages={messages(100000)} draft="" vendor="custom" model="gpt-5.2" />)
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('容量未知')
  expect(contextPercent(undefined, 100)).toBeUndefined()
})
it('接近容量切换危险色，草稿不冒充已测量上下文', () => {
  const { container } = render(<ContextUsage messages={messages(390000)} draft="下一条问题" vendor="openai" model="gpt-5.2" capacity={400000} />)
  expect(container.querySelector('.is-critical')).not.toBeNull()
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('97%')
})
