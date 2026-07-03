import { cn } from '@renderer/lib/cn'
import type { MemoryScope } from '@shared/db/types'
import { scopeLabels, scopeOptions } from './memoryMeta'

/** undefined = "All" (the list call omits the scope param). */
export type ScopeFilterValue = MemoryScope | undefined

interface ScopeFilterProps {
  value: ScopeFilterValue
  onChange: (value: ScopeFilterValue) => void
}

interface Segment {
  key: string
  label: string
  value: ScopeFilterValue
}

const segments: Segment[] = [
  { key: 'all', label: 'All', value: undefined },
  ...scopeOptions.map((scope) => ({ key: scope, label: scopeLabels[scope], value: scope }))
]

/** Segmented control that drives the scope filter for the memory list. */
export function ScopeFilter({ value, onChange }: ScopeFilterProps): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Filter memories by scope"
      className="inline-flex items-center gap-1 rounded-xl border border-ink-700 bg-ink-850 p-1"
    >
      {segments.map((segment) => {
        const active = segment.value === value
        return (
          <button
            key={segment.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(segment.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              active ? 'bg-amber-400 text-ink-950' : 'text-fg-muted hover:bg-ink-800 hover:text-fg'
            )}
          >
            {segment.label}
          </button>
        )
      })}
    </div>
  )
}
