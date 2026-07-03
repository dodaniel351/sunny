import { describe, it, expect } from 'vitest'
import { cosineSimilarity } from '@main/memory/service'

// service.ts imports everything type-only, so this loads no native binding
// (mirrors memory-graph.test.ts). cosineSimilarity is the model-agnostic
// relevance score the recall gate uses to drop off-topic memories.

describe('cosineSimilarity', () => {
  it('is 1 for identical direction', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1) // magnitude-invariant
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('is negative for opposing vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('ranks a related pair above an unrelated pair', () => {
    const query = [1, 1, 0]
    const related = cosineSimilarity(query, [1, 0.9, 0])
    const unrelated = cosineSimilarity(query, [0, 0, 1])
    expect(related).toBeGreaterThan(unrelated)
    // A 0.35 floor keeps the related hit and drops the unrelated one.
    expect(related).toBeGreaterThan(0.35)
    expect(unrelated).toBeLessThan(0.35)
  })

  it('returns 0 for empty, length-mismatched, or zero vectors (never NaN)', () => {
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
  })
})
