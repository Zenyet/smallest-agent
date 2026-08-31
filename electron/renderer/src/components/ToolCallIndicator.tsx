import { useState } from 'react'
import { Icon } from './Icon'
import type { ToolCallEvent } from '../../../shared/channels'

// ## 长输出截断
//
// 工具输出能到百万字符级别（实测 directory_tree 扫 node_modules：
// 1000 万字符 / 31 万行）。<pre> 一次性渲染这么大的文本节点会卡顿，
// 而且会撞上 Chromium 光栅化单个图层 16MB 的上限
// （日志里 122 次 "Failed to serialize op in 16777152 bytes"）。
//
// ## 为什么按**字符**截断，而不是按行
//
// 上一版按行切（`lines.slice(0, 200)`），那是错的：`runTool` 用的是
// `JSON.stringify(output)` —— **没有缩进参数**，所以绝大多数工具输出是
// **一整行**。对单行输入按行切完全无效，194 万字符原封不动进了 DOM。
//
// 现在字符数是硬上限，行数只作为辅助（缩进过的 JSON 行数多但每行短，
// 那种情况下先触发行数限制，避免渲染出几千行的高度）。
//
// 参考 Continue.dev 和 ChatGPT 的做法：超阈值只显示开头一段，末尾给
// 「已截断 + 下载完整结果」。虚拟滚动成本高、收益低 —— 工具结果是证据，
// 不是要逐行读的内容；真要排查时下载下来用编辑器看更快。

/** 预览显示多少字符。这是**硬上限**，任何输入都不会超过它。 */
const PREVIEW_CHARS = 4000
/** 预览最多显示多少行。防止缩进过的 JSON 撑出很高的元素。 */
const PREVIEW_LINES = 120

interface TruncateResult {
  preview: string
  truncated: boolean
  totalChars: number
  totalLines: number
}

function truncateOutput(text: string): TruncateResult {
  const totalChars = text.length
  // 只在需要时才 split —— 对百万字符的单行输入，split 本身就有代价，
  // 而没超字符上限的短输出压根不用数行
  const overChars = totalChars > PREVIEW_CHARS

  if (!overChars) {
    const lines = text.split('\n')
    if (lines.length <= PREVIEW_LINES) {
      return { preview: text, truncated: false, totalChars, totalLines: lines.length }
    }
    return {
      preview: lines.slice(0, PREVIEW_LINES).join('\n'),
      truncated: true,
      totalChars,
      totalLines: lines.length,
    }
  }

  // 超了字符上限：先砍字符，再看砍完的这段里行数是否还超
  let preview = text.slice(0, PREVIEW_CHARS)
  const previewLines = preview.split('\n')
  if (previewLines.length > PREVIEW_LINES) {
    preview = previewLines.slice(0, PREVIEW_LINES).join('\n')
  }
  // 总行数只在这里数一次，给提示文案用
  return {
    preview,
    truncated: true,
    totalChars,
    totalLines: text.split('\n').length,
  }
}

function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// 工具失败不走顶层错误事件 —— runTool 把异常包成 {"error": "..."} 返回给模型，
// 所以这里靠解析 output 判断成败。导出给 ToolCallGroup 复用，避免两处维护同一份判断逻辑。
export function isFailed(output: string): boolean {
  try {
    return typeof (JSON.parse(output) as { error?: unknown }).error === 'string'
  } catch {
    return false
  }
}

export function ToolCallIndicator({ event }: { event: ToolCallEvent }) {
  const [open, setOpen] = useState(false)
  const failed = isFailed(event.output)

  return (
    // 语义 class（tool / tool--failed）不带样式，只作测试与调试的锚点；
    // 视觉全部由 Tailwind utility 表达。Step 1 的测试断言 .tool--failed，别删。
    <div
      className={`tool ${failed ? 'tool--failed border-l-[3px] border-red' : ''} mb-1 min-w-0 overflow-hidden rounded-chip bg-surface shadow-hairline`}
    >
      <button
        type="button"
        className="tool__head flex h-7 w-full items-center gap-1.5 px-2 text-left text-[11.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={failed ? 'text-red' : 'text-ink-3'}>
          <Icon name={failed ? 'warn' : 'tool'} size={12} />
        </span>
        <span className="tool__name font-mono text-accent-ink">{event.toolName}</span>
        <span className="ml-auto text-[11px] text-ink-3">第 {event.turn} 轮</span>
        <Icon name="chevron" size={11} className="text-ink-3" rotated={!open} />
      </button>
      {/* 默认折叠：长 JSON 全渲染会拖慢长会话 */}
      {open && (
        <div
          className="min-w-0 px-2 pb-2"
          style={{ animation: 'fade-in-only 140ms ease-out both' }}
        >
          <pre className="mt-1 max-h-[40vh] w-full min-w-0 overflow-auto rounded-chip bg-inset p-2 text-[11px] font-normal text-ink-2 shadow-inset-field">
            {JSON.stringify(event.args, null, 2)}
          </pre>
          <OutputSection output={event.output} toolName={event.toolName} />
        </div>
      )}
    </div>
  )
}

function OutputSection({ output, toolName }: { output: string; toolName: string }) {
  const { preview, truncated, totalChars, totalLines } = truncateOutput(output)

  return (
    <div>
      <pre className="mt-1 max-h-[40vh] w-full min-w-0 overflow-auto rounded-chip bg-inset p-2 text-[11px] font-normal text-ink-2 shadow-inset-field">
        {preview}
      </pre>
      {truncated && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-3">
          <span>
            输出过长，已截断（完整 {totalChars.toLocaleString()} 字符
            {totalLines > 1 && <> / {totalLines.toLocaleString()} 行</>}）
          </span>
          <button
            type="button"
            className="flex h-5 items-center rounded-chip bg-hover px-2 text-accent-ink transition-colors duration-100 hover:bg-hover-2"
            onClick={() => downloadText(output, `${toolName}-output.txt`)}
          >
            下载完整结果
          </button>
        </div>
      )}
    </div>
  )
}
