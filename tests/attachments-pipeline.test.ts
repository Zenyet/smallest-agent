import { describe, it, expect } from 'vitest'
import { runAgent } from '../src/agent'
import { makeCallModel, toSdkMessages } from '../src/llm'
import { loadConfig } from '../src/config'
import { userMessage, validateAttachments } from '../src/attachments'
import { acpPromptContent } from '../electron/main/provider/attachment-content'
import { hydrateMessages } from '../electron/renderer/src/hydrate'
import type { ContentPart, Message } from '../src/types'

const file = (mimeType = 'text/markdown', content = '# 项目\n使用 pnpm'): ContentPart => ({
  type: 'file', filename: mimeType === 'application/pdf' ? 'report.pdf' : 'README.md', mimeType,
  data: `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`,
})
const image: ContentPart = { type: 'image', filename: 'shot.png', data: 'data:image/png;base64,YQ==' }

describe('附件从模型输入到历史回放', () => {
  it('通过真实 SDK 到达请求体，正文与附件不会在协议转换时丢失', async () => {
    let body: any
    const config = { ...loadConfig({ DEEPSEEK_API_KEY: 'test' }), fetch: async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }), { headers: { 'content-type': 'application/json' } })
    } }
    await runAgent('解释附件', { config, tools: {}, callModel: makeCallModel(config, {}), attachments: [file(), image, file('application/pdf', '%PDF')] })
    const user = body.messages.find((m: any) => m.role === 'user')
    expect(user.content).toContainEqual({ type: 'text', text: '解释附件' })
    expect(user.content).toContainEqual({ type: 'text', text: expect.stringContaining('使用 pnpm') })
    expect(user.content).toContainEqual({ type: 'image_url', image_url: { url: image.type === 'image' ? image.data : '' } })
    expect(user.content).toContainEqual({ type: 'file', file: {
      filename: 'report.pdf', file_data: `data:application/pdf;base64,${Buffer.from('%PDF').toString('base64')}`,
    } })
  })

  it('文本、图片和 PDF 与问题一起进入模型，持久化后仍可恢复', async () => {
    const attachments = validateAttachments([file(), image, file('application/pdf', '%PDF-1.4')])
    let seen: Message[] = []
    let saved: Message[] = []
    await runAgent('解释这些资料', {
      config: { systemPrompt: 'test', maxTurns: 1 }, tools: {}, attachments,
      callModel: async (messages) => { seen = messages; return { text: 'answer', toolCalls: [] } },
      onComplete: (messages) => { saved = JSON.parse(JSON.stringify(messages)) },
    })
    const request = toSdkMessages(seen).find((m) => m.role === 'user')!
    expect(request.content).toEqual([
      { type: 'text', text: '解释这些资料' },
      { type: 'text', text: expect.stringContaining('使用 pnpm') },
      { type: 'image', image: Buffer.from('a'), mediaType: 'image/png' },
      { type: 'file', data: Buffer.from('%PDF-1.4'), mediaType: 'application/pdf', filename: 'report.pdf' },
    ])
    const restored = hydrateMessages(saved, 's').find((m) => m.role === 'user')!
    expect(restored.contentParts?.filter((p) => p.type !== 'text')).toEqual(attachments)
  })

  it('旧记录只有附件块时，也保留正文中的问题', () => {
    expect(toSdkMessages([{ role: 'user', content: 'question', contentParts: [image] }])[0].content)
      .toEqual(expect.arrayContaining([{ type: 'text', text: 'question' }]))
  })

  it('在请求边界拒绝远程 URL、类型伪装和过量附件', () => {
    expect(() => validateAttachments([{ ...image, data: 'https://example.test/a.png' }])).toThrow(/格式/)
    expect(() => validateAttachments([{ ...file(), mimeType: 'application/pdf' }])).toThrow(/类型/)
    expect(() => validateAttachments(Array(11).fill(image))).toThrow(/10/)
  })
})

describe('ACP 附件能力协商', () => {
  it('纯文本文件不要求图片能力', () => {
    expect(acpPromptContent('question', [file()])).toEqual([
      { type: 'text', text: 'question' }, { type: 'text', text: expect.stringContaining('使用 pnpm') },
    ])
  })
  it('未声明支持时明确拒绝图片/PDF，不静默丢弃', () => {
    expect(() => acpPromptContent('question', [image])).toThrow(/图片支持/)
    expect(() => acpPromptContent('question', [file('application/pdf')])).toThrow(/文件支持/)
  })
  it('重连后传递历史中的附件原始内容', () => {
    const prompt = acpPromptContent('继续', [], [userMessage('看图', [image])], { image: true })
    expect(prompt).toContainEqual({ type: 'image', data: 'YQ==', mimeType: 'image/png' })
    expect(prompt.at(-1)).toEqual({ type: 'text', text: '继续' })
  })
  it('支持嵌入内容时传递 PDF 的 blob 与 MIME', () => {
    expect(acpPromptContent('阅读', [file('application/pdf', '%PDF')], [], { embeddedContext: true }).at(-1))
      .toMatchObject({ type: 'resource', resource: { mimeType: 'application/pdf', blob: Buffer.from('%PDF').toString('base64') } })
  })
})
