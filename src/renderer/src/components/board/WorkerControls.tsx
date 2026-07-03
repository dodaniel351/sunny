import { Play } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'
import type { WorkerStatusResult } from '@shared/ipc/contract'

/** How often we re-poll worker status while the Board is mounted. */
const POLL_MS = 5000
/** Debounce before committing a typed interval (also commits on blur/Enter). */
const COMMIT_MS = 600

interface WorkerControlsProps {
  /**
   * Called after a scan is likely to have moved cards (Run now, or a fresh
   * `lastScanAt`) so the Board can refetch its task list and reflect changes.
   */
  onScan: () => void
  /** Reports the worker's enabled state on every status poll, so the Board can
   *  show its "auto-work is off but tasks are waiting" banner. */
  onStatus?: (enabled: boolean) => void
}

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  busy?: boolean
}

/** Accessible on/off switch matching the dark + amber theme (role="switch"). */
function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  busy = false
}: SwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-amber-400' : 'bg-ink-700'
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-ink-950 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-1'
        )}
      />
    </button>
  )
}

/**
 * Compact "Auto-work" control bar for the Board header (spec §7). Owns its own
 * polling of `worker.status()` (on mount + every ~5s) so `running` / `lastScanAt`
 * stay live, and refreshes immediately after any mutation. Toggling on/off,
 * editing the scan interval, and "Run now" call the corresponding worker IPCs;
 * after a scan it asks the Board to reload its task list via `onScan`.
 */
