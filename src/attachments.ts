import type { ContentPart, Message } from './types'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const FILE_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'])
const MAX_BYTES = 20 * 1024 * 1024

/** Only embedded data is accepted; a renderer cannot turn an attachment into a URL fetch. */
export function attachmentData(part: Exclude<ContentPart, { type: 'text' }>) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(part.data)
  if (!match || match[2].length % 4 !== 0) throw new Error('附件数据格式无效，请重新添加文件')
  return { mimeType: match[1], base64: match[2], bytes: Buffer.from(match[2], 'base64') }
}

export function validateAttachments(raw: unknown): ContentPart[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 10) throw new Error('每条消息最多添加 10 个附件')
  let total = 0
  return raw.map((value): ContentPart => {
    if (!value || typeof value !== 'object' || !['image', 'file'].includes(value.type) ||
        typeof value.data !== 'string' || (value.type === 'file' && typeof value.filename !== 'string') ||
        (value.filename !== undefined && typeof value.filename !== 'string')) {
      throw new Error('附件格式无效，请重新添加文件')
    }
    if (value.data.length > Math.ceil(MAX_BYTES / 3) * 4 + 100) throw new Error('单个附件不能超过 20MB')
    const data = attachmentData(value)
    if (data.bytes.length > MAX_BYTES) throw new Error('单个附件不能超过 20MB')
    total += data.bytes.length
    if (total > 40 * 1024 * 1024) throw new Error('附件总大小不能超过 40MB')
    if (value.type === 'image') {
      if (!IMAGE_TYPES.has(data.mimeType)) throw new Error('不支持的图片类型')
      return { type: 'image', data: value.data, filename: value.filename ?? '图片', detail: 'auto' }
    }
    if (!FILE_TYPES.has(data.mimeType) || value.mimeType !== data.mimeType) throw new Error('不支持的文件类型')
    return { type: 'file', data: value.data, mimeType: data.mimeType, filename: value.filename }
  })
}

export function userMessage(text: string, attachments?: ContentPart[], timestamp = Date.now()): Message {
  return {
    role: 'user', content: text, timestamp,
    ...(attachments?.length ? { contentParts: [{ type: 'text' as const, text }, ...attachments] } : {}),
  }
}

export function isTextAttachment(part: ContentPart): boolean {
  return part.type === 'file' && (part.mimeType.startsWith('text/') || part.mimeType === 'application/json')
}

export function textAttachment(part: Extract<ContentPart, { type: 'file' }>): string {
  return `附件：${part.filename}\n以下是用户提供的文件资料：\n${attachmentData(part).bytes.toString('utf8')}`
}
