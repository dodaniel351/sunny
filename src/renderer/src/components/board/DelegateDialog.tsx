import { GitFork, Users } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { AgentSelect } from './AgentSelect'
import type { Agent, Task } from '@shared/db/types'

interface DelegateDialogProps {
  /** The task being delegated. */
  task: Task
  /** Agents available as manager/worker (loaded once at the board level). */
  agents: Agent[]
  /** The board's default agent's id, or null if none — used to seed both selects. */
  defaultAgentId: string | null
  /** True while the delegate request is in flight (disables the form). */
  delegating: boolean
  /** Optional error to surface inline. */
  error: string | null
  /** Fires with the chosen manager/worker agent ids when Delegate is confirmed. */
  onConfirm: (input: { managerAgentId?: string; workerAgentId?: string }) => void
  onClose: () => void
}

/**
 * Modal for delegating a task to a manager + worker agent pair (spec §7).
 * The manager decomposes the task into subtasks and synthesizes the results;
 * the worker does each subtask. Both selects default to the board's default
 * agent, falling back to the first agent. Styled like the other board/agent
 * modals (DeleteAgentDialog) — dark surface, warm-amber accent.
 */
export function DelegateDialog({
  task,
  agents,
  defaultAgentId,
  delegating,
  error,
  onConfirm,
  onClose
}: DelegateDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()

  // Seed both selects: the board default agent if present, else the first agent.
  const seedAgent = useMemo<Agent | null>(() => {
    const byDefault = defaultAgentId ? agents.find((a) => a.id === defaultAgentId) : undefined
    return byDefault ?? agents[0] ?? null
  }, [agents, defaultAgentId])

  const [manager, setManager] = useState<Agent | null>(seedAgent)
  const [worker, setWorker] = useState<Agent | null>(seedAgent)

  // Re-seed if the agent list / default resolves after the dialog opens.
  useEffect(() => {
    setManager(seedAgent)
    setWorker(seedAgent)
  }, [seedAgent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleConfirm(): void {
    onConfirm({
      managerAgentId: manager?.id ?? undefined,
      workerAgentId: worker?.id ?? undefined
    })
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
        aria-describedby={descId}
        className="relative z-10 w-full max-w-md rounded-2xl border border-ink-700 bg-ink-850 p-6 shadow-panel"
      >
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300"
            aria-hidden="true"
          >
            <GitFork className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold text-fg-heading">
              Delegate task
            </h2>
            <p id={descId} className="mt-1 truncate text-sm text-fg-muted">
              <span className="font-semibold text-fg">{task.title}</span>
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
              <span className="text-sm font-medium text-fg">Manager</span>
            </div>
            <AgentSelect
              agents={agents}
              value={manager}
              onChange={setManager}
              emptyLabel="None"
              label="Manager agent"
              size="header"
              align="right"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <GitFork className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
              <span className="text-sm font-medium text-fg">Worker</span>
            </div>
            <AgentSelect
              agents={agents}
              value={worker}
              onChange={setWorker}
              emptyLabel="None"
              label="Worker agent"
              size="header"
              align="right"
            />
          </div>

          <p className="text-xs leading-relaxed text-fg-subtle">
            The manager will break this task into subtasks, assign them to the worker, and combine
            the results.
          </p>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-status-blocked">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={delegating}
            className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={delegating}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 transition-colors',
              'hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            <GitFork className="h-4 w-4" aria-hidden="true" />
            {delegating ? 'Delegating…' : 'Delegate'}
          </button>
        </div>
      </div>
    </div>
  )
}
