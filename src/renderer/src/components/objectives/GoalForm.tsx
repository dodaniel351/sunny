import { Check, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { Agent, Goal, GoalStatus } from '@shared/db/types'

export interface GoalFormValues {
  title: string
  description: string
  ownerAgentId: string | null
  status: GoalStatus
}

interface GoalFormProps {
  mode: 'create' | 'edit'
  /** The goal being edited (edit mode). */
  goal?: Goal | null
  /** When creating a sub-goal, the parent objective's title (shown as context). */
  parentTitle?: string | null
  agents: Agent[]
  saving: boolean
  error: string | null
  onSubmit: (values: GoalFormValues) => void
  onClose: () => void
}

const STATUS_OPTIONS: { value: GoalStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'achieved', label: 'Achieved' },
  { value: 'abandoned', label: 'Abandoned' }
]

const inputClass =
  'w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30'

/** Create/edit modal for an objective or goal (structure layer). */
export function GoalForm({
  mode,
  goal,
  parentTitle,
  agents,
  saving,
  error,
  onSubmit,
  onClose
}: GoalFormProps): JSX.Element {
  const titleId = useId()
  const [title, setTitle] = useState(goal?.title ?? '')
  const [description, setDescription] = useState(goal?.description ?? '')
  const [ownerAgentId, setOwnerAgentId] = useState<string>(goal?.owner_agent_id ?? '')
  const [status, setStatus] = useState<GoalStatus>(goal?.status ?? 'active')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const trimmed = title.trim()
  const noun = parentTitle ? 'goal' : 'objective'

  function handleSubmit(): void {
    if (!trimmed) return
    onSubmit({
      title: trimmed,
      description: description.trim(),
      ownerAgentId: ownerAgentId || null,
      status
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-panel"
      >
        <div className="flex items-center gap-2 border-b border-ink-700/60 px-6 py-4">
          <h2 id={titleId} className="text-base font-bold text-fg-heading">
            {mode === 'edit' ? `Edit ${noun}` : parentTitle ? 'New goal' : 'New objective'}
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

        <div className="space-y-4 px-6 py-5">
          {parentTitle ? (
            <p className="text-xs text-fg-subtle">
              Under objective: <span className="text-fg-muted">{parentTitle}</span>
            </p>
          ) : null}

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              Title
            </label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={parentTitle ? 'e.g. Finalize launch checklist' : 'e.g. Ship the v2 launch'}
              className={inputClass}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Why this matters — the context agents inherit when working its tasks."
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Owner
              </label>
              <select
                value={ownerAgentId}
                onChange={(e) => setOwnerAgentId(e.target.value)}
                className={inputClass}
              >
                <option value="">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            {mode === 'edit' ? (
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                  Status
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as GoalStatus)}
                  className={inputClass}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-status-blocked/40 bg-status-blocked/5 px-3 py-2 text-xs text-status-blocked"
            >
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-700/60 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || trimmed.length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {mode === 'edit' ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
