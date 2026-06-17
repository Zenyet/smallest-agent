import { describe, it, expect, vi } from 'vitest'
import { makeSearchNotesTool } from '../src/tools/searchNotes'
import type { VectorStore } from '../src/rag/store'
import type { Embedder } from '../src/rag/embed'

describe('makeSearchNotesTool', () => {
  it('builds a Tool named search_notes', () => {
    const store: VectorStore = { size: 0, search: () => [] }
    const embed: Embedder = async (t) => t.map(() => [0])
    const tool = makeSearchNotesTool({ store, embed })
    expect(tool.name).toBe('search_notes')
    expect(typeof tool.run).toBe('function')
  })
  it('embeds the query and returns store hits', async () => {
    const store: VectorStore = {
      size: 1,
      search: vi.fn(() => [{ text: 'hi', source: 'n.md', score: 0.9 }]),
    }
    const embed: Embedder = vi.fn(async (t) => t.map(() => [1, 0]))
    const tool = makeSearchNotesTool({ store, embed })
    const out: any = await tool.run({ query: '问题', k: 1 })
    expect(embed).toHaveBeenCalledWith(['问题'])
    expect(out.query).toBe('问题')
    expect(out.hits[0].source).toBe('n.md')
  })
})
