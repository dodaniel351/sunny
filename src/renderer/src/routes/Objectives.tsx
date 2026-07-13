import { ListChecks, Plus, Pencil, Target, Trash2, CornerDownRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { GoalForm, type GoalFormValues } from '@renderer/components/objectives/GoalForm'
import { GoalTasksDialog } from '@renderer/components/objectives/GoalTasksDialog'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import { useGoals } from '@renderer/hooks/useGoals'
import { useUiStore } from '@renderer/store/uiStore'
import { cn } from '@renderer/lib/cn'
import { childrenIndex, rollupGoals, type GoalProgress } from '@renderer/lib/goals'
import type { GoalNode } from '@shared/ipc/contract'
import type { GoalStatus } from '@shared/db/types'

type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; parent: GoalNode | null }
  | { mode: 'edit'; goal: GoalNode }

const STATUS_CHIP: Record<GoalStatus, string> = {
  active: 'border-ink-600 bg-ink-850 text-fg-muted',
  achieved: 'border-status-success/40 bg-status-success/10 text-status-success',
  abandoned: 'border-ink-700 bg-ink-850 text-fg-subtle'
}

/** A direct-task + rolled-up progress bar. */
function ProgressBar({ total, done }: GoalProgress): JSX.Element {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const complete = total > 0 && done === total
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
        <div
          className={cn('h-full rounded-full', complete ? 'bg-status-success' : 'bg-amber-400')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-fg-subtle">
        {total === 0 ? 'no tasks' : `${done}/${total} · ${pct}%`}
      </span>
    </div>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

/**
 * Objectives (structure layer) — the "why" above the board. Top-level objectives
 * branch into goals; the board's tasks link up to a goal. Each goal shows a
 * progress rollup aggregated over its descendants, so you can see how the work
 * traces back to intent.
 */
export function Objectives(): JSX.Element {
  const { goals, agents, loading, error, refresh } = useGoals()
  const activeProjectId = useUiStore((s) => s.activeProjectId)

  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The goal whose linked-tasks dialog is open (null = closed).
  const [tasksFor, setTasksFor] = useState<GoalNode | null>(null)

  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])

  // Index goals + their parent→children edges and roll task progress up over
  // descendants once per load (the rollup is a tested pure helper).
  const { roots, childrenOf, progress } = useMemo(() => {
    const byParent = childrenIndex(goals)
    return {
      roots: byParent.get(null) ?? [],
      childrenOf: (id: string): GoalNode[] => byParent.get(id) ?? [],
      progress: rollupGoals(goals)
    }
  }, [goals])

  const progressOf = (id: string): GoalProgress => progress.get(id) ?? { total: 0, done: 0 }

  function openCreateObjective(): void {
    setSaveError(null)
    setEditor({ mode: 'create', parent: null })
  }
  function openCreateGoal(parent: GoalNode): void {
    setSaveError(null)
    setEditor({ mode: 'create', parent })
  }
  function openEdit(goal: GoalNode): void {
    setSaveError(null)
    setEditor({ mode: 'edit', goal })
  }
  function closeEditor(): void {
    if (saving) return
    setEditor({ mode: 'closed' })
    setSaveError(null)
  }

  async function handleSubmit(values: GoalFormValues): Promise<void> {
    setSaving(true)
    setSaveError(null)
    try {
      if (editor.mode === 'edit') {
        await window.sunny.goals.update({
          id: editor.goal.id,
          title: values.title,
          description: values.description || null,
          ownerAgentId: values.ownerAgentId,
          status: values.status
        })
      } else if (editor.mode === 'create') {
        await window.sunny.goals.create({
          title: values.title,
          description: values.description || null,
          ownerAgentId: values.ownerAgentId,
          // A sub-goal inherits its parent's project; a top-level objective uses
          // the active project scope.
          parentGoalId: editor.parent?.id ?? null,
          projectId: editor.parent?.project_id ?? activeProjectId ?? null
        })
      }
      await refresh()
      setEditor({ mode: 'closed' })
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(goal: GoalNode): Promise<void> {
    if (confirmDeleteId !== goal.id) {
      setConfirmDeleteId(goal.id)
      return
    }
    setActionError(null)
    try {
      await window.sunny.goals.delete({ id: goal.id })
      setConfirmDeleteId(null)
      await refresh()
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  // Render a goal and its descendants. depth 0 = objective card; deeper = nested
  // rows indented under it.
  function renderGoal(goal: GoalNode, depth: number): JSX.Element {
    const owner = goal.owner_agent_id ? agentName.get(goal.owner_agent_id) : null
    const children = childrenOf(goal.id)
    const isObjective = depth === 0
    return (
      <div key={goal.id} className={cn(isObjective && 'rounded-2xl border border-ink-700 bg-ink-850')}>
        <div
          className={cn(
            'flex flex-col gap-2 px-4 py-3',
            !isObjective && 'border-t border-ink-800'
          )}
          style={!isObjective ? { paddingLeft: `${depth * 1.25 + 1}rem` } : undefined}
        >
          <div className="flex flex-wrap items-center gap-2">
            {!isObjective ? (
              <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            ) : (
              <Target className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            )}
            <span className={cn('font-semibold', isObjective ? 'text-fg-heading' : 'text-fg')}>
              {goal.title}
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                STATUS_CHIP[goal.status]
              )}
            >
              {goal.status}
            </span>
            {owner ? (
              <span className="rounded-full border border-ink-600 bg-ink-850 px-2 py-0.5 text-[10px] text-fg-muted">
                {owner}
              </span>
            ) : null}

            <div className="ml-auto flex items-center gap-1">
              {confirmDeleteId === goal.id ? (
                <span className="mr-1 text-[10px] font-medium text-status-blocked">
                  {children.length > 0 ? 'Sub-goals move up a level — ' : ''}click again to delete
                </span>
              ) : null}
              {isObjective ? (
                <button
                  type="button"
                  onClick={() => openCreateGoal(goal)}
                  className="inline-flex items-center gap-1 rounded-lg border border-ink-700 px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Goal
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setTasksFor(goal)}
                aria-label={`Manage tasks for ${goal.title}`}
                title="Link tasks to this goal"
                className="rounded-lg p-1 text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => openEdit(goal)}
                aria-label={`Edit ${goal.title}`}
                className="rounded-lg p-1 text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(goal)}
                aria-label={`Delete ${goal.title}`}
                className={cn(
                  'rounded-lg p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                  confirmDeleteId === goal.id
                    ? 'bg-status-blocked/10 text-status-blocked'
                    : 'text-fg-subtle hover:bg-ink-800 hover:text-status-blocked'
                )}
                title={confirmDeleteId === goal.id ? 'Click again to confirm' : 'Delete'}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {goal.description ? (
            <p className="text-xs leading-relaxed text-fg-muted">{goal.description}</p>
          ) : null}

          <ProgressBar {...progressOf(goal.id)} />
        </div>

        {children.length > 0 ? <div>{children.map((c) => renderGoal(c, depth + 1))}</div> : null}
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <PageHeader
        title="Objectives"
        description="The why above the board. Objectives branch into goals; every task traces back to one, and agents inherit that context when they work it."
        actions={
          <button
            type="button"
            onClick={openCreateObjective}
            className="flex items-center gap-2 rounded-xl bg-amber-400 px-3.5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New objective
          </button>
        }
      />

      {error || actionError ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-status-blocked/40 bg-status-blocked/5 px-4 py-3 text-sm text-status-blocked"
        >
          {error ?? actionError}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Spinner label="Loading objectives" />
          Loading objectives…
        </div>
      ) : roots.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No objectives yet"
          description="Create an objective, branch it into goals, then link board tasks to a goal. Agents working those tasks inherit the goal chain as context — so they know not just what to do, but why."
          actionLabel="New objective"
          onAction={openCreateObjective}
          className="mt-8"
        />
      ) : (
        <div className="mt-8 space-y-4">{roots.map((root) => renderGoal(root, 0))}</div>
      )}

      {editor.mode !== 'closed' ? (
        <GoalForm
          mode={editor.mode === 'edit' ? 'edit' : 'create'}
          goal={editor.mode === 'edit' ? editor.goal : null}
          parentTitle={editor.mode === 'create' ? (editor.parent?.title ?? null) : null}
          agents={agents}
          saving={saving}
          error={saveError}
          onSubmit={(values) => void handleSubmit(values)}
          onClose={closeEditor}
        />
      ) : null}

      {tasksFor ? (
        <GoalTasksDialog
          goal={tasksFor}
          onChanged={() => void refresh()}
          onClose={() => setTasksFor(null)}
        />
      ) : null}
    </div>
  )
}
