import type { ContentBlock, PromptCapabilities } from '@agentclientprotocol/sdk'
import { attachmentData, isTextAttachment, textAttachment } from '../../../src/attachments'
import type { ContentPart, Message } from '../../../src/types'

function blocks(parts: ContentPart[], capabilities: PromptCapabilities): ContentBlock[] {
  return parts.map((part): ContentBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'file' && isTextAttachment(part)) return { type: 'text', text: textAttachment(part) }
    const data = attachmentData(part)
    if (part.type === 'image') {
      if (!capabilities.image) throw new Error('当前外部引擎未声明图片支持，请移除图片或切换引擎')
      return { type: 'image', data: data.base64, mimeType: data.mimeType }
    }
    if (!capabilities.embeddedContext) throw new Error('当前外部引擎未声明文件支持，请移除 PDF 或切换引擎')
    return {
      type: 'resource',
      resource: { uri: `attachment:///${encodeURIComponent(part.filename)}`, mimeType: data.mimeType, blob: data.base64 },
    }
  })
}

/** Reconnection replays attachment content too; a filename alone is not the original input. */
export function acpPromptContent(
  question: string,
  attachments: ContentPart[] = [],
  history: Message[] = [],
  capabilities: PromptCapabilities = {},
): ContentBlock[] {
  const result: ContentBlock[] = []
  if (history.length) result.push({ type: 'text', text: '以下是之前的对话记录，供你参考：' })
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    result.push({ type: 'text', text: `${message.role === 'user' ? '用户' : '助手'}：${message.content}` })
    result.push(...blocks(message.contentParts?.filter((p) => p.type !== 'text') ?? [], capabilities))
  }
  result.push({ type: 'text', text: question }, ...blocks(attachments, capabilities))
  return result
}
