import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Icon } from './Icon'
import type { ProjectTask } from '../../../shared/project-task'

const LABEL = { running: '进行中', review: '待验收', accepted: '已采用', failed: '未完成', stopped: '已停止' }
const buttonClass = 'inline-flex h-7 items-center gap-1.5 rounded-control px-3 text-[12px] shadow-btn disabled:opacity-50 disabled:cursor-not-allowed'

export function ProjectTaskStarter({ projectName, starting, error, onStart }: {
  projectName?: string
  starting?: boolean
  error?: string
  onStart: () => void
}) {
  return (
    <div className="mx-auto my-auto w-full max-w-[520px] py-12">
      <div className="mb-4 flex size-10 items-center justify-center rounded-[12px] bg-accent-tint text-accent-ink">
        <Icon name="folder" size={22} />
      </div>
      <p className="mb-2 text-[11px] font-medium tracking-wide text-ink-3">从一个具体任务开始</p>
      <h1 className="text-[24px] font-medium leading-tight tracking-tight text-ink">先读懂这个项目</h1>
      <p className="mt-3 max-w-[440px] text-[13px] leading-relaxed text-ink-2">
        阅读项目文件，整理结构、运行方法和核心流程。每个重要结论附上文件依据，方便你继续探索。
      </p>
      <div className="mt-6 rounded-card bg-surface p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[12.5px] text-ink">{projectName ?? '选择一个本地项目'}</span>
          <span className="shrink-0 text-[11px] text-ink-3">只读 · 使用内置 Agent</span>
        </div>
        <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-ink-2">
          {['项目结构', '运行方法', '文件依据'].map((label) => (
            <span key={label} className="inline-flex items-center gap-1.5"><Icon name="doc" size={12} />{label}</span>
          ))}
        </div>
        <button type="button" disabled={starting} onClick={onStart}
          className={`${buttonClass} bg-ink text-surface hover:opacity-90`}>
          {starting ? '正在创建任务…' : projectName ? '理解项目' : '选择项目并开始'}
        </button>
        {error && <p role="alert" className="mt-3 text-[12px] text-red">{error}</p>}
      </div>
      <p className="mt-4 text-[11.5px] text-ink-3">也可以直接在下方提问。</p>
    </div>
  )
}

export function ProjectTaskCard({ task, onAccept, onExport }: {
  task: ProjectTask
  onAccept: () => Promise<unknown>
  onExport: () => Promise<string | null>
}) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const usable = task.status === 'review' || task.status === 'accepted'
  const action = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await run() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return (
    <article aria-label="项目任务成果" className="mb-3 w-full rounded-card bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-[11px] text-ink-3">项目说明 · 只读任务</p>
          <h2 className="truncate text-[15px] font-medium text-ink" title={task.projectPath}>{task.projectName}</h2>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${task.status === 'accepted' ? 'text-green' : task.status === 'failed' ? 'text-red' : 'text-ink-2'}`}>
          <Icon name={task.status === 'accepted' ? 'check' : task.status === 'running' ? 'dot' : 'circle'} size={12} />
          {LABEL[task.status]}
        </span>
      </div>
      <p role="status" className="mt-3 text-[12px] leading-relaxed text-ink-2">
        {task.status === 'running'
          ? task.toolCount ? `已完成 ${task.toolCount} 次工具调用，正在继续整理项目。` : '正在准备读取项目文件…'
          : usable ? `说明已生成，附 ${task.sources.length} 份实际读取的文件片段。请检查内容后采用。` : task.error ?? '本次任务未完成。'}
      </p>
      {task.sources.length > 0 && (
        <details className="mt-3 rounded-control bg-inset px-3 py-2 text-[12px] text-ink-2">
          <summary className="cursor-pointer">查看读取依据 · {task.sources.length} 个文件</summary>
          <p className="mt-2 text-[11px] text-ink-3">以下保留执行时读取的片段；它们不代表所有结论都已经验证。</p>
          {task.sources.map((source) => (
            <details key={source.path} className="mt-2">
              <summary className="cursor-pointer break-all font-mono text-[11.5px] text-accent-ink">{source.path}</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">{source.excerpt || '（空文件）'}</pre>
              {source.truncated && <p className="mt-1 text-[11px] text-ink-3">仅保留前 3,000 个字符。</p>}
            </details>
          ))}
        </details>
      )}
      {task.answer && (
        <details className="mt-3 text-[12px] text-ink-2">
          <summary className="cursor-pointer">{usable ? '查看完整成果' : '查看未完成的输出'}</summary>
          <div className="bubble__text mt-3 text-[13px] leading-relaxed"><ReactMarkdown>{task.answer}</ReactMarkdown></div>
        </details>
      )}
      {usable && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {task.status === 'review' && <button type="button" disabled={busy} className={`${buttonClass} bg-ink text-surface`}
            onClick={() => void action(onAccept)}>采用成果</button>}
          <button type="button" disabled={busy} className={`${buttonClass} bg-surface text-ink`}
            onClick={() => void action(async () => { if (await onExport()) setFeedback('已导出 Markdown') })}>导出 Markdown</button>
          {feedback && <span role="status" className="text-[11.5px] text-green">{feedback}</span>}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-red">{error}</p>}
    </article>
  )
}