export function WorkerControls({ onScan, onStatus }: WorkerControlsProps): JSX.Element {
  const [status, setStatus] = useState<WorkerStatusResult | null>(null)
  const [togglingEnabled, setTogglingEnabled] = useState(false)
  const [runningNow, setRunningNow] = useState(false)
  const [intervalDraft, setIntervalDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const intervalInputId = useId()

  // Track the last-seen scan timestamp so a fresh scan (even one the worker ran
  // on its own timer) can trigger a Board reload exactly once.
  const lastSeenScanRef = useRef<number | null>(null)
  // Hold a pending interval commit so typing debounces to a single setInterval.
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.sunny.worker.status()
    setStatus(next)
    onStatus?.(next.enabled)
    if (next.lastScanAt !== null && next.lastScanAt !== lastSeenScanRef.current) {
      const first = lastSeenScanRef.current === null
      lastSeenScanRef.current = next.lastScanAt
      // Skip the initial observation (mount) so we don't reload needlessly.
      if (!first) onScan()
    }
  }, [onScan, onStatus])

  // Poll status on mount and every ~5s; clear the timer on unmount.
  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      void window.sunny.worker
        .status()
        .then((next) => {
          if (cancelled) return
          setStatus(next)
          onStatus?.(next.enabled)
          if (next.lastScanAt !== null && next.lastScanAt !== lastSeenScanRef.current) {
            const first = lastSeenScanRef.current === null
            lastSeenScanRef.current = next.lastScanAt
            if (!first) onScan()
          }
        })
        .catch(() => {
          // Degrade quietly — the bar simply shows its last-known state.
        })
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [onScan, onStatus])

  // Keep the interval field in sync with the backend unless the user is editing.
  useEffect(() => {
    if (status && commitTimerRef.current === null) {
      setIntervalDraft(String(status.intervalMinutes))
    }
  }, [status])

  // Flush any pending interval commit if the component unmounts mid-edit.
  useEffect(() => {
    return () => {
      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current)
    }
  }, [])

  const handleToggleEnabled = useCallback(
    async (next: boolean): Promise<void> => {
      if (togglingEnabled) return
      setTogglingEnabled(true)
      setError(null)
      // Optimistic flip so the switch feels immediate.
      setStatus((prev) => (prev ? { ...prev, enabled: next } : prev))
      try {
        await window.sunny.worker.setEnabled({ enabled: next })
        await refresh()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not update auto-work.')
        await refresh()
      } finally {
        setTogglingEnabled(false)
      }
    },
    [togglingEnabled, refresh]
  )

  const commitInterval = useCallback(
    async (minutes: number): Promise<void> => {
      if (commitTimerRef.current !== null) {
        clearTimeout(commitTimerRef.current)
        commitTimerRef.current = null
      }
      setError(null)
      try {
        await window.sunny.worker.setInterval({ minutes })
        await refresh()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not update the interval.')
        await refresh()
      }
    },
    [refresh]
  )

  const handleIntervalChange = useCallback(
    (raw: string): void => {
      setIntervalDraft(raw)
      const parsed = Number.parseInt(raw, 10)
      if (Number.isNaN(parsed) || parsed < 1) return
      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current)
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = null
        void commitInterval(parsed)
      }, COMMIT_MS)
    },
    [commitInterval]
  )

  // Commit immediately on blur/Enter; clamp empty/invalid back to current value.
  const handleIntervalCommit = useCallback((): void => {
    const parsed = Number.parseInt(intervalDraft, 10)
    if (Number.isNaN(parsed) || parsed < 1) {
      setIntervalDraft(status ? String(status.intervalMinutes) : '')
      if (commitTimerRef.current !== null) {
        clearTimeout(commitTimerRef.current)
        commitTimerRef.current = null
      }
      return
    }
    void commitInterval(parsed)
  }, [intervalDraft, status, commitInterval])

  const handleRunNow = useCallback(async (): Promise<void> => {
    if (runningNow) return
    setRunningNow(true)
    setError(null)
    try {
      await window.sunny.worker.runNow()
      // Reflect the kicked-off scan, then reload the board shortly after so any
      // freshly-worked cards have a chance to land in Done.
      await refresh()
      onScan()
      setTimeout(() => void refresh(), 1500)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start a scan.')
    } finally {
      setRunningNow(false)
    }
  }, [runningNow, refresh, onScan])

  const enabled = status?.enabled ?? false
  const running = status?.running ?? false
  const intervalMinutes = status?.intervalMinutes ?? 1
  const lastScanAt = status?.lastScanAt ?? null
  const disabled = status === null

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <span className="text-xs font-medium text-fg-muted">Auto-work</span>
          <Switch
            checked={enabled}
            busy={togglingEnabled}
            disabled={disabled}
            label={`Auto-work — ${enabled ? 'on' : 'off'}`}
            onChange={(next) => void handleToggleEnabled(next)}
          />
        </label>

        <label className="flex items-center gap-1.5 select-none" htmlFor={intervalInputId}>
          <span className="text-xs font-medium text-fg-muted">Every</span>
          <input
            id={intervalInputId}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={intervalDraft}
            disabled={disabled}
            aria-label="Scan interval in minutes"
            onChange={(e) => handleIntervalChange(e.target.value)}
            onBlur={handleIntervalCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleIntervalCommit()
                e.currentTarget.blur()
              }
            }}
            className={cn(
              'w-14 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-sm tabular-nums text-fg',
              'focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30',
              'disabled:cursor-not-allowed disabled:opacity-60'
            )}
          />
          <span className="text-xs text-fg-muted">min</span>
        </label>

        <button
          type="button"
          onClick={() => void handleRunNow()}
          disabled={disabled || runningNow}
          aria-label="Run a board scan now"
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-fg-muted',
            'transition-colors hover:border-amber-400/50 hover:text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          {runningNow ? (
            <Spinner className="h-3.5 w-3.5" label="Starting scan" />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Run now
        </button>
      </div>

      <div className="flex items-center gap-2 text-[11px]">
        {enabled ? (
          <span className="text-fg-subtle">
            Scanning every {intervalMinutes} min
            {lastScanAt !== null
              ? ` · last scan ${relativeTime(new Date(lastScanAt).toISOString())}`
              : ' · no scan yet'}
          </span>
        ) : (
          <span className="text-fg-subtle">Auto-work is off</span>
        )}
        {running ? (
          <span className="inline-flex items-center gap-1 font-medium text-amber-300" role="status">
            <Spinner className="h-3 w-3" label="Working" />
            Working…
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-[11px] text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}

      <p className="max-w-[26rem] text-right text-[11px] text-fg-subtle">
        When on, the worker periodically picks up Backlog/Planned tasks and works them with the
        assigned agent (or the default agent), then moves the card to Done. Makes real model calls
        on a timer.
      </p>
    </div>
  )
}
