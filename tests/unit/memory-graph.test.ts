import { describe, it, expect } from 'vitest'
import { normalizeEntityName } from '@main/repositories/memory-graph'

// Pure-logic tests only. memory-graph.ts imports SunnyDatabase type-only, so the
// import is erased at compile time and this file never loads better-sqlite3 /
// sqlite-vec (which are compiled for Electron's ABI and would fail under Vitest,
// per vitest.config.ts). The DB-backed methods are exercised through the
// Electron runtime, not here.

describe('normalizeEntityName', () => {
  it('lowercases the name', () => {
    expect(normalizeEntityName('OpenAI')).toBe('openai')
    expect(normalizeEntityName('TypeScript')).toBe('typescript')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeEntityName('  Sunny  ')).toBe('sunny')
    expect(normalizeEntityName('\tElectron\n')).toBe('electron')
  })

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeEntityName('David   O’Daniel')).toBe('david o’daniel')
    expect(normalizeEntityName('memory    graph')).toBe('memory graph')
  })

  it('collapses mixed whitespace (tabs, newlines) between words', () => {
    expect(normalizeEntityName('knowledge\t\ngraph')).toBe('knowledge graph')
    expect(normalizeEntityName('a \t b \n c')).toBe('a b c')
  })

  it('combines trim, collapse, and lowercase together', () => {
    expect(normalizeEntityName('  Knowledge   GRAPH  Repository ')).toBe(
      'knowledge graph repository'
    )
  })

  it('produces the same key for variants that should dedup', () => {
    const variants = ['sqlite-vec', 'SQLite-Vec', '  sqlite-vec ', 'SQLITE-VEC']
    const normalized = variants.map(normalizeEntityName)
    expect(new Set(normalized).size).toBe(1)
    expect(normalized[0]).toBe('sqlite-vec')
  })

  it('returns an empty string for blank / whitespace-only input', () => {
    expect(normalizeEntityName('')).toBe('')
    expect(normalizeEntityName('   ')).toBe('')
    expect(normalizeEntityName('\t\n  ')).toBe('')
  })

  it('preserves internal punctuation and single spaces unchanged', () => {
    expect(normalizeEntityName('text-embedding-3-small')).toBe('text-embedding-3-small')
    expect(normalizeEntityName('better-sqlite3')).toBe('better-sqlite3')
  })

  it('is idempotent', () => {
    const once = normalizeEntityName('  Mixed   Case  Name ')
    expect(normalizeEntityName(once)).toBe(once)
  })
})
