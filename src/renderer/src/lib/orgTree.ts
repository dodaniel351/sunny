// Build a nested forest from a flat list of items linked by `manager_id`
// (structure layer, Team view). Pure + cycle-safe so both the indented list and
// the org-chart share one tree shape and it's unit-testable (mirrors lib/goals).
//
// Roots are items with no manager, a manager not present in the set, or a self-
// reference. Items caught in a manager cycle (never reached from a root) are
// appended as roots so every item appears exactly once.

export interface OrgNodeLike {
  id: string
  manager_id: string | null
}

export interface OrgTreeNode<T> {
  node: T
  children: OrgTreeNode<T>[]
}

export function buildOrgForest<T extends OrgNodeLike>(items: T[]): OrgTreeNode<T>[] {
  const ids = new Set(items.map((i) => i.id))
  const childrenOf = new Map<string, T[]>()
  const roots: T[] = []

  for (const item of items) {
    const hasParent =
      item.manager_id !== null && item.manager_id !== item.id && ids.has(item.manager_id)
    if (hasParent) {
      const bucket = childrenOf.get(item.manager_id as string) ?? []
      bucket.push(item)
      childrenOf.set(item.manager_id as string, bucket)
    } else {
      roots.push(item)
    }
  }

  const visited = new Set<string>()
  const build = (item: T): OrgTreeNode<T> => {
    visited.add(item.id)
    const kids = (childrenOf.get(item.id) ?? []).filter((c) => !visited.has(c.id))
    return { node: item, children: kids.map(build) }
  }

  const forest = roots.map(build)
  // Any item not reached (a manager cycle) becomes its own root so nothing is lost.
  for (const item of items) {
    if (!visited.has(item.id)) forest.push(build(item))
  }
  return forest
}
