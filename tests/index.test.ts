import { describe, it, expect } from 'vitest'
import { buildNotesIndex, searchNotes } from '../src/rag/index'
import type { Embedder } from '../src/rag/embed'

const fakeEmbed: Embedder = async (texts) =>
  texts.map((t) => [t.includes('apple') ? 1 : 0, t.includes('banana') ? 1 : 0])

const fixtureDir = new URL('./fixtures/notes', import.meta.url).pathname

describe('buildNotesIndex', () => {
  it('reads .md files, chunks, and embeds every chunk', async () => {
    const store = await buildNotesIndex({ notesDir: fixtureDir, embed: fakeEmbed })
    expect(store.size).toBe(2)
  })
})

describe('searchNotes', () => {
  it('returns hits ranked by semantic closeness, with source and score', async () => {
    const store = await buildNotesIndex({ notesDir: fixtureDir, embed: fakeEmbed })
    const result = await searchNotes(store, fakeEmbed, 'apple', 1)
    expect(result.query).toBe('apple')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].source).toBe('apple.md')
    expect(result.hits[0].score).toBeGreaterThan(0)
    expect(typeof result.hits[0].text).toBe('string')
  })
})
