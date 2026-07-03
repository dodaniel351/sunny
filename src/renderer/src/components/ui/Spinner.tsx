import { Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

interface SpinnerProps {
  className?: string
  label?: string
}

/** A small spinning indicator; carries an accessible label for screen readers. */
export function Spinner({ className, label = 'Loading' }: SpinnerProps): JSX.Element {
  return (
    <Loader2
      className={cn('h-4 w-4 animate-spin text-fg-muted', className)}
      role="status"
      aria-label={label}
    />
  )
}
