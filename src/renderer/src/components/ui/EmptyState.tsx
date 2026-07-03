import { type LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  /** Optional primary action label; renders an amber button when present. */
  actionLabel?: string
  onAction?: () => void
  className?: string
}

/** Consistent placeholder for routed views that have no data yet (Phase 1). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  className
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}
    >
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-ink-700 bg-ink-800">
        <Icon className="h-7 w-7 text-amber-300" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-semibold text-fg-heading">{title}</h2>
      <p className="mt-2 max-w-sm text-sm text-fg-muted">{description}</p>
      {actionLabel ? (
        <button
          type="button"
          onClick={onAction}
          className={cn(
            'mt-6 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
            'transition-colors hover:bg-amber-300',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}
