import { type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

/** A rounded, subtly-shadowed surface — the app's standard card chrome. */
export function Panel({ children, className, ...rest }: PanelProps): JSX.Element {
  return (
    <div
      className={cn('rounded-2xl border border-ink-700/70 bg-ink-850 shadow-panel', className)}
      {...rest}
    >
      {children}
    </div>
  )
}
