import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serialize, deserialize } from 'node:v8'
import { MemorySaver } from '@langchain/langgraph-checkpoint'

// One file per workflow. Persist both checkpoints AND pending writes: a successful
// parallel branch must survive another branch failing in the same superstep.
// This adapter targets the pinned checkpoint 1.2.0 storage format. No native SQLite
// dependency is needed in the packaged Electron application.
export class FileCheckpointer extends MemorySaver {
  constructor(private readonly file: string) {
    super()
    try {
      const data = deserialize(readFileSync(file))
      if (data.version !== 1 || !data.storage || !data.writes) throw new Error('不支持的检查点格式')
      this.storage = data.storage
      this.writes = data.writes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('无法读取工作流进度，原检查点已保留。请重新创建项目任务。', { cause: error })
      }
    }
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, serialize({ version: 1, storage: this.storage, writes: this.writes }), { mode: 0o600, flush: true })
      renameSync(temp, this.file)
    } finally { rmSync(temp, { force: true }) }
  }

  override async put(...args: Parameters<MemorySaver['put']>) {
    const config = await super.put(...args)
    this.persist()
    return config
  }

  override async putWrites(...args: Parameters<MemorySaver['putWrites']>) {
    await super.putWrites(...args)
    this.persist()
  }

  override async deleteThread(threadId: string) {
    await super.deleteThread(threadId)
    if (Object.keys(this.storage).length === 0) rmSync(this.file, { force: true })
    else this.persist()
  }
}
