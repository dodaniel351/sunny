import { useEffect, useId } from 'react'
import { cn } from '@renderer/lib/cn'
import type { Schedule } from '@shared/db/types'

interface DeleteScheduleDialogProps {
  schedule: Schedule
  deleting: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}

/** Confirmation modal for deleting a schedule (spec §7). */
export function DeleteScheduleDialog({
  schedule,
  deleting,
  error,
  onConfirm,
  onClose
}: DeleteScheduleDialogProps): JSX.Element {
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

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
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-850 p-6 shadow-panel"
      >
        <h2 id={titleId} className="text-lg font-bold text-fg-heading">
          Delete schedule
        </h2>
        <p id={descId} className="mt-2 text-sm text-fg-muted">
          Delete <span className="font-semibold text-fg">{schedule.name}</span>? It will stop
          firing. This can&apos;t be undone.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-status-blocked">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className={cn(
              'rounded-xl bg-status-blocked px-4 py-2 text-sm font-semibold text-ink-950 transition-colors',
              'hover:bg-status-blocked/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-blocked/60',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
