import type { TaskStatus } from '@shared/db/types'

/** A single Kanban column: a status value plus its presentation tokens. */
export interface BoardColumnDef {
  status: TaskStatus
  title: string
  /** Tailwind class for the column's status dot + card accent. */
  dot: string
  /** Tailwind text/border tint used for the card's left accent bar. */
  accent: string
}

/**
 * Default columns from spec §6, in fixed left-to-right order. The board groups
 * tasks by `status` against this list, so the order here IS the column order.
 */
export const boardColumns: BoardColumnDef[] = [
  { status: 'Backlog', title: 'Backlog', dot: 'bg-fg-subtle', accent: 'bg-fg-subtle' },
  { status: 'Planned', title: 'Planned', dot: 'bg-status-queued', accent: 'bg-status-queued' },
  {
    status: 'In Progress',
    title: 'In Progress',
    dot: 'bg-status-working',
    accent: 'bg-status-working'
  },
  { status: 'Blocked', title: 'Blocked', dot: 'bg-status-blocked', accent: 'bg-status-blocked' },
  { status: 'Done', title: 'Done', dot: 'bg-status-success', accent: 'bg-status-success' }
]

/** Quick lookup from a status to its column definition. */
export const columnByStatus: Record<TaskStatus, BoardColumnDef> = boardColumns.reduce(
  (acc, col) => {
    acc[col.status] = col
    return acc
  },
  {} as Record<TaskStatus, BoardColumnDef>
)
