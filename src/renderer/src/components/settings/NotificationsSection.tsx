import { useEffect, useState } from 'react'
import { cn } from '@renderer/lib/cn'

/** Setting key for OS notifications ('off' disables; anything else = on). */
const NOTIFICATIONS_KEY = 'notifications_enabled'

/**
 * OS notifications (autonomy hardening, 0.4.3) — Sunny lives in the tray, so
 * approval requests, blocked tasks, finished runs, and auto-disabled schedules
 * fire a system notification. Default ON; this toggle writes the
 * `notifications_enabled` setting the main-process notifier checks per event.
 */
export function NotificationsSection(): JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.sunny.settings
      .get({ key: NOTIFICATIONS_KEY })
      .then((res) => {
        if (cancelled) return
        setEnabled(res.value !== 'off')
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true) // default on
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleToggle(next: boolean): Promise<void> {
    setEnabled(next)
    setError(null)
    try {
      const res = await window.sunny.settings.set({
        key: NOTIFICATIONS_KEY,
        value: next ? 'on' : 'off'
      })
      if (!res.ok) setError('Could not save the notification setting.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the notification setting.')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-subtle">
        Get a system notification when an agent needs your approval, a task blocks or finishes,
        or a failing schedule is auto-disabled — so background work never stalls silently while
        Sunny sits in the tray.
      </p>
      <label className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="OS notifications"
          disabled={!loaded}
          onClick={() => void handleToggle(!enabled)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-50',
            enabled ? 'bg-amber-400' : 'bg-ink-700'
          )}
        >
          <span
            className={cn(
              'inline-block h-3.5 w-3.5 transform rounded-full bg-ink-950 transition-transform',
              enabled ? 'translate-x-4' : 'translate-x-1'
            )}
          />
        </button>
        <span className="text-sm text-fg">{enabled ? 'Notifications on' : 'Notifications off'}</span>
      </label>
      {error ? (
        <p className="text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
