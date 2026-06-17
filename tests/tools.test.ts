import { describe, it, expect } from 'vitest'
import { runTool } from '../src/tools/index'
import type { ToolRegistry } from '../src/types'

const reg: ToolRegistry = {
  echo: {
    name: 'echo',
    description: '',
    parameters: {},
    run: (a: { msg: string }) => ({ echoed: a.msg }),
  },
}

describe('runTool', () => {
  it('runs a known tool and returns a JSON string', async () => {
    const out = await runTool(reg, 'echo', { msg: 'hi' })
    expect(JSON.parse(out)).toEqual({ echoed: 'hi' })
  })

  it('returns error JSON for an unknown tool', async () => {
    expect(JSON.parse(await runTool(reg, 'nope', {}))).toHaveProperty('error')
  })

  it('catches errors thrown inside a tool and returns them as JSON', async () => {
    const boom: ToolRegistry = {
      boom: { name: 'boom', description: '', parameters: {}, run: () => { throw new Error('kaboom') } },
    }
    expect(JSON.parse(await runTool(boom, 'boom', {})).error).toMatch(/kaboom/)
  })
})
