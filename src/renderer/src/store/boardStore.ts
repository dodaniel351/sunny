import { create } from 'zustand'
import type { Task, TaskStatus } from '@shared/db/types'
import { boardColumns } from '@renderer/components/board/columns'

/** Who the board records as the actor on drag-driven moves (spec §6 audit). */
const BOARD_ACTOR = 'user'

/** Tasks grouped by column status, each list ordered by `sort_order`. */
export type TasksByStatus = Record<TaskStatus, Task[]>

function emptyGroups(): TasksByStatus {
  return boardColumns.reduce((acc, col) => {
    acc[col.status] = []
    return acc
  }, {} as TasksByStatus)
}

/** Group a flat task list into per-column buckets, sorted by sort_order then id. */
function groupTasks(tasks: Task[]): TasksByStatus {
  const groups = emptyGroups()
  for (const task of tasks) {
    // Defensive: ignore any status outside the known column set.
    if (groups[task.status]) groups[task.status].push(task)
  }
  for (const status of Object.keys(groups) as TaskStatus[]) {
    groups[status].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
  }
  return groups
}

interface BoardState {
  tasks: Task[]
  groups: TasksByStatus
  loading: boolean
  error: string | null
  /** The project scope the board is currently showing (null = All Projects). */
  projectId: string | null
  /**
   * Load tasks for a project scope and group them. `projectId` maps to the IPC
   * call as `projectId ?? undefined` (null = all tasks). The scope is retained so
   * `create` attaches new cards to the same project. Safe to call repeatedly.
   * `silent` skips the loading flag so background/live refreshes don't flash the
   * header spinner (the grouped list still updates in place).
   */
  load: (projectId?: string | null, opts?: { silent?: boolean }) => Promise<void>
  /** Create a card in a column and prepend it. Defaults to the loaded project
   *  scope; an explicit `projectId` (or null for unattached) overrides it. */
  create: (params: {
    title: string
    description?: string
    status: TaskStatus
    assignee?: string | null
    projectId?: string | null
  }) => Promise<void>
  /** Patch a card's title/description and reconcile with the returned row. */
  update: (params: { id: string; title?: string; description?: string | null }) => Promise<void>
  /** Optimistically move a card to a column (+ optional index), then reconcile. */
  move: (params: { id: string; status: TaskStatus; sortOrder?: number }) => Promise<void>
  /** Reorder a card within its current column to a target index. */
  reorder: (params: { id: string; status: TaskStatus; toIndex: number }) => Promise<void>
  /** Delete a card optimistically; refetch on failure. */
  remove: (id: string) => Promise<void>
}

function setFromTasks(tasks: Task[]): Pick<BoardState, 'tasks' | 'groups'> {
  return { tasks, groups: groupTasks(tasks) }
}

/**
 * Self-contained board store. Holds the task list, exposes optimistic mutations,
 * and reconciles each with the row the main process returns. On any error it
 * refetches so local state can never drift from the source of truth (the DB).
 */
export const useBoardStore = create<BoardState>((set, get) => ({
  tasks: [],
  groups: emptyGroups(),
  loading: false,
  error: null,
  projectId: null,

  load: async (projectId, opts) => {
    // Default to the currently-held scope so error-path refetches preserve it.
    const scope = projectId === undefined ? get().projectId : projectId
    // A silent (live/background) refresh updates the list without toggling the
    // header spinner; a foreground load shows it while the query runs.
    set(opts?.silent ? { error: null, projectId: scope } : { loading: true, error: null, projectId: scope })
    try {
      const tasks = await window.sunny.tasks.list({ projectId: scope ?? undefined })
      set({ ...setFromTasks(tasks), loading: false })
    } catch (err: unknown) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load tasks.' })
    }
  },

  create: async ({ title, description, status, assignee, projectId }) => {
    try {
      const created = await window.sunny.tasks.create({
        title,
        description,
        status,
        assignee: assignee && assignee.length > 0 ? assignee : undefined,
        // An explicit projectId wins; otherwise attach to the loaded scope.
        projectId: (projectId === undefined ? get().projectId : projectId) ?? undefined
      })
      set((state) => setFromTasks([created, ...state.tasks]))
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to add task.' })
      await get().load()
    }
  },

  update: async ({ id, title, description }) => {
    const prev = get().tasks
    // Optimistic patch.
    set((state) =>
      setFromTasks(
        state.tasks.map((t) =>
          t.id === id
            ? {
                ...t,
                title: title ?? t.title,
                description: description === undefined ? t.description : description
              }
            : t
        )
      )
    )
    try {
      const updated = await window.sunny.tasks.update({ id, title, description })
      set((state) => setFromTasks(state.tasks.map((t) => (t.id === id ? updated : t))))
    } catch (err: unknown) {
      set({ ...setFromTasks(prev), error: err instanceof Error ? err.message : 'Failed to save.' })
    }
  },

  move: async ({ id, status, sortOrder }) => {
    const prev = get().tasks
    const moving = prev.find((t) => t.id === id)
    if (!moving || moving.status === status) return
    // Optimistic: place at the end of the target column.
    const targetCount = get().groups[status].length
    const nextSort = sortOrder ?? targetCount
    set((state) =>
      setFromTasks(
        state.tasks.map((t) => (t.id === id ? { ...t, status, sort_order: nextSort } : t))
      )
    )
    try {
      const moved = await window.sunny.tasks.move({ id, status, sortOrder, actor: BOARD_ACTOR })
      set((state) => setFromTasks(state.tasks.map((t) => (t.id === id ? moved : t))))
    } catch (err: unknown) {
      set({
        ...setFromTasks(prev),
        error: err instanceof Error ? err.message : 'Failed to move task.'
      })
      await get().load()
    }
  },

  reorder: async ({ id, status, toIndex }) => {
    const prev = get().tasks
    const column = get().groups[status]
    const fromIndex = column.findIndex((t) => t.id === id)
    if (fromIndex === -1 || fromIndex === toIndex) return
    // Optimistically reindex the column, then renumber sort_order densely.
    const next = column.slice()
    const [card] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, card)
    const reindexed = new Map(next.map((t, i) => [t.id, i]))
    set((state) =>
      setFromTasks(
        state.tasks.map((t) =>
          t.status === status && reindexed.has(t.id)
            ? { ...t, sort_order: reindexed.get(t.id) as number }
            : t
        )
      )
    )
    try {
      const moved = await window.sunny.tasks.move({
        id,
        status,
        sortOrder: toIndex,
        actor: BOARD_ACTOR
      })
      set((state) => setFromTasks(state.tasks.map((t) => (t.id === id ? moved : t))))
    } catch (err: unknown) {
      set({
        ...setFromTasks(prev),
        error: err instanceof Error ? err.message : 'Failed to reorder task.'
      })
      await get().load()
    }
  },

  remove: async (id) => {
    const prev = get().tasks
    set((state) => setFromTasks(state.tasks.filter((t) => t.id !== id)))
    try {
      await window.sunny.tasks.delete({ id })
    } catch (err: unknown) {
      set({
        ...setFromTasks(prev),
        error: err instanceof Error ? err.message : 'Failed to delete task.'
      })
      await get().load()
    }
  }
}))
