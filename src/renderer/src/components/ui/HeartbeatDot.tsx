import { cn } from '@renderer/lib/cn'

/** An agent's live state for the Team view's heartbeat indicator. */
export type HeartbeatState = 'working' | 'idle' | 'paused' | 'retired'

const STYLE: Record<HeartbeatState, { dot: string; label: string }> = {
  working: { dot: 'bg-status-success animate-pulse-glow', label: 'Working' },
  idle: { dot: 'bg-fg-subtle', label: 'Idle' },
  paused: { dot: 'bg-amber-300', label: 'Paused' },
  retired: { dot: 'bg-status-blocked', label: 'Retired' }
}

interface HeartbeatDotProps {
  state: HeartbeatState
  /** Render the text label beside the dot (else dot-only with an sr-only label). */
  showLabel?: boolean
  className?: string
}

/**
 * A small status dot for an agent (structure layer, Team view). "Working" pulses
 * with the same glow idiom the rail uses for a connecting core; the others are
 * steady. The label is always exposed to screen readers.
 */
export function HeartbeatDot({
  state,
  showLabel = false,
  className
}: HeartbeatDotProps): JSX.Element {
  const s = STYLE[state]
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', s.dot)} aria-hidden="true" />
      <span className="sr-only">{s.label}</span>
      {showLabel ? <span className="text-[11px] font-medium text-fg-muted">{s.label}</span> : null}
    </span>
  )
}
