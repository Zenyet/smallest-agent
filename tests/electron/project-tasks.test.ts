import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectTaskStore, projectTaskMarkdown } from '../../electron/main/project-task-store'
import { createAgentRunner, type AgentEmitter } from '../../electron/main/agent-runner'
import { createApprovalGate } from '../../electron/main/approval'
import { createJsonSessionStore } from '../../src/memory/store'
import { runAgent } from '../../src/agent'
import { loadConfig } from '../../src/config'
import type { ProjectTaskChanged } from '../../electron/shared/project-task'
import type { ToolRegistry } from '../../src/types'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'project-task-test-'))
  dirs.push(dir)
  const file = join(dir, 'tasks.json')
  const events: ProjectTaskChanged[] = []
  const store = createProjectTaskStore(file, (e) => events.push(e))
  const project = { id: 'p1', name: 'sample', dir: join(dir, 'project'), createdAt: 1 }
  return { dir, file, store, project, events }
}
const readEvent = (root: string, output = JSON.stringify('# Project')) => ({
  sessionId: 's1', turn: 1, toolName: 'read_file', args: { path: join(root, 'README.md') }, output,
})

describe('项目成果的生命周期', () => {
  it('读取依据、待验收、采用、导出与重载形成闭环', () => {
    const { store, project, file } = setup()
    store.create('s1', project)
    store.tool(readEvent(project.dir))
    store.finish('s1', '项目入口见 README.md。')
    expect(store.get('s1')?.status).toBe('review')
    const accepted = store.accept('s1')
    expect(accepted.status).toBe('accepted')
    expect(projectTaskMarkdown(accepted)).toContain('- README.md')
    const reloaded = createProjectTaskStore(file).get('s1')!
    expect(reloaded.status).toBe('accepted')
    expect(reloaded.sources[0]).toEqual({ path: 'README.md', excerpt: '# Project', truncated: false })
    expect(reloaded.answer).toBe(accepted.answer)
  })

  it('错误输出和项目外路径不能冒充依据，无依据不能采用或导出', () => {
    const { store, project } = setup()
    store.create('s1', project)
    store.tool(readEvent(project.dir, JSON.stringify({ error: 'not found' })))
    store.tool({ ...readEvent(project.dir), args: { path: '../outside.md' } })
    store.finish('s1', '猜测的说明')
    expect(store.get('s1')?.sources).toEqual([])
    expect(store.get('s1')?.status).toBe('failed')
    expect(() => store.accept('s1')).toThrow()
    expect(() => projectTaskMarkdown(store.get('s1')!)).toThrow()
  })

  it('中断后迟到的完成事件不能把任务重新变成成功', () => {
    const { store, project } = setup()
    store.create('s1', project)
    store.tool(readEvent(project.dir))
    store.stop('s1', 'stopped', '用户停止')
    store.finish('s1', '迟到的答案')
    expect(store.get('s1')?.status).toBe('stopped')
    expect(store.get('s1')?.answer).toBeUndefined()
  })

  it('进程重启后运行中记录变成中断，并保留已经读取的片段', () => {
    const { store, project, file } = setup()
    store.create('s1', project)
    store.tool(readEvent(project.dir))
    const restored = createProjectTaskStore(file)
    expect(restored.get('s1')?.status).toBe('stopped')
    expect(restored.get('s1')?.sources).toHaveLength(1)
    restored.remove('s1')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })
})

it('真实 Runner 使用只读工具生成成果、持久化对话，忽略外部引擎与写入预设', async () => {
  const { store, project, dir } = setup()
  store.create('s1', project)
  const sessions = createJsonSessionStore(join(dir, 'sessions'))
  const external = vi.fn()
  const write = vi.fn(async () => 'written')
  const read = { name: 'read_file', description: 'read', parameters: {}, run: async () => '# Project\nRun: pnpm test' }
  const fs: ToolRegistry = { read_file: read, write_file: { ...read, name: 'write_file', run: write } }
  let calls = 0
  const emit: AgentEmitter = {
    chunk: () => {}, toolCall: (event) => store.tool(event), complete: (event) => store.finish(event.sessionId, event.text),
    error: (event) => store.stop(event.sessionId, 'failed', event.message), cancelled: (event) => store.stop(event.sessionId, 'stopped'),
    verdict: () => {}, cacheHit: () => {}, approvalRequest: () => { throw new Error('不应请求写入') },
  }
  const runner = createAgentRunner({
    loadConfig: () => loadConfig({ DEEPSEEK_API_KEY: 'test', SESSIONS_DIR: join(dir, 'sessions') }),
    makeSessionStore: () => sessions, gate: createApprovalGate(), registry: { write_file: fs.write_file }, emit,
    runAgent, makeSummarize: () => async () => 'summary', verify: async () => ({ grounded: true, issues: [] }),
    resolveProvider: external, resolveCwd: () => project.dir, resolvePermission: () => 'auto',
    resolveAgent: () => ({ id: 'writer', name: 'writer', tools: ['write_file'] }),
    fsPool: { forDir: async () => fs, disposeAll: async () => {} },
    buildCallModel: (config, tools) => {
      expect(Object.keys(tools)).toEqual(['read_file'])
      expect(config.nativeSearch).toBeUndefined()
      return async () => ++calls === 1
        ? { text: '', toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: join(project.dir, 'README.md') } }] }
        : { text: '运行方法：pnpm test（未执行，来源 README.md）。', toolCalls: [] }
    },
  })
  await runner.run('s1', '理解项目', undefined, { projectOverview: true })
  expect(store.get('s1')?.status).toBe('review')
  expect((await sessions.load('s1')).at(-1)?.content).toContain('README.md')
  expect(external).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})
