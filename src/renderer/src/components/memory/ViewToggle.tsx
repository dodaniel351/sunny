import { List, Network } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

export type MemoryViewMode = 'list' | 'graph'

interface ViewToggleProps {
  value: MemoryViewMode
  onChange: (value: MemoryViewMode) => void
}

const segments: { key: MemoryViewMode; label: string; Icon: typeof List }[] = [
  { key: 'list', label: 'List', Icon: List },
  { key: 'graph', label: 'Graph', Icon: Network }
]

/** Segmented control switching the Memory view between the list and the graph. */
export function ViewToggle({ value, onChange }: ViewToggleProps): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Memory view mode"
      className="inline-flex items-center gap-1 rounded-xl border border-ink-700 bg-ink-850 p-1"
    >
      {segments.map(({ key, label, Icon }) => {
        const active = key === value
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              active ? 'bg-amber-400 text-ink-950' : 'text-fg-muted hover:bg-ink-800 hover:text-fg'
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        )
      })}
    </div>
  )
}
