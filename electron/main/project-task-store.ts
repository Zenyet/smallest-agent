import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolCallEvent } from '../shared/channels'
import { type ProjectTask, type ProjectTaskChanged, type ProjectWorkflowProgress } from '../shared/project-task'
import type { Project } from './projects'

const taskSchema = z.object({
  id: z.string(), sessionId: z.string(), projectId: z.string(), projectPath: z.string(), projectName: z.string(),
  prompt: z.string(), status: z.enum(['running', 'review', 'accepted', 'failed', 'stopped']),
  createdAt: z.number(), updatedAt: z.number(), revision: z.number(), toolCount: z.number(),
  sources: z.array(z.object({ path: z.string(), excerpt: z.string(), truncated: z.boolean() })),
  answer: z.string().optional(), error: z.string().optional(),
  workflow: z.object({
    version: z.literal(1), stage: z.enum(['scan', 'analyze', 'summarize', 'review', 'done']),
    completed: z.array(z.enum(['architecture', 'operation', 'risks'])),
    scannedAt: z.number().optional(), fileCount: z.number().optional(), scanNote: z.string().optional(),
    reportSaved: z.boolean().optional(),
  }).optional(),
})

function readSource(task: ProjectTask, event: ToolCallEvent): ProjectTask['sources'][number] | null {
  if (!['read_file', 'read_text_file'].includes(event.toolName) || typeof event.args.path !== 'string') return null
  const path = relative(task.projectPath, resolve(task.projectPath, event.args.path))
  if (!path || path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path)) return null
  let output: unknown
  try { output = JSON.parse(event.output) } catch { return null }
  // runTool 的成功文本是 JSON string；错误是 {error: ...}，不能当作文件证据。
  if (typeof output !== 'string' || /^Error:/i.test(output)) return null
  return { path, excerpt: output.slice(0, 3000), truncated: output.length > 3000 }
}

export function createProjectTaskStore(file: string, changed: (event: ProjectTaskChanged) => void = () => {}) {
  let records: Record<string, ProjectTask> = {}
  let loadError: Error | undefined
  const save = (next: Record<string, ProjectTask>) => {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(temp, file)
    records = next
  }
  try {
    records = z.record(z.string(), taskSchema).parse(JSON.parse(readFileSync(file, 'utf8')))
    let interrupted = false
    for (const task of Object.values(records)) {
      if (task.status === 'running') {
        task.status = 'stopped'
        task.error = task.workflow ? '上次运行被中断，已保存进度。点击继续分析，复用已完成的步骤。' : '上次运行被中断，已保留读取记录。可以重新开始。'
        task.updatedAt = Date.now()
        task.revision += 1
        interrupted = true
      }
    }
    if (interrupted) save(records)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadError = new Error('无法读取任务记录，请检查本地 tasks.json；原文件未被覆盖。', { cause: err })
    }
  }
  const check = () => { if (loadError) throw loadError }
  const put = (task: ProjectTask) => {
    check()
    const next = { ...task, updatedAt: Date.now(), revision: task.revision + 1 }
    save({ ...records, [task.sessionId]: next })
    changed({ sessionId: task.sessionId, task: structuredClone(next) })
    return structuredClone(next)
  }
  const get = (sessionId: string) => {
    check()
    return records[sessionId] ? structuredClone(records[sessionId]) : null
  }
  return {
    get,
    create(sessionId: string, project: Project, workflow = false): ProjectTask {
      check()
      if (records[sessionId]) throw new Error('这个会话已经有项目任务')
      return put({ id: randomUUID(), sessionId, projectId: project.id, projectPath: project.dir,
        projectName: project.name, prompt: `理解项目「${project.name}」，生成有文件依据的项目说明。`, status: 'running',
        createdAt: Date.now(), updatedAt: Date.now(), revision: 0, toolCount: 0, sources: [],
        ...(workflow ? { workflow: { version: 1, stage: 'scan', completed: [] } as ProjectWorkflowProgress } : {}) })
    },
    resume(sessionId: string) {
      const task = get(sessionId)
      if (!task?.workflow || task.status === 'accepted') throw new Error('这个任务不支持恢复')
      return put({ ...task, status: 'running', error: undefined })
    },
    progress(sessionId: string, workflow: ProjectWorkflowProgress, sources?: ProjectTask['sources']) {
      const task = get(sessionId)
      if (!task || task.status !== 'running') return
      return put({ ...task, workflow, ...(sources ? { sources, toolCount: sources.length } : {}) })
    },
    tool(event: ToolCallEvent) {
      const task = get(event.sessionId)
      if (!task || task.status !== 'running') return
      const source = readSource(task, event)
      const sources = source
        ? [...task.sources.filter((s) => s.path !== source.path), source].slice(-32)
        : task.sources
      put({ ...task, toolCount: task.toolCount + 1, sources })
    },
    finish(sessionId: string, answer: string) {
      const task = get(sessionId)
      if (!task || task.status !== 'running') return
      const valid = answer.trim().length > 0 && task.sources.length > 0
      put({ ...task, answer, status: valid ? 'review' : 'failed',
        ...(!valid ? { error: '没有取得项目文件依据，尚未生成可验收的说明。请检查文件工具后重新开始。' } : {}) })
    },
    stop(sessionId: string, status: 'failed' | 'stopped', error?: string) {
      const task = get(sessionId)
      if (task?.status === 'running') put({ ...task, status, error })
    },
    accept(sessionId: string) {
      const task = get(sessionId)
      if (!task || !['review', 'accepted'].includes(task.status)) throw new Error('任务尚未生成可采用的成果')
      return task.status === 'accepted' ? task : put({ ...task, status: 'accepted',
        ...(task.workflow ? { workflow: { ...task.workflow, stage: 'done' } } : {}) })
    },
    remove(sessionId: string) {
      check()
      const next = { ...records }
      delete next[sessionId]
      save(next)
      changed({ sessionId, task: null })
    },
  }
}

export function projectTaskMarkdown(task: ProjectTask): string {
  if (!task.answer || !['review', 'accepted'].includes(task.status)) throw new Error('尚无可导出的成果')
  return `# ${task.projectName} · 项目说明\n\n${task.answer}\n\n---\n\n实际读取的文件（不等于逐条结论均已验证）：\n\n${task.sources.map((s) => `- ${s.path}`).join('\n')}\n`
}
