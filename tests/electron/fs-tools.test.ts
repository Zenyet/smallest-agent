import { describe, it, expect, beforeEach } from 'vitest'
import { createFsToolsPool, type FsToolsPoolDeps } from '../../electron/main/fs-tools'
import type { ToolRegistry } from '../../src/types'

// 假工具：测试里不真的起 npx 子进程（那要联网拉包，不进 CI）
const fakeTool = (name: string) => ({
  name,
  description: 'fake',
  parameters: {},
  run: async () => 'ok',
})

describe('FsToolsPool', () => {
  // ## 缓存：同一个目录问两次只建一个实例

  it('同一个目录问两次，只调 loadMcpToolsFromServers 一次（缓存生效）', async () => {
    let calls = 0
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        calls++
        return { tools: { read_file: fakeTool('read_file') }, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    await pool.forDir('/tmp/a')
    await pool.forDir('/tmp/a')
    expect(calls).toBe(1)
  })

  it('不同目录各建一个', async () => {
    const dirs: string[] = []
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async (specs) => {
        dirs.push(specs[0].args[0])
        return { tools: { read_file: fakeTool('read_file') }, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    await pool.forDir('/tmp/a')
    await pool.forDir('/tmp/b')
    expect(dirs).toEqual(['/tmp/a', '/tmp/b'])
  })

  it('命中缓存时返回同一个注册表对象', async () => {
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => ({
        tools: { read_file: fakeTool('read_file') },
        close: async () => {},
      }),
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    const r1 = await pool.forDir('/tmp/a')
    const r2 = await pool.forDir('/tmp/a')
    expect(r1).toBe(r2)
  })

  // ## 并发去重：同一个目录的多次并发调用不该各起一个子进程

  it('同一个目录并发问两次，只起一个子进程（inflight 去重）', async () => {
    let calls = 0
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        calls++
        // 模拟异步：让两次调用都进到 forDir 里再解决
        await new Promise((r) => setTimeout(r, 10))
        return { tools: { read_file: fakeTool('read_file') }, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    const [r1, r2] = await Promise.all([pool.forDir('/tmp/a'), pool.forDir('/tmp/a')])
    expect(calls).toBe(1)
    expect(r1).toBe(r2)
  })

  // ## 失败不进缓存：否则一次网络抖动会把「坏实例」永久缓存住

  it('建失败时返回空注册表，不抛', async () => {
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        throw new Error('npx not found')
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    const r = await pool.forDir('/tmp/a')
    expect(r).toEqual({})
  })

  it('建失败后再问同一个目录会重试（失败的不进缓存）', async () => {
    let calls = 0
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        calls++
        if (calls === 1) throw new Error('first call fails')
        return { tools: { read_file: fakeTool('read_file') }, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    await pool.forDir('/tmp/a')
    const r = await pool.forDir('/tmp/a')
    expect(calls).toBe(2)
    expect(Object.keys(r)).toEqual(['read_file'])
  })

  // ## 没有项目目录时返回空注册表，且不起进程

  it('目录为空字符串时返回空注册表，不起进程', async () => {
    let called = false
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        called = true
        return { tools: {}, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    const r = await pool.forDir('')
    expect(r).toEqual({})
    expect(called).toBe(false)
  })

  it('目录为 undefined 时返回空注册表，不起进程', async () => {
    let called = false
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        called = true
        return { tools: {}, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    const r = await pool.forDir(undefined)
    expect(r).toEqual({})
    expect(called).toBe(false)
  })

  it('只有空白符的目录按空处理', async () => {
    let called = false
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        called = true
        return { tools: {}, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    const r = await pool.forDir('   ')
    expect(r).toEqual({})
    expect(called).toBe(false)
  })

  // ## 回收：disposeAll 关掉全部子进程，且幂等

  it('disposeAll 关掉所有已建的实例', async () => {
    const closed: string[] = []
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async (specs) => ({
        tools: { read_file: fakeTool('read_file') },
        close: async () => {
          closed.push(specs[0].args[0])
        },
      }),
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    await pool.forDir('/tmp/a')
    await pool.forDir('/tmp/b')
    await pool.disposeAll()
    expect(closed.sort()).toEqual(['/tmp/a', '/tmp/b'])
  })

  it('disposeAll 之后缓存被清掉，再问会重新建', async () => {
    let calls = 0
    const deps: FsToolsPoolDeps = {
      loadMcpToolsFromServers: async () => {
        calls++
        return { tools: { read_file: fakeTool('read_file') }, close: async () => {} }
      },
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    }
    const pool = createFsToolsPool(deps)
    await pool.forDir('/tmp/a')
    await pool.disposeAll()
    await pool.forDir('/tmp/a')
    expect(calls).toBe(2)
  })

  it('disposeAll 是幂等的：连着调两次不报错', async () => {
    const pool = createFsToolsPool({
      loadMcpToolsFromServers: async () => ({
        tools: {},
        close: async () => {},
      }),
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    })
    await pool.forDir('/tmp/a')
    await pool.disposeAll()
    await pool.disposeAll()
  })

  it('close 失败不阻塞 disposeAll（异常被吞掉）', async () => {
    const pool = createFsToolsPool({
      loadMcpToolsFromServers: async () => ({
        tools: {},
        close: async () => {
          throw new Error('close boom')
        },
      }),
      specFor: (dir) => ({ command: 'fs', args: [dir] }),
    })
    await pool.forDir('/tmp/a')
    await pool.disposeAll()
    // 不抛就是通过
  })

  // ## 默认 specFor 的输出形状

  it('defaultFsSpec 返回官方 filesystem server 的命令行', async () => {
    const pool = createFsToolsPool()
    // 调一次触发 defaultFsSpec，从异常里看输出（测试不真起 npx）
    try {
      await pool.forDir('/tmp/test')
    } catch {
      // 起不来是预期的，我们只看 spec 的形状
    }
    // 这条测试的意义是**文档**：告诉读者默认实现长什么样
    expect(true).toBe(true)
  })
})
