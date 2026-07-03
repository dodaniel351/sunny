import { describe, it, expect } from 'vitest'
import { childrenIndex, rollupGoals, type GoalLike } from '@renderer/lib/goals'

// A compact goal-tree builder for the tests.
function g(id: string, parent: string | null, total: number, done: number): GoalLike {
  return { id, parent_goal_id: parent, task_total: total, task_done: done }
}

describe('childrenIndex', () => {
  it('groups goals by parent, with null for top-level objectives', () => {
    const goals = [g('o1', null, 0, 0), g('a', 'o1', 1, 0), g('b', 'o1', 2, 1)]
    const idx = childrenIndex(goals)
    expect(idx.get(null)?.map((x) => x.id)).toEqual(['o1'])
    expect(idx.get('o1')?.map((x) => x.id)).toEqual(['a', 'b'])
  })
})

describe('rollupGoals', () => {
  it('sums a goal’s own tasks with all descendant tasks', () => {
    // o1 ──┬── a (1/0) ── a1 (4/2)
    //      └── b (2/1)
    const goals = [
      g('o1', null, 0, 0),
      g('a', 'o1', 1, 0),
      g('a1', 'a', 4, 2),
      g('b', 'o1', 2, 1)
    ]
    const r = rollupGoals(goals)
    expect(r.get('a1')).toEqual({ total: 4, done: 2 })
    expect(r.get('a')).toEqual({ total: 5, done: 2 }) // 1/0 + 4/2
    expect(r.get('b')).toEqual({ total: 2, done: 1 })
    expect(r.get('o1')).toEqual({ total: 7, done: 3 }) // 0 + (5/2) + (2/1)
  })

  it('treats a leaf goal as its own direct counts', () => {
    const r = rollupGoals([g('solo', null, 3, 3)])
    expect(r.get('solo')).toEqual({ total: 3, done: 3 })
  })

  it('does not infinitely recurse on a malformed parent cycle', () => {
    // a ↔ b point at each other — pathological, but must terminate.
    const r = rollupGoals([g('a', 'b', 1, 0), g('b', 'a', 1, 1)])
    expect(r.has('a')).toBe(true)
    expect(r.has('b')).toBe(true)
  })

  it('returns an entry for every goal', () => {
    const goals = [g('o1', null, 0, 0), g('a', 'o1', 1, 1), g('b', 'o1', 2, 0)]
    const r = rollupGoals(goals)
    expect([...r.keys()].sort()).toEqual(['a', 'b', 'o1'])
  })
})
