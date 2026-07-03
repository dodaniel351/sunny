/** Time-aware helpers for the dashboard greeting and activity feed. */

export type DayPart = 'morning' | 'afternoon' | 'evening'

/** Map a local-clock hour onto a coarse part-of-day bucket. */
export function dayPartFromHour(hour: number): DayPart {
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

/** Build the time-aware greeting, e.g. "Good evening, David". */
export function greeting(name: string, now: Date = new Date()): string {
  const part = dayPartFromHour(now.getHours())
  return `Good ${part}, ${name}`
}

/**
 * Coarse "time ago" label for history rows, e.g. "just now", "5m ago",
 * "3h ago", "2d ago", falling back to a locale date for older items.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const diffMs = now.getTime() - then.getTime()
  if (Number.isNaN(diffMs)) return ''
  const seconds = Math.round(diffMs / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return then.toLocaleDateString()
}

/**
 * Ultra-compact recency label for the chat tree: "now", "5m", "2h", "Yesterday",
 * a weekday ("Tue") within the last week, else a short date ("Jun 3").
 */
export function compactTimestamp(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const diffMs = now.getTime() - then.getTime()
  if (Number.isNaN(diffMs)) return ''
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (dayDiff <= 1) return 'Yesterday'
  if (dayDiff < 7) return then.toLocaleDateString(undefined, { weekday: 'short' })
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Coarse "in …" label for a future epoch-ms instant, e.g. "in 5m", "in 3h",
 * "in 2d". Returns 'expired' when the instant is already in the past, and ''
 * for an unparseable value. Used for OAuth session expiry hints.
 */
export function relativeFuture(epochMs: number, now: Date = new Date()): string {
  const diffMs = epochMs - now.getTime()
  if (Number.isNaN(diffMs)) return ''
  if (diffMs <= 0) return 'expired'
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'in under a minute'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.round(hours / 24)
  return `in ${days}d`
}
