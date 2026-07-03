import { describe, it, expect } from 'vitest'
import { buildOrgForest, type OrgNodeLike } from '@renderer/lib/orgTree'

// A compact agent-like builder for the tests.
function a(id: string, manager: string | null): OrgNodeLike {
  return { id, manager_id: manager }
}

describe('buildOrgForest', () => {
  it('nests reports under their manager', () => {
    // lead ──┬── a
    //        └── b ── b1
    const forest = buildOrgForest([
      a('lead', null),
      a('a', 'lead'),
      a('b', 'lead'),
      a('b1', 'b')
    ])
    expect(forest).toHaveLength(1)
    expect(forest[0].node.id).toBe('lead')
    expect(forest[0].children.map((c) => c.node.id)).toEqual(['a', 'b'])
    const b = forest[0].children.find((c) => c.node.id === 'b')
    expect(b?.children.map((c) => c.node.id)).toEqual(['b1'])
  })

  it('treats a missing-manager reference as a root', () => {
    const forest = buildOrgForest([a('x', 'ghost')])
    expect(forest.map((n) => n.node.id)).toEqual(['x'])
  })

  it('treats a self-reference as a root (never a child of itself)', () => {
    const forest = buildOrgForest([a('solo', 'solo')])
    expect(forest).toHaveLength(1)
    expect(forest[0].node.id).toBe('solo')
    expect(forest[0].children).toEqual([])
  })

  it('supports multiple roots (several leads)', () => {
    const forest = buildOrgForest([a('l1', null), a('l2', null), a('c', 'l1')])
    expect(forest.map((n) => n.node.id)).toEqual(['l1', 'l2'])
  })

  it('does not infinitely recurse on a manager cycle, and keeps every node', () => {
    // a ↔ b point at each other — pathological, but must terminate and not drop a node.
    const forest = buildOrgForest([a('a', 'b'), a('b', 'a')])
    const ids = new Set<string>()
    const walk = (nodes: ReturnType<typeof buildOrgForest>): void => {
      for (const n of nodes) {
        ids.add(n.node.id)
        walk(n.children)
      }
    }
    walk(forest)
    expect(ids).toEqual(new Set(['a', 'b']))
  })
})
