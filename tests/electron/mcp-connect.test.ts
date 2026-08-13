import { describe, it, expect } from 'vitest'
import { transportOptions } from '../../electron/main/mcp-connect'

describe('transportOptions', () => {
  it('把 spec.env 合并进去（ELECTRON_RUN_AS_NODE 必须真的传给子进程）', () => {
    const opts = transportOptions(
      { command: '/bin/electron', args: ['server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      { PATH: '/usr/bin' },
    )
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('保留 base env（子进程要靠 PATH 找到 npx）', () => {
    const opts = transportOptions({ command: 'npx', args: ['tsx'] }, { PATH: '/usr/bin' })
    expect(opts.env.PATH).toBe('/usr/bin')
  })

  it('过滤掉 undefined 值，因为 spawn 的 env 只接受字符串', () => {
    const opts = transportOptions({ command: 'npx', args: [] }, { A: 'a', B: undefined })
    expect(opts.env).toEqual({ A: 'a' })
    expect('B' in opts.env).toBe(false)
  })

  it('原样透传 command 和 args', () => {
    const opts = transportOptions({ command: 'npx', args: ['-y', 'pkg', '/dir'] }, {})
    expect(opts.command).toBe('npx')
    expect(opts.args).toEqual(['-y', 'pkg', '/dir'])
  })
})
