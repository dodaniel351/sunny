import { Check, Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { AgentSelect } from './AgentSelect'
import { boardColumns, columnByStatus } from './columns'
import type { Agent, Project, TaskStatus } from '@shared/db/types'

const selectClass =
  'rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-fg focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30'

export interface TaskCreateInput {
  title: string
  description: string | null
  status: TaskStatus
  assignee: string | null
  projectId: string | null
}

interface TaskCreateDialogProps {
  /** Agents available for assignment (loaded once at the board level). */
  agents: Agent[]
  /** Projects to choose from; empty hides the project picker. */
  projects: Project[]
  /** The column the create was launched from (preselected status). */
  initialStatus: TaskStatus
  /** The board's current project filter — preselected (null = unattached/all). */
  defaultProjectId: string | null
  creating?: boolean
  error?: string | null
  onCreate: (input: TaskCreateInput) => void
  onClose: () => void
}

/**
 * Create a board task in a proper modal — roomy fields for title, description,
 * status, assignee, and project — instead of the cramped inline card editor.
 */
export function TaskCreateDialog({
  agents,
  projects,
  initialStatus,
  defaultProjectId,
  creating = false,
  error = null,
  onCreate,
  onClose
}: TaskCreateDialogProps): JSX.Element {
  const titleId = useId()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<TaskStatus>(initialStatus)
  const [assignee, setAssignee] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const assignedAgent = assignee ? (agents.find((a) => a.name === assignee) ?? null) : null
  const trimmed = title.trim()
  const canCreate = trimmed.length > 0 && !creating

  function handleCreate(): void {
    if (!canCreate) return
    const desc = description.trim()
    onCreate({
      title: trimmed,
      description: desc.length > 0 ? desc : null,
      status,
      assignee,
      projectId
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
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-panel"
      >
        <div className="flex items-center gap-2 border-b border-ink-700/60 px-6 py-4">
          <Plus className="h-4 w-4 text-amber-300" aria-hidden="true" />
          <h2 id={titleId} className="text-base font-bold text-fg-heading">
            New task
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div>
            <label
              htmlFor={`${titleId}-title`}
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle"
            >
              Title <span className="text-amber-300">*</span>
            </label>
            <input
              id={`${titleId}-title`}
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate()
              }}
              placeholder="What needs doing?"
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            />
          </div>

          <div>
            <label
              htmlFor={`${titleId}-desc`}
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle"
            >
              Description
            </label>
            <textarea
              id={`${titleId}-desc`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
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
                    onClick={() => setStatus(col.status)}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                      active
                        ? 'border-amber-400/50 bg-amber-400/10 text-amber-200'
                        : 'border-ink-700 text-fg-muted hover:border-ink-600 hover:text-fg'
                    )}
                  >
                    <span
                      className={cn('h-2 w-2 rounded-full', columnByStatus[col.status]?.dot)}
                      aria-hidden="true"
                    />
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
              onChange={(agent) => setAssignee(agent ? agent.name : null)}
              emptyLabel="Unassigned"
              label="Assignee"
              size="header"
              align="right"
            />
          </div>

          {projects.length > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Project
              </span>
              <select
                value={projectId ?? ''}
                onChange={(e) => setProjectId(e.target.value || null)}
                aria-label="Project"
                className={cn(selectClass, 'max-w-[16rem] truncate')}
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-status-blocked">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-700/60 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {creating ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  )
}
