import { Check, Pencil, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'
import type { Memory } from '@shared/db/types'
import type { MemoryUpdateParams } from '@shared/ipc/contract'
import { KindBadge, ScopeBadge } from './MemoryBadge'
import { MemoryFormFields, type MemoryDraft } from './MemoryFormFields'

interface MemoryRowProps {
  memory: Memory
  onUpdate: (params: MemoryUpdateParams) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

// Content longer than this collapses to a clamped preview with a Show more toggle.
const CLAMP_THRESHOLD = 240

const iconButton = cn(
  'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs font-medium text-fg-muted',
  'transition-colors hover:border-ink-600 hover:text-fg',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'
)

const dangerButton = cn(
  'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs font-medium text-fg-muted',
  'transition-colors hover:border-status-blocked/50 hover:text-status-blocked',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'
)

const primaryButton = cn(
  'inline-flex items-center gap-2 rounded-lg bg-amber-400 px-3.5 py-1.5 text-xs font-semibold text-ink-950',
  'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
  'disabled:cursor-not-allowed disabled:opacity-40'
)

/** A single memory entry with badges, relative time, and edit/delete actions. */
export function MemoryRow({ memory, onUpdate, onDelete }: MemoryRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<MemoryDraft>({
    content: memory.content,
    scope: memory.scope,
    kind: memory.kind
  })

  const isLong = memory.content.length > CLAMP_THRESHOLD

  function startEditing(): void {
    setDraft({ content: memory.content, scope: memory.scope, kind: memory.kind })
    setError(null)
    setConfirmingDelete(false)
    setEditing(true)
  }

  function cancelEditing(): void {
    setEditing(false)
    setError(null)
  }

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault()
    const content = draft.content.trim()
    if (!content || busy) return
    setBusy(true)
    setError(null)
    try {
      await onUpdate({ id: memory.id, content, scope: draft.scope, kind: draft.kind })
      setEditing(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save changes.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(memory.id)
      // On success the row unmounts when the list refreshes; no further state.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not delete memory.')
      setBusy(false)
      setConfirmingDelete(false)
    }
  }

  if (editing) {
    return (
      <li className="rounded-2xl border border-amber-400/30 bg-ink-850 p-5 shadow-panel">
        <form onSubmit={handleSave}>
          <MemoryFormFields draft={draft} onChange={setDraft} disabled={busy} autoFocus />
          {error ? (
            <p className="mt-3 text-xs text-status-blocked" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-2">
            <button type="button" onClick={cancelEditing} disabled={busy} className={iconButton}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || draft.content.trim().length === 0}
              className={primaryButton}
            >
              {busy ? (
                <Spinner className="text-ink-950" label="Saving changes" />
              ) : (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className="rounded-2xl border border-ink-700/70 bg-ink-850 p-5 shadow-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={memory.kind} />
          <ScopeBadge scope={memory.scope} />
          <span className="text-xs text-fg-subtle">updated {relativeTime(memory.updated_at)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {confirmingDelete ? (
            <>
              <span className="text-xs text-fg-muted">Delete?</span>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className={dangerButton}
              >
                {busy ? (
                  <Spinner className="h-3.5 w-3.5" label="Deleting memory" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
                className={iconButton}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={startEditing}
                aria-label="Edit memory"
                className={iconButton}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                aria-label="Delete memory"
                className={dangerButton}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      <p
        className={cn(
          'mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg',
          isLong && !expanded && 'line-clamp-3'
        )}
      >
        {memory.content}
      </p>

      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 rounded text-xs font-medium text-amber-300 transition-colors hover:text-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}

      {error ? (
        <p className="mt-3 text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}
