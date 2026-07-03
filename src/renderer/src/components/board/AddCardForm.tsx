import { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'

interface AddCardFormProps {
  /** Called with a trimmed title (required) and optional description. */
  onSubmit: (input: { title: string; description?: string }) => void
  onCancel: () => void
}

/** Inline "+ Add" form rendered at the top of a column. Title is required. */
export function AddCardForm({ onSubmit, onCancel }: AddCardFormProps): JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  function submit(): void {
    const trimmed = title.trim()
    if (!trimmed) return
    const desc = description.trim()
    onSubmit({ title: trimmed, description: desc.length > 0 ? desc : undefined })
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onKeyDown={handleKeyDown}
      className="rounded-xl border border-ink-700 bg-ink-800 p-2.5 shadow-panel"
    >
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        aria-label="Task title"
        className={cn(
          'w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-fg',
          'placeholder:text-fg-subtle',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
        )}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        aria-label="Task description"
        rows={2}
        className={cn(
          'mt-2 w-full resize-none rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-fg',
          'placeholder:text-fg-subtle',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
        )}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'rounded-lg px-2.5 py-1.5 text-xs font-medium text-fg-muted',
            'transition-colors hover:bg-ink-750 hover:text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={title.trim().length === 0}
          className={cn(
            'rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-ink-950',
            'transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          Add
        </button>
      </div>
    </form>
  )
}
