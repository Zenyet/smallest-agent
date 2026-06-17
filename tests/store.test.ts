import { describe, it, expect } from 'vitest'
import { createStore } from '../src/rag/store'

const chunks = [
  { text: 'apple pie', source: 'a.md', vector: [1, 0] },
  { text: 'banana bread', source: 'b.md', vector: [0, 1] },
  { text: 'apple juice', source: 'c.md', vector: [0.9, 0.1] },
]

describe('createStore', () => {
  it('reports its size', () => {
    expect(createStore(chunks).size).toBe(3)
  })
  it('ranks the closest chunk first', () => {
    const hits = createStore(chunks).search([1, 0], 2)
    expect(hits).toHaveLength(2)
    expect(hits[0].source).toBe('a.md')
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })
  it('returns at most k hits', () => {
    expect(createStore(chunks).search([1, 0], 1)).toHaveLength(1)
  })
})
