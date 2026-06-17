import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiskCache, withCache, cacheKey, type ResultCache } from '../src/cache'
import type { Message, ModelResult } from '../src/types'

const msgsA: Message[] = [{ role: 'user', content: 'A' }]
const msgsB: Message[] = [{ role: 'user', content: 'B' }]
const ok: ModelResult = { text: 'ok', toolCalls: [] }

function memCache(): ResultCache {
  const store = new Map<string, ModelResult>()
  return { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v) } }
}

describe('cacheKey', () => {
  it('is stable for the same input and differs across messages', () => {
    expect(cacheKey('m', msgsA)).toBe(cacheKey('m', msgsA))
    expect(cacheKey('m', msgsA)).not.toBe(cacheKey('m', msgsB))
  })
})

describe('createDiskCache', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'sa-cache-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('returns undefined on miss and round-trips on set', async () => {
    const cache = createDiskCache(dir)
    expect(await cache.get('k1')).toBeUndefined()
    await cache.set('k1', ok)
    expect(await cache.get('k1')).toEqual(ok)
  })

  it('treats a corrupt cache file as a miss instead of throwing', async () => {
    const cache = createDiskCache(dir)
    await writeFile(join(dir, 'corrupt.json'), '{ not valid json', 'utf8')
    expect(await cache.get('corrupt')).toBeUndefined()
  })
})

describe('withCache', () => {
  it('calls the model on miss and serves the repeat from cache (no 2nd call)', async () => {
    const fn = vi.fn(async () => ok)
    const onHit = vi.fn()
    const cached = withCache(fn, memCache(), 'model-x', onHit)
    const a1 = await cached(msgsA)
    const a2 = await cached(msgsA)
    expect(a1).toEqual(ok)
    expect(a2).toEqual(ok)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onHit).toHaveBeenCalledTimes(1)
  })

  it('misses for different messages', async () => {
    const fn = vi.fn(async () => ok)
    const cached = withCache(fn, memCache(), 'model-x')
    await cached(msgsA)
    await cached(msgsB)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
