import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Icon } from './Icon'
import { ANALYSIS_LABELS, type ProjectTask, type WorkflowStage } from '../../../shared/project-task'

const LABEL = { running: '进行中', review: '待验收', accepted: '已采用', failed: '未完成', stopped: '已停止' }
const buttonClass = 'inline-flex h-7 items-center gap-1.5 rounded-control px-3 text-[12px] shadow-btn disabled:opacity-50 disabled:cursor-not-allowed'
const STAGES: { id: WorkflowStage; label: string }[] = [
  { id: 'scan', label: '扫描文件' }, { id: 'analyze', label: '并行分析' },
  { id: 'summarize', label: '汇总报告' }, { id: 'review', label: '人工验收' },
]
const STAGE_DETAIL: Record<WorkflowStage, string> = {
  scan: '正在扫描项目文件，准备分析依据…',
  analyze: '正在分别分析项目结构、运行方法和待确认项…',
  summarize: '三个方向的分析已完成，正在汇总报告…',
  review: '报告已生成，等待你检查文件依据并验收。',
  done: '这份项目报告已由你验收采用。',
}

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
        扫描项目文件，并行分析结构、运行方式与待确认项，汇总成有文件依据的报告，由你检查后采用。
      </p>
      <div className="mt-6 rounded-card bg-surface p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-[12.5px] text-ink">{projectName ?? '选择一个本地项目'}</span>
          <span className="shrink-0 text-[11px] text-ink-3">只读 · 进度保存在本地</span>
        </div>
        <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-ink-2">
          {['分阶段分析', '中断后继续', '人工验收'].map((label) => (
            <span key={label} className="inline-flex items-center gap-1.5"><Icon name="doc" size={12} />{label}</span>
          ))}
        </div>
        <button type="button" disabled={starting} onClick={onStart}
          className={`${buttonClass} bg-ink text-surface hover:opacity-90`}>
          {starting ? '正在创建任务…' : projectName ? '理解项目' : '选择项目并开始'}
        </button>
        {error && <p role="alert" className="mt-3 text-[12px] text-red">{error}</p>}
      </div>
      <p className="mt-4 text-[11.5px] leading-relaxed text-ink-3">使用设置中的模型分析文件片段，通常调用 4 次模型。也可以直接在下方提问。</p>
    </div>
  )
}

export function ProjectTaskCard({ task, onAccept, onExport, onResume, onStop }: {
  task: ProjectTask
  onAccept: () => Promise<unknown>
  onExport: () => Promise<string | null>
  onResume?: () => Promise<unknown>
  onStop?: () => Promise<unknown>
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
          ? task.workflow ? STAGE_DETAIL[task.workflow.stage] : task.toolCount ? `已完成 ${task.toolCount} 次工具调用，正在继续整理项目。` : '正在准备读取项目文件…'
          : task.status === 'accepted' ? '这份项目报告已由你验收采用。' : usable ? `说明已生成，附 ${task.sources.length} 份实际读取的文件片段。请检查内容后采用。` : task.error ?? '本次任务未完成。'}
      </p>
      {task.workflow && (
        <div className="mt-4 rounded-control bg-inset p-3">
          <ol aria-label="项目分析进度" className="flex flex-wrap gap-x-5 gap-y-3 text-[12px]">
            {STAGES.map((step, index) => {
              const active = task.workflow!.stage === step.id
              const complete = task.workflow!.stage === 'done' || index < STAGES.findIndex((s) => s.id === task.workflow!.stage)
              return <li key={step.id} aria-current={active ? 'step' : undefined}
                className={`inline-flex items-center gap-1.5 ${complete ? 'text-green' : active ? 'text-accent-ink' : 'text-ink-3'}`}>
                <Icon name={complete ? 'check' : active ? 'dot' : 'circle'} size={12} />{step.label}
              </li>
            })}
          </ol>
          {task.workflow.stage !== 'scan' && <ul aria-label="分析分支" className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[11.5px] text-ink-2">
            {Object.entries(ANALYSIS_LABELS).map(([key, label]) => <li key={key}>
              {label} · {task.workflow!.completed.includes(key as keyof typeof ANALYSIS_LABELS) ? '已完成' : '待完成'}
            </li>)}
          </ul>}
          {task.workflow.scannedAt && <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
            文件快照：{new Date(task.workflow.scannedAt).toLocaleString()}。继续分析会沿用这份快照；查看最新代码请新建项目任务。
          </p>}
          {task.workflow.scanNote && <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{task.workflow.scanNote}</p>}
        </div>
      )}
      {task.sources.length > 0 && (
        <details className="mt-3 rounded-control bg-inset px-3 py-2 text-[12px] text-ink-2">
          <summary className="cursor-pointer">查看读取依据 · {task.sources.length} 个文件</summary>
          <p className="mt-2 text-[11px] text-ink-3">以下保留执行时读取的片段；它们不代表所有结论都已经验证。</p>
          {task.sources.map((source) => (
            <details key={source.path} className="mt-2">
              <summary className="cursor-pointer break-all font-mono text-[11.5px] text-accent-ink">{source.path}</summary>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">{source.excerpt || '（空文件）'}</pre>
              {source.truncated && <p className="mt-1 text-[11px] text-ink-3">文件内容已截断，仅保留开头片段。</p>}
            </details>
          ))}
        </details>
      )}
      {task.workflow && <div className="mt-4 flex flex-wrap gap-2">
        {task.status === 'running' && onStop && <button type="button" disabled={busy}
          className={`${buttonClass} bg-surface text-ink`} onClick={() => void action(onStop)}>停止并保存进度</button>}
        {['stopped', 'failed'].includes(task.status) && onResume && <button type="button" disabled={busy}
          className={`${buttonClass} bg-ink text-surface`} onClick={() => void action(onResume)}>继续分析</button>}
      </div>}
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
