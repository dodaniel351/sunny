import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { TaskCard } from './TaskCard'
import type { BoardColumnDef } from './columns'
import type { Agent, Task, TaskStatus } from '@shared/db/types'

interface BoardColumnProps {
  column: BoardColumnDef
  tasks: Task[]
  /** Agents available for assignment, loaded once at the board level. */
  agents: Agent[]
  /** The default agent's id (the `default_agent` setting), or null if none. */
  defaultAgentId: string | null
  /** Open the create-task modal preset to this column's status. */
  onRequestCreate: (status: TaskStatus) => void
  onEdit: (input: { id: string; title: string; description: string | null }) => void
  onDelete: (id: string) => void
  /** Assign an agent (by name) to a task, or '' to unassign. */
  onAssign: (taskId: string, assignee: string) => void
  /** Open a chat configured as the resolved agent, seeded with the task. */
  onWork: (task: Task) => void
  /** Open the Delegate dialog (manager + worker agents) for a task. */
  onDelegate: (task: Task) => void
  /** Open the full detail/edit modal for a task (double-click). */
  onOpenDetail: (task: Task) => void
  /** Open the result/status modal for a task's agent work chat. */
  onView: (task: Task) => void
  /** project id → name, for the per-card project badge. */
  projectName?: Map<string, string>
  /** Show a project badge on each card (true in the All-Projects view). */
  showProjectBadge?: boolean
  /** goal id → title, for the per-card goal chip. */
  goalName?: Map<string, string>
}

/**
 * One Kanban column: a droppable surface wrapping a vertical SortableContext.
 * dnd-kit identifies the column by `useDroppable({ id: status })` so a card
 * dropped onto an empty column still resolves to the right target status.
 */
export function BoardColumn({
  column,
  tasks,
  agents,
  defaultAgentId,
  onRequestCreate,
  onEdit,
  onDelete,
  onAssign,
  onWork,
  onDelegate,
  onOpenDetail,
  onView,
  projectName,
  showProjectBadge,
  goalName
}: BoardColumnProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: column.status,
    data: { status: column.status }
  })

  return (
    <section
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-2xl border border-ink-700/60 bg-ink-900/60 transition-colors',
        isOver && 'border-amber-400/40 bg-ink-850/80'
      )}
    >
      <header className="flex items-center gap-2 border-b border-ink-700/50 px-4 py-3">
        <span className={cn('h-2 w-2 rounded-full', column.dot)} aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg-heading">{column.title}</h2>
        <span className="ml-1 rounded-md bg-ink-800 px-1.5 text-xs font-medium text-fg-subtle">
          {tasks.length}
        </span>
        <button
          type="button"
          aria-label={`Add task to ${column.title}`}
          onClick={() => onRequestCreate(column.status)}
          className="ml-auto rounded-lg p-1 text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div ref={setNodeRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agents={agents}
              defaultAgentId={defaultAgentId}
              onEdit={onEdit}
              onDelete={onDelete}
              onAssign={(assignee) => onAssign(task.id, assignee)}
              onWork={onWork}
              onDelegate={onDelegate}
              onOpenDetail={onOpenDetail}
              onView={onView}
              projectBadge={
                showProjectBadge && task.project_id ? projectName?.get(task.project_id) : undefined
              }
              goalBadge={task.goal_id ? goalName?.get(task.goal_id) : undefined}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 ? (
          <button
            type="button"
            onClick={() => onRequestCreate(column.status)}
            className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-ink-700/70 px-4 py-8 text-center text-xs text-fg-subtle transition-colors hover:border-ink-600 hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            No tasks — add one
          </button>
        ) : null}
      </div>
    </section>
  )
}
