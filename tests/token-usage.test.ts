import { afterEach, expect, it, vi } from 'vitest'
import { modelUsage, summarizeUsage } from '../src/usage'
import { makeCallModel } from '../src/llm'
import { loadConfig } from '../src/config'
import { cacheKey } from '../src/cache'
import { runAgent } from '../src/agent'
import { createBuiltinProvider } from '../electron/main/provider/builtin'
import { createApprovalGate } from '../electron/main/approval'
import { CancelToken } from '../electron/main/cancel'
import { hydrateMessages } from '../electron/renderer/src/hydrate'
import { chatReducer } from '../electron/renderer/src/chat-reducer'
import type { Message, TokenUsage } from '../src/types'

afterEach(() => vi.unstubAllGlobals())
it('unknown is not zero and subset tokens are not double counted', () => {
  expect(modelUsage({}, 'test').inputTokens).toBeUndefined()
  const usage = modelUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120, inputTokenDetails: { cacheReadTokens: 60 }, outputTokenDetails: { reasoningTokens: 10 } }, 'test')
  expect(summarizeUsage([usage])).toMatchObject({ totalTokens: 120, cacheReadTokens: 60, reasoningTokens: 10, partial: false })
  expect(summarizeUsage([usage, {}]).partial).toBe(true)
  expect(modelUsage({ inputTokens: -1, outputTokens: NaN }, 'test').inputTokens).toBeUndefined()
})
it.each([false, true])('SDK chat usage survives streaming=%s', async streaming => {
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 10 } }
  const base = { id: 'test', created: 1, model: 'test' }
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (streaming) expect(JSON.parse(String(init?.body)).stream_options).toEqual({ include_usage: true })
    return streaming
    ? new Response([
      { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
    ].map(v => `data: ${JSON.stringify(v)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    : new Response(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }), { headers: { 'content-type': 'application/json' } })
  })
  const result = await makeCallModel({ ...loadConfig({ DEEPSEEK_API_KEY: 'test' }), fetch }, {}, streaming ? () => {} : undefined)([{ role: 'user', content: 'hi' }])
  expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120, contextTokens: 100, cacheReadTokens: 60 })
})
it('Responses SDK usage is captured', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'r1', object: 'response', created_at: 0, model: 'test', status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } } }), { headers: { 'content-type': 'application/json' } }))
  const result = await makeCallModel({ ...loadConfig({ DEEPSEEK_API_KEY: 'test' }), protocol: 'responses', nativeSearch: { kind: 'none' } }, {})([{ role: 'user', content: 'hi' }])
  expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, reasoningTokens: 10 })
})
it('local reuse records zero new consumption and survives history reload', async () => {
  let saved: Message[] = []; const live: TokenUsage[] = []
  const provider = createBuiltinProvider({ registry: {}, gate: createApprovalGate(), onApprovalRequest() {}, runAgent, makeSummarize: () => async () => '', buildCallModel: (_c, _r, _t, hit) => async () => { hit(); return { text: 'cached', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } } })
  await provider.runTurn({ question: 'hi', sessionId: 's', history: [], config: loadConfig({ DEEPSEEK_API_KEY: 'test' }), token: new CancelToken(), emit: e => { if (e.kind === 'usage') live.push(e.usage) }, onComplete: async m => { saved = JSON.parse(JSON.stringify(m)) } })
  expect(live[0]).toMatchObject({ localCacheHit: true, inputTokens: 0, outputTokens: 0, contextTokens: 100 })
  expect(hydrateMessages(saved, 's').at(-1)?.usages).toEqual(live)
})
it('history groups tool-loop calls by user turn and live buckets stay isolated', () => {
  const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
  const history: Message[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: '', usage, toolCalls: [{ id: '1', name: 'read', args: {} }] }, { role: 'tool', content: 'file', toolCallId: '1' }, { role: 'assistant', content: 'answer', usage }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'second', usage }]
  const restored = hydrateMessages(history, 's')
  expect(restored[1].usages).toHaveLength(2)
  expect(restored[3].usages).toHaveLength(1)
  const state = chatReducer({}, { type: 'chunk', event: { sessionId: 'a', text: '', usage } })
  expect(state.a.messages[0].usages).toEqual([usage])
  expect(state.b).toBeUndefined()
  expect(cacheKey('m', history)).toBe(cacheKey('m', history.map(({ usage: _usage, ...m }) => m)))
})
