import { useRef } from 'react'
import { Icon } from './Icon'
import type { ContentPart } from '../../../../src/types'

// 附件入口拆成两个导出，因为它们在 composer 里的位置不同：
//   • AttachmentButton —— 底部控件行左端，和模型/权限选择器并列
//   • AttachmentStrip  —— 输入框**上方**独立一条
//
// 不把预览也塞进控件行：缩略图有 56px 高，那一行现在是 h-7（28px）的
// 选择器，塞进去会把整行撑到两倍高，模型名和权限那几个 chip 跟着往下掉。
// 附件是「这条消息的一部分」，放在文字上面读起来也更顺 —— 先看到带了什么，
// 再看到说了什么。

// 图片能进 image_url，其余走 file。两份清单分开是因为它们在
// toSdkMessages 里翻译成不同形状（见 src/llm.ts）。
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const FILE_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]
const ACCEPTED_TYPES = [...IMAGE_TYPES, ...FILE_TYPES]

/** 单个附件的上限。超了整条不加 —— base64 会再胀三分之一。 */
const MAX_BYTES = 20 * 1024 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 收一批 File：逐个验类型和体积，过了的读成 data URI 交给 onAdd。
 *
 * ## 为什么抽成独立函数
 *
 * 文件有两条进来的路 —— 点按钮选，和拖进来。两边必须走**同一份**校验，
 * 各写一份的话迟早分叉（典型症状：拖进来的能收 30MB 的图，选进来的不能，
 * 而用户完全看不出这两件事凭什么不一样）。
 *
 * 逐个 await 而不是 Promise.all：多选时顺序要和用户选的一致，
 * 并发读完的到达顺序取决于文件大小。
 */
export async function acceptFiles(
  files: File[],
  onAdd: (attachment: ContentPart) => void,
  onReject?: (reason: string) => void,
): Promise<void> {
  for (const file of files) {
    // 拖进来的目录在各平台上 type 都是空串，size 也不可靠 ——
    // 走类型白名单自然就挡掉了，不需要单独判断
    if (!ACCEPTED_TYPES.includes(file.type)) {
      onReject?.(`不支持的类型：${file.name}`)
      continue
    }
    if (file.size > MAX_BYTES) {
      onReject?.(`${file.name} 超过 20MB`)
      continue
    }
    try {
      const data = await readAsDataUrl(file)
      onAdd(
        IMAGE_TYPES.includes(file.type)
          ? { type: 'image', data, filename: file.name, detail: 'auto' }
          : { type: 'file', data, mimeType: file.type, filename: file.name },
      )
    } catch {
      onReject?.(`读不出 ${file.name}`)
    }
  }
}

export function AttachmentButton({
  onAdd,
  onReject,
  disabled,
}: {
  onAdd: (attachment: ContentPart) => void
  /** 类型不认或体积超限时报给调用方显示 —— 这个组件不自己弹 alert。 */
  onReject?: (reason: string) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    // 先清空 value 再读：选同一个文件两次时 change 不会触发（value 没变）。
    // 放在 await 之前，因为 await 之后 e.target 可能已经被 React 回收。
    e.target.value = ''
    await acceptFiles(files, onAdd, onReject)
  }

  return (
    <>
      <button
        type="button"
        aria-label="添加附件"
        title="添加图片或文件"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 enabled:hover:bg-hover enabled:hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon name="plus" size={14} />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        multiple
        className="hidden"
        onChange={handleChange}
      />
    </>
  )
}

export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: ContentPart[]
  onRemove: (index: number) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div className="attachment-strip flex flex-wrap gap-1.5 px-1 pb-1">
      {attachments.map((att, i) => (
        <AttachmentCard key={i} attachment={att} onRemove={() => onRemove(i)} />
      ))}
    </div>
  )
}

function AttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: ContentPart
  onRemove: () => void
}) {
  if (attachment.type === 'text') return null

  const label = attachment.type === 'image' ? attachment.filename ?? '图片' : attachment.filename

  // 删除键常显，不做 hover 才出现：composer 里这几张卡片本来就小，
  // 藏起来的话用户得先划过去才知道能删（触摸板上尤其别扭）。
  const removeButton = (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`移除 ${label}`}
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-page/80 text-ink-2 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
    >
      <Icon name="close" size={9} strokeWidth={2.6} />
    </button>
  )

  if (attachment.type === 'image') {
    return (
      <div className="attachment-card relative size-14 overflow-hidden rounded-chip bg-inset shadow-hairline">
        {/* data URI 直接进 src：图片已经在内存里了，再包一层 blob URL
            还要管 revoke。CSP 的 img-src 得带 data:（见 index.html）。 */}
        <img src={attachment.data} alt={label} className="size-full object-cover" />
        <span className="absolute top-0.5 right-0.5">{removeButton}</span>
      </div>
    )
  }

  return (
    <div className="attachment-card flex h-14 items-center gap-1.5 rounded-chip bg-inset px-2 shadow-hairline">
      <Icon name="file" size={14} className="shrink-0 text-ink-3" />
      {/* max-w + truncate 而不是让它自己撑开：一个长文件名能把整条
          撑出输入框的宽度，后面的卡片就被挤到下一行去了 */}
      <span className="max-w-[110px] truncate text-[11.5px] text-ink-2" title={label}>
        {label}
      </span>
      {removeButton}
    </div>
  )
}
