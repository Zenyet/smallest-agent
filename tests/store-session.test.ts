import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonSessionStore } from '../src/memory/store'
import type { Message } from '../src/types'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-sessions-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createJsonSessionStore', () => {
  it('returns [] for an unknown session', async () => {
    expect(await createJsonSessionStore(dir).load('nope')).toEqual([])
  })
  it('round-trips messages through save/load', async () => {
    const store = createJsonSessionStore(dir)
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]
    await store.save('s1', msgs)
    expect(await store.load('s1')).toEqual(msgs)
  })
  it('sanitizes the session id so it cannot escape the directory', async () => {
    const store = createJsonSessionStore(dir)
    await store.save('../evil', [{ role: 'user', content: 'x' }])
    expect(await store.load('../evil')).toEqual([{ role: 'user', content: 'x' }])
  })
})
