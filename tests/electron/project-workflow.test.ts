import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config'
import type { CallModel } from '../../src/types'
import { createProjectTaskStore } from '../../electron/main/project-task-store'
import { createProjectWorkflowRunner } from '../../electron/main/workflows/project-analysis'
import { scanProject } from '../../electron/main/workflows/project-scan'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const result = (text: string) => ({ text, toolCalls: [] })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'project-workflow-'))
  dirs.push(dir)
  const root = join(dir, 'project')
  mkdirSync(root)
  writeFileSync(join(root, 'README.md'), '# Sample\nRun: pnpm dev\nTest: pnpm test')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample', scripts: { dev: 'tsx cli.ts', test: 'vitest' } }))
  const tasksFile = join(dir, 'tasks.json')
  const tasks = createProjectTaskStore(tasksFile)
  const project = { id: 'p', name: 'sample', dir: root, createdAt: 1 }
  const task = tasks.create('session', project, true)
  const model = vi.fn<CallModel>(async (messages) => result(`分析完成，依据 README.md。${messages[1].content.slice(0, 30)}`))
  const scan = vi.fn(scanProject)
  const onReport = vi.fn(async () => {})
  const config = loadConfig({ DEEPSEEK_API_KEY: 'test-secret', MAX_RETRIES: '0' })
  const make = (store = tasks, callModel: CallModel = model) => createProjectWorkflowRunner({
    tasks: store, checkpointDir: join(dir, 'checkpoints'), loadConfig: () => config,
    makeCallModel: (config) => {
      expect(config.nativeSearch).toBeUndefined()
      expect(config.stream).toBe(false)
      return callModel
    },
    scan, onReport,
  })
  return { dir, root, tasksFile, tasks, task, model, scan, onReport, make, config }
}

describe('真实 LangGraph 项目分析工作流', () => {
  it('并行执行三个分析，汇总后等待人工验收；重建实例后验收不调用模型', async () => {
    const s = setup()
    let concurrent = 0
    let peak = 0
    s.model.mockImplementation(async (messages) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 10))
      concurrent--
      return result(`已分析，见 README.md。${messages[1].content.slice(0, 20)}`)
    })
    const runner = s.make()
    runner.start('session')
    await runner.settled('session')
    expect(s.tasks.get('session')?.error).toBeUndefined()
    expect(s.tasks.get('session')?.status).toBe('review')
    expect(s.tasks.get('session')?.workflow?.completed).toHaveLength(3)
    expect(s.tasks.get('session')?.workflow?.stage).toBe('review')
    expect(s.model).toHaveBeenCalledTimes(4)
    expect(peak).toBe(3)
    expect(s.scan).toHaveBeenCalledOnce()
    const checkpoint = readFileSync(join(s.dir, 'checkpoints', readdirSync(join(s.dir, 'checkpoints'))[0]))
    expect(checkpoint.includes(Buffer.from('test-secret'))).toBe(false)
    const restored = createProjectTaskStore(s.tasksFile)
    const noModel = vi.fn<CallModel>(async () => { throw new Error('验收不应调用模型') })
    const afterRestart = createProjectWorkflowRunner({
      tasks: restored, checkpointDir: join(s.dir, 'checkpoints'),
      loadConfig: () => { throw new Error('验收不需要凭据') }, makeCallModel: () => noModel, onReport: s.onReport,
    })
    const accepted = await afterRestart.accept('session')
    expect(accepted.status).toBe('accepted')
    expect(accepted.workflow?.stage).toBe('done')
    expect(noModel).not.toHaveBeenCalled()
    expect(s.onReport).toHaveBeenCalledOnce()
    await afterRestart.accept('session')
    expect(restored.get('session')?.status).toBe('accepted')
  })

  it('一个分支失败后，从磁盘恢复只重跑失败分支，不重读已经变化的文件', async () => {
    const s = setup()
    s.model.mockImplementation(async (messages) => {
      if (messages[1].content.startsWith('分析方向：风险')) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        throw new Error('模拟网络中断')
      }
      return result('已完成，见 README.md。')
    })
    const runner = s.make()
    runner.start('session')
    await runner.settled('session')
    expect(s.tasks.get('session')?.status).toBe('failed')
    expect(s.model).toHaveBeenCalledTimes(3)
    writeFileSync(join(s.root, 'README.md'), 'CHANGED AFTER SCAN')
    const restored = createProjectTaskStore(s.tasksFile)
    const resumedModel = vi.fn<CallModel>(async (messages) => {
      expect(messages[1].content).not.toContain('CHANGED AFTER SCAN')
      return result('恢复完成，依据 README.md。')
    })
    const resumed = s.make(restored, resumedModel)
    resumed.resume('session')
    await resumed.settled('session')
    expect(restored.get('session')?.error).toBeUndefined()
    expect(restored.get('session')?.status).toBe('review')
    expect(resumedModel).toHaveBeenCalledTimes(2)
    expect(resumedModel.mock.calls[0][0][1].content).toContain('分析方向：风险')
    expect(s.scan).toHaveBeenCalledOnce()
  })

  it('停止会中断模型请求，防止重复启动，并且可在新实例继续', async () => {
    const s = setup()
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    s.model.mockImplementation(async (_messages, signal) => {
      signalStarted()
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('aborted'))
        else signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return result('不应到达')
    })
    const runner = s.make()
    runner.start('session')
    await started
    expect(() => runner.start('session')).toThrow(/正在执行/)
    expect(runner.cancel('session')).toBe(true)
    await runner.settled('session')
    expect(s.tasks.get('session')?.status).toBe('stopped')
    expect(s.onReport).not.toHaveBeenCalled()
    const restored = createProjectTaskStore(s.tasksFile)
    const resumedModel = vi.fn<CallModel>(async () => result('恢复后的报告，见 README.md。'))
    const resumed = s.make(restored, resumedModel)
    resumed.resume('session')
    await resumed.settled('session')
    expect(restored.get('session')?.status).toBe('review')
    expect(s.scan).toHaveBeenCalledOnce()
  })

  it('损坏的检查点不被覆盖；删除任务清除检查点', async () => {
    const s = setup()
    const runner = s.make()
    runner.start('session')
    await runner.settled('session')
    const file = join(s.dir, 'checkpoints', readdirSync(join(s.dir, 'checkpoints'))[0])
    writeFileSync(file, 'broken checkpoint')
    await expect(s.make().accept('session')).rejects.toThrow(/无法读取工作流进度/)
    expect(readFileSync(file, 'utf8')).toBe('broken checkpoint')
    await runner.remove(s.task)
    expect(readdirSync(join(s.dir, 'checkpoints'))).toEqual([])
  })

  it('空白输出不能成为可采用成果，验收失败不会变成已采用', async () => {
    const s = setup()
    s.model.mockResolvedValue(result(''))
    const runner = s.make()
    runner.start('session')
    await runner.settled('session')
    expect(s.tasks.get('session')?.status).toBe('failed')
    await expect(runner.accept('session')).rejects.toThrow()
  })

  it('报告落盘失败后恢复，不再调用模型', async () => {
    const s = setup()
    s.onReport.mockRejectedValueOnce(new Error('模拟会话写入失败'))
    const runner = s.make()
    runner.start('session')
    await runner.settled('session')
    expect(s.tasks.get('session')?.status).toBe('failed')
    expect(s.model).toHaveBeenCalledTimes(4)
    const restored = createProjectTaskStore(s.tasksFile)
    const resumed = s.make(restored)
    resumed.resume('session')
    await resumed.settled('session')
    expect(restored.get('session')?.status).toBe('review')
    expect(s.model).toHaveBeenCalledTimes(4)
  })

  it('删除运行中的任务后，迟到的模型结果不能重新创建检查点', async () => {
    const s = setup()
    let notify!: () => void
    const started = new Promise<void>((resolve) => { notify = resolve })
    s.model.mockImplementation(async () => {
      notify()
      // Simulate a provider that does not promptly honor AbortSignal.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return result('迟到的答案')
    })
    const runner = s.make()
    runner.start('session')
    await started
    await runner.remove(s.task)
    s.tasks.remove('session')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(s.tasks.get('session')).toBeNull()
    expect(readdirSync(join(s.dir, 'checkpoints'))).toEqual([])
    expect(s.onReport).not.toHaveBeenCalled()
  })
})

