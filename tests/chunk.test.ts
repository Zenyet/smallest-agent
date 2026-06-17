import { describe, it, expect } from 'vitest'
import { chunkText } from '../src/rag/chunk'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world'])
  })
  it('returns empty array for whitespace-only text', () => {
    expect(chunkText('   \n\n  ')).toEqual([])
  })
  it('packs multiple paragraphs into chunks under the size limit', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc'
    const chunks = chunkText(text, 10)
    expect(chunks).toEqual(['aaaa\n\nbbbb', 'cccc'])
  })
  it('hard-splits a paragraph longer than maxChars', () => {
    const long = 'x'.repeat(25)
    const chunks = chunkText(long, 10)
    expect(chunks).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
    expect(chunks.every((c) => c.length <= 10)).toBe(true)
  })
})
