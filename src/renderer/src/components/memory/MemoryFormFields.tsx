import { useId } from 'react'
import { cn } from '@renderer/lib/cn'
import type { MemoryKind, MemoryScope } from '@shared/db/types'
import { kindLabels, kindOptions, scopeLabels, scopeOptions } from './memoryMeta'

export interface MemoryDraft {
  content: string
  scope: MemoryScope
  kind: MemoryKind
}

interface MemoryFormFieldsProps {
  draft: MemoryDraft
  onChange: (draft: MemoryDraft) => void
  /** Disables every control while a mutation is in flight. */
  disabled?: boolean
  /** Auto-focus the content field when the form first mounts. */
  autoFocus?: boolean
}

const fieldBase =
  'rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle ' +
  'focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60'

const labelClass = 'text-xs font-medium text-fg-muted'

/**
 * The shared content / scope / kind fields for creating and editing a memory.
 * State is fully controlled by the parent via `draft` + `onChange`, so the same
 * fields back the add form and each row's inline editor.
 */
export function MemoryFormFields({
  draft,
  onChange,
  disabled = false,
  autoFocus = false
}: MemoryFormFieldsProps): JSX.Element {
  const contentId = useId()
  const scopeId = useId()
  const kindId = useId()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={contentId} className={labelClass}>
          Content
        </label>
        <textarea
          id={contentId}
          autoFocus={autoFocus}
          required
          rows={3}
          value={draft.content}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, content: e.target.value })}
          placeholder="What should Sunny remember?"
          className={cn(fieldBase, 'min-h-[72px] resize-y leading-relaxed')}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={scopeId} className={labelClass}>
            Scope
          </label>
          <select
            id={scopeId}
            value={draft.scope}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, scope: e.target.value as MemoryScope })}
            className={cn(fieldBase, 'cursor-pointer')}
          >
            {scopeOptions.map((scope) => (
              <option key={scope} value={scope}>
                {scopeLabels[scope]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={kindId} className={labelClass}>
            Kind
          </label>
          <select
            id={kindId}
            value={draft.kind}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, kind: e.target.value as MemoryKind })}
            className={cn(fieldBase, 'cursor-pointer')}
          >
            {kindOptions.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
