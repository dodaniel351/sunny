import {
  Check,
  CornerDownRight,
  GitFork,
  Link2,
  MessageSquare,
  Play,
  Target,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { AgentSelect } from './AgentSelect'
import { boardColumns, columnByStatus } from './columns'
import type { Agent, Task, TaskStatus } from '@shared/db/types'
import type { GoalNode } from '@shared/ipc/contract'

const selectClass =
  'rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-fg focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30'

interface TaskDetailDialogProps {
  /** The card being viewed/edited (a snapshot; the dialog keeps local edits). */
  task: Task
  /** Agents available for assignment (loaded once at the board level). */
  agents: Agent[]
  /** Objectives/goals available to link this task to (structure layer). */
  goals: GoalNode[]
  /** All tasks in scope, for choosing a blocker dependency. */
  allTasks: Task[]
  /** Called after a goal link or dependency edge changes, so the board reloads. */
  onChanged: () => void
  onClose: () => void
  /** Persist title/description edits. */
  onSave: (input: { id: string; title: string; description: string | null }) => void
  /** Assign an agent (by name) to the task, or '' to unassign. */
  onAssign: (taskId: string, assignee: string) => void
  /** Move the task to a different status (column). */
  onStatusChange: (taskId: string, status: TaskStatus) => void
  onDelete: (id: string) => void
  /** Run the task now in the background (the worker runs it as its agent). */
  onWork: (task: Task) => void
  /** Open the Delegate dialog (manager + worker agents) for this task. */
  onDelegate: (task: Task) => void
  /** Open the agent's work chat for this task (review its output), if one exists. */
  onOpenChat?: (chatId: string) => void
}

/**
 * Full-size view/edit modal for a board card (opened by double-clicking it).
 * Gives the title, the full description, status, and agent assignment room to
 * breathe — and unlike the cramped card it never clips the assignee picker.
 */
export function TaskDetailDialog({
  task,
  agents,
  goals,
  allTasks,
  onChanged,
  onClose,
  onSave,
  onAssign,
  onStatusChange,
  onDelete,
  onWork,
  onDelegate,
  onOpenChat
}: TaskDetailDialogProps): JSX.Element {
  const titleId = useId()
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [assignee, setAssignee] = useState<string | null>(task.assignee)
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Structure layer: the linked goal + this task's blocker dependencies.
  const [goalId, setGoalId] = useState<string | null>(task.goal_id)
  const [blockers, setBlockers] = useState<Task[]>([])
  // Error from a rejected blocker add (e.g. a would-be circular dependency).
  const [blockerError, setBlockerError] = useState<string | null>(null)

  // Re-seed when a different card is opened into the same dialog instance.
  useEffect(() => {
    setTitle(task.title)
    setDescription(task.description ?? '')
    setAssignee(task.assignee)
    setStatus(task.status)
    setGoalId(task.goal_id)
    setConfirmDelete(false)
    setBlockerError(null)
  }, [task.id, task.title, task.description, task.assignee, task.status, task.goal_id])

  // Load this task's blocker edges whenever a different card is opened.
  const loadBlockers = useCallback(async (): Promise<void> => {
    try {
      const { blockers } = await window.sunny.tasks.dependencies({ taskId: task.id })
      setBlockers(blockers)
    } catch {
      setBlockers([])
    }
  }, [task.id])

  useEffect(() => {
    void loadBlockers()
  }, [loadBlockers])

  function handleGoalChange(next: string): void {
    const value = next || null
    setGoalId(value)
    void window.sunny.tasks.setGoal({ taskId: task.id, goalId: value }).then(onChanged)
  }

  function handleAddBlocker(dependsOnTaskId: string): void {
    if (!dependsOnTaskId) return
    setBlockerError(null)
    void window.sunny.tasks
      .addDependency({ taskId: task.id, dependsOnTaskId })
      .then(() => loadBlockers())
      .then(onChanged)
      .catch((err: unknown) => {
        // A rejected add (most often a circular dependency) surfaces its reason
        // inline instead of silently doing nothing.
        setBlockerError(err instanceof Error ? err.message : 'Could not add that blocker.')
      })
  }

  function handleRemoveBlocker(dependsOnTaskId: string): void {
    void window.sunny.tasks
      .removeDependency({ taskId: task.id, dependsOnTaskId })
      .then(() => loadBlockers())
      .then(onChanged)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const assignedAgent = assignee ? (agents.find((a) => a.name === assignee) ?? null) : null
  const trimmedTitle = title.trim()
  const dirty =
    trimmedTitle.length > 0 &&
    (trimmedTitle !== task.title || description.trim() !== (task.description ?? ''))
  const isSubtask = task.parent_task_id !== null

  function handleSave(): void {
    if (!trimmedTitle) return
    const desc = description.trim()
    onSave({ id: task.id, title: trimmedTitle, description: desc.length > 0 ? desc : null })
    onClose()
  }

  function handleAssign(agent: Agent | null): void {
    setAssignee(agent ? agent.name : null)
    onAssign(task.id, agent ? agent.name : '')
  }

  function handleStatus(next: TaskStatus): void {
    if (next === status) return
    setStatus(next)
    onStatusChange(task.id, next)
  }

  function handleDelete(): void {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    onDelete(task.id)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-panel"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-ink-700/60 px-6 py-4">
          <span
            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', columnByStatus[status]?.dot)}
            aria-hidden="true"
          />
          <h2 id={titleId} className="text-base font-bold text-fg-heading">
            Edit task
          </h2>
          {isSubtask ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              <CornerDownRight className="h-3 w-3" aria-hidden="true" />
              subtask
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Body (scrolls if long) */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Task title"
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Task description"
              rows={7}
              placeholder="Add details, context, acceptance criteria…"
              className="w-full resize-y rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            />
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              Status
            </span>
            <div className="flex flex-wrap gap-1.5">
              {boardColumns.map((col) => {
                const active = col.status === status
                return (
                  <button
                    key={col.status}
                    type="button"
                    onClick={() => handleStatus(col.status)}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                      active
                        ? 'border-amber-400/50 bg-amber-400/10 text-amber-200'
                        : 'border-ink-700 text-fg-muted hover:border-ink-600 hover:text-fg'
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full', col.dot)} aria-hidden="true" />
                    {col.title}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              Assignee
            </span>
            <AgentSelect
              agents={agents}
              value={assignedAgent}
              onChange={handleAssign}
              emptyLabel="Unassigned"
              label="Assignee"
              size="header"
              align="right"
            />
          </div>

          {/* Goal link (structure layer) — the "why" this task traces back to. */}
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              <Target className="h-3.5 w-3.5" aria-hidden="true" />
              Goal
            </span>
            <select
              value={goalId ?? ''}
              onChange={(e) => handleGoalChange(e.target.value)}
              aria-label="Goal"
              className={cn(selectClass, 'max-w-[16rem] truncate')}
            >
              <option value="">No goal</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>

          {/* Blocker dependencies — the heartbeat won't work this until they're Done. */}
          <div>
            <span className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Blocked by
            </span>
            {blockers.length > 0 ? (
              <ul className="mb-2 space-y-1">
                {blockers.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5"
                  >
                    <span
                      className={cn('h-2 w-2 shrink-0 rounded-full', columnByStatus[b.status]?.dot)}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{b.title}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-subtle">
                      {b.status}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveBlocker(b.id)}
                      aria-label={`Remove blocker ${b.title}`}
                      className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:text-status-blocked focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-2 text-xs text-fg-subtle">Nothing — this task can start anytime.</p>
            )}
            <select
              value=""
              onChange={(e) => handleAddBlocker(e.target.value)}
              aria-label="Add a blocker"
              className={cn(selectClass, 'w-full')}
            >
              <option value="">Add a blocker…</option>
              {allTasks
                .filter((t) => t.id !== task.id && !blockers.some((b) => b.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
            {blockerError ? (
              <p className="mt-1.5 text-xs text-status-blocked">{blockerError}</p>
            ) : null}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 border-t border-ink-700/60 px-6 py-4">
          <button
            type="button"
            onClick={() => {
              onWork(task)
              onClose()
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ink-700 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            {task.chat_id ? 'Resume' : 'Work'}
          </button>
          {task.chat_id && onOpenChat ? (
            <button
              type="button"
              onClick={() => {
                if (task.chat_id) onOpenChat(task.chat_id)
                onClose()
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-ink-700 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              Open chat
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              onDelegate(task)
              onClose()
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ink-700 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <GitFork className="h-4 w-4" aria-hidden="true" />
            Delegate
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              confirmDelete
                ? 'border-status-blocked/60 bg-status-blocked/10 text-status-blocked'
                : 'border-ink-700 text-fg-muted hover:border-status-blocked/50 hover:text-status-blocked'
            )}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {confirmDelete ? 'Confirm' : 'Delete'}
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
