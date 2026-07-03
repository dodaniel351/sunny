// Pure helpers for the Objectives tree (structure layer). Kept free of React so
// the non-trivial descendant rollup is unit-testable in isolation.

export interface GoalProgress {
  total: number
  done: number
}

/** The minimal goal shape these helpers need (a subset of GoalNode). */
export interface GoalLike {
  id: string
  parent_goal_id: string | null
  /** Direct tasks linked to this goal (not its descendants). */
  task_total: number
  task_done: number
}

/** Index goals by their parent id (null key = top-level objectives). */
export function childrenIndex<T extends GoalLike>(goals: T[]): Map<string | null, T[]> {
  const byParent = new Map<string | null, T[]>()
  for (const g of goals) {
    const list = byParent.get(g.parent_goal_id) ?? []
    list.push(g)
    byParent.set(g.parent_goal_id, list)
  }
  return byParent
}

/**
 * Progress for every goal, rolled up over all its descendants: a goal's totals
 * are its own direct tasks plus the rolled-up totals of its child goals. Memoised
 * so each goal is computed once, and cycle-guarded so a malformed parent link
 * (a goal reachable from itself) can't infinitely recurse.
 */
export function rollupGoals<T extends GoalLike>(goals: T[]): Map<string, GoalProgress> {
  const byParent = childrenIndex(goals)
  const memo = new Map<string, GoalProgress>()
  const visiting = new Set<string>()

  const compute = (goal: T): GoalProgress => {
    const cached = memo.get(goal.id)
    if (cached) return cached
    if (visiting.has(goal.id)) return { total: goal.task_total, done: goal.task_done }
    visiting.add(goal.id)

    let total = goal.task_total
    let done = goal.task_done
    for (const child of byParent.get(goal.id) ?? []) {
      const sub = compute(child)
      total += sub.total
      done += sub.done
    }

    visiting.delete(goal.id)
    const result = { total, done }
    memo.set(goal.id, result)
    return result
  }

  for (const g of goals) compute(g)
  return memo
}
