import { useState, type FormEvent } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import type { MemoryCreateParams } from '@shared/ipc/contract'
import { MemoryFormFields, type MemoryDraft } from './MemoryFormFields'

interface AddMemoryFormProps {
  onCreate: (params: MemoryCreateParams) => Promise<void>
  onCancel: () => void
}

const emptyDraft: MemoryDraft = { content: '', scope: 'global', kind: 'fact' }

const primaryButton = cn(
  'inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
  'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
  'disabled:cursor-not-allowed disabled:opacity-40'
)

const ghostButton = cn(
  'rounded-lg border border-ink-700 bg-ink-850 px-4 py-2 text-sm font-medium text-fg-muted',
  'transition-colors hover:border-ink-600 hover:text-fg',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'
)

/** Inline panel for adding a new memory: content + scope + kind → create. */
export function AddMemoryForm({ onCreate, onCancel }: AddMemoryFormProps): JSX.Element {
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = draft.content.trim().length > 0 && !saving

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onCreate({ content: draft.content.trim(), scope: draft.scope, kind: draft.kind })
      onCancel()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save memory.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-ink-700/70 bg-ink-850 p-5 shadow-panel"
    >
      <h2 className="mb-4 text-sm font-semibold text-fg-heading">Add a memory</h2>
      <MemoryFormFields draft={draft} onChange={setDraft} disabled={saving} autoFocus />

      {error ? (
        <p className="mt-3 text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving} className={ghostButton}>
          Cancel
        </button>
        <button type="submit" disabled={!canSave} className={primaryButton}>
          {saving ? <Spinner className="text-ink-950" label="Saving memory" /> : null}
          {saving ? 'Saving…' : 'Save memory'}
        </button>
      </div>
    </form>
  )
}