describe('只读项目扫描', () => {
  it('排除密钥、依赖、符号链接和二进制，限制扫描内容', async () => {
    const s = setup()
    mkdirSync(join(s.root, 'node_modules'))
    writeFileSync(join(s.root, 'node_modules', 'dependency.ts'), 'DEPENDENCY')
    writeFileSync(join(s.root, '.env'), 'KEY=secret')
    writeFileSync(join(s.root, 'credentials.json'), '{"key":"secret"}')
    writeFileSync(join(s.root, 'secret.config.json'), 'SECRET CONFIG')
    writeFileSync(join(s.root, 'binary.txt'), Buffer.from([0, 1, 2]))
    writeFileSync(join(s.root, 'large.ts'), 'x'.repeat(200000))
    writeFileSync(join(s.dir, 'outside.md'), 'OUTSIDE')
    symlinkSync(join(s.dir, 'outside.md'), join(s.root, 'linked.md'))
    const before = readFileSync(join(s.root, 'README.md'), 'utf8')
    const scan = await scanProject(s.root)
    expect(scan.sources.map((source) => source.path).sort()).toEqual(['README.md', 'large.ts', 'package.json'])
    expect(scan.sources.find((source) => source.path === 'large.ts')?.truncated).toBe(true)
    expect(scan.sources.every((source) => source.excerpt.length <= 3000)).toBe(true)
    expect(scan.sources.reduce((sum, source) => sum + source.excerpt.length, 0)).toBeLessThanOrEqual(24000)
    expect(readFileSync(join(s.root, 'README.md'), 'utf8')).toBe(before)
  })

  it('已取消的扫描不读取文件', async () => {
    const s = setup()
    await expect(scanProject(s.root, AbortSignal.abort())).rejects.toThrow()
  })

  it('遵守根目录与子目录的 gitignore 规则', async () => {
    const s = setup()
    writeFileSync(join(s.root, '.gitignore'), 'local-config.json\nignored/\n')
    writeFileSync(join(s.root, 'local-config.json'), 'PRIVATE CONFIG')
    mkdirSync(join(s.root, 'ignored'))
    writeFileSync(join(s.root, 'ignored', 'main.ts'), 'IGNORE ME')
    mkdirSync(join(s.root, 'src'))
    writeFileSync(join(s.root, 'src', '.gitignore'), '*.json\n!public.json\n')
    writeFileSync(join(s.root, 'src', 'local.json'), 'PRIVATE LOCAL')
    writeFileSync(join(s.root, 'src', 'public.json'), '{}')
    const scan = await scanProject(s.root)
    expect(scan.sources.map((source) => source.path).sort()).toEqual(['README.md', 'package.json', 'src/public.json'])
  })
})
