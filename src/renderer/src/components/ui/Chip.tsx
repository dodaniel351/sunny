import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
}

/**
 * Pill-shaped button used for composer controls and quick actions. Static for
 * now (Phase 1) — clickable but non-functional, never throws.
 */
export function Chip({ children, className, type = 'button', ...rest }: ChipProps): JSX.Element {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-850',
        'px-3.5 py-2 text-sm font-medium text-fg-muted',
        'transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
