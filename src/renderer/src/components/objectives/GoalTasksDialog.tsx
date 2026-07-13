import { Link2, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import { columnByStatus } from '@renderer/components/board/columns'
import type { GoalNode } from '@shared/ipc/contract'
import type { Task } from '@shared/db/types'

interface GoalTasksDialogProps {
  goal: GoalNode
  /** Called after a link/unlink so the tree can re-roll progress. */
  onChanged: () => void
  onClose: () => void
}

/**
 * Link board tasks to a goal FROM the Objectives view (previously only possible
 * on the board). Shows the goal's currently-linked tasks (with unlink) and a
 * picker of unlinked tasks to attach. Both call `tasks.setGoal`; the progress
 * rollup on the goal tree updates on `onChanged`.
 */
export function GoalTasksDialog({ goal, onChanged, onClose }: GoalTasksDialogProps): JSX.Element {
  const [linked, setLinked] = useState<Task[]>([])
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [detail, all] = await Promise.all([
        window.sunny.goals.get({ id: goal.id }),
        window.sunny.tasks.list({})
      ])
      setLinked(detail.tasks)
      setAllTasks(all)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load tasks.')
    } finally {
      setLoading(false)
    }
  }, [goal.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Tasks not already attached to THIS goal, offered in the picker.
  const linkable = allTasks.filter((t) => t.goal_id !== goal.id)

  async function setGoal(taskId: string, goalId: string | null): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.sunny.tasks.setGoal({ taskId, goalId })
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the task.')
    } finally {
      setBusy(false)
    }
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
        aria-label={`Tasks for ${goal.title}`}
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-panel"
      >
        <div className="flex items-start gap-3 border-b border-ink-700/60 px-6 py-4">
          <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-fg-heading">Tasks for “{goal.title}”</h2>
            <p className="mt-0.5 text-[11px] text-fg-subtle">
              Link board tasks to this goal so agents inherit its context.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
              <Spinner label="Loading tasks" />
              Loading…
            </div>
          ) : (
            <>
              {error ? (
                <p className="mb-3 text-xs text-status-blocked" role="alert">
                  {error}
                </p>
              ) : null}

              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Linked tasks
              </span>
              {linked.length > 0 ? (
                <ul className="mb-4 space-y-1">
                  {linked.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5"
                    >
                      <span
                        className={cn('h-2 w-2 shrink-0 rounded-full', columnByStatus[t.status]?.dot)}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{t.title}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-subtle">
                        {t.status}
                      </span>
                      <button
                        type="button"
                        onClick={() => void setGoal(t.id, null)}
                        disabled={busy}
                        aria-label={`Unlink ${t.title}`}
                        className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:text-status-blocked focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-4 text-xs text-fg-subtle">No tasks linked yet.</p>
              )}

              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Link a task
              </span>
              <div className="flex items-center gap-2">
                <select
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  disabled={busy || linkable.length === 0}
                  className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50"
                >
                  <option value="">
                    {linkable.length === 0 ? 'No other tasks to link' : 'Choose a task…'}
                  </option>
                  {linkable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                      {t.goal_id ? ' (linked elsewhere)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    if (pick) void setGoal(pick, goal.id).then(() => setPick(''))
                  }}
                  disabled={busy || !pick}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Link
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
