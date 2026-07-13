import { Bot, FolderClosed, Pencil, Play, Repeat, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { Panel } from '@renderer/components/ui/Panel'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'
import type { Schedule } from '@shared/db/types'
import { CADENCE_LABELS, type Cadence } from '@shared/scheduler'

/**
 * Parse a schedule's stored `payload` JSON into its goal/prompt. Guards
 * JSON.parse so a malformed value never breaks the row — it just shows no goal.
 */
function promptFromPayload(payload: string | null): string {
  if (!payload) return ''
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed && typeof parsed === 'object' && 'prompt' in parsed) {
      const value = (parsed as { prompt?: unknown }).prompt
      return typeof value === 'string' ? value : ''
    }
    return ''
  } catch {
    return ''
  }
}

/** Cadence label, falling back to the raw stored value for unknown presets. */
function cadenceLabel(cron: string | null): string {
  if (!cron) return 'No cadence'
  return CADENCE_LABELS[cron as Cadence] ?? cron
}

interface ScheduleRowProps {
  schedule: Schedule
  /** Resolved agent display name, or "Default agent" when unassigned. */
  agentName: string
  /** Resolved project display name, or "All / unassigned" when unassigned. */
  projectName: string
  /** True while this row's enabled toggle is being persisted. */
  toggling: boolean
  /** True while this row's Run now request is in flight. */
  running: boolean
  onToggleEnabled: (schedule: Schedule, enabled: boolean) => void
  onRunNow: (schedule: Schedule) => void
  onEdit: (schedule: Schedule) => void
  onDelete: (schedule: Schedule) => void
}

/** A single schedule card in the list (spec §7). */
export function ScheduleRow({
  schedule,
  agentName,
  projectName,
  toggling,
  running,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onDelete
}: ScheduleRowProps): JSX.Element {
  const prompt = useMemo(() => promptFromPayload(schedule.payload), [schedule.payload])
  const enabled = schedule.enabled === 1

  return (
    <Panel className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-bold text-fg-heading">{schedule.name}</h3>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
            <Repeat className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{cadenceLabel(schedule.cron)}</span>
          </div>
        </div>

        <label
          className={cn(
            'flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
            enabled
              ? 'border-amber-400/60 bg-amber-400/10 text-amber-300'
              : 'border-ink-700 bg-ink-900 text-fg-muted hover:border-ink-600'
          )}
        >
          <input
            type="checkbox"
            checked={enabled}
            disabled={toggling}
            onChange={(e) => onToggleEnabled(schedule, e.target.checked)}
            className="h-4 w-4 accent-amber-400"
          />
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
      </div>

      {prompt ? (
        <p className="line-clamp-2 text-sm text-fg-muted">{prompt}</p>
      ) : (
        <p className="text-sm text-fg-subtle">No goal set.</p>
      )}

      {/* Circuit breaker: the scheduler auto-disables a schedule after 3
          consecutive firings that ended Blocked. Without this the row looks
          identical to a manually-disabled one, so the user re-enables blindly
          and it re-trips. */}
      {!enabled && schedule.consecutive_failures >= 3 ? (
        <p className="rounded-lg border border-status-blocked/30 bg-status-blocked/10 px-3 py-2 text-xs text-status-blocked">
          Auto-disabled after {schedule.consecutive_failures} consecutive failed runs. Fix the
          cause (open a recent run from Activity), then re-enable it above.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{agentName}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <FolderClosed className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{projectName}</span>
        </span>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-fg-subtle">
        <span>
          Next run:{' '}
          <span className="text-fg-muted">
            {schedule.next_run_at ? relativeTime(schedule.next_run_at) : '—'}
          </span>
        </span>
        <span>
          Last run:{' '}
          <span className="text-fg-muted">
            {schedule.last_run_at ? relativeTime(schedule.last_run_at) : '—'}
          </span>
        </span>
      </div>

      <div className="mt-auto flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => onRunNow(schedule)}
          disabled={running}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg-muted',
            'transition-colors hover:border-amber-400/50 hover:text-amber-300',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          {running ? (
            <Spinner className="h-3.5 w-3.5" label="Running" />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Run now
        </button>

        <button
          type="button"
          onClick={() => onEdit(schedule)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg-muted',
            'transition-colors hover:border-ink-600 hover:text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </button>

        <button
          type="button"
          onClick={() => onDelete(schedule)}
          aria-label={`Delete ${schedule.name}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg-muted',
            'transition-colors hover:border-status-blocked/50 hover:text-status-blocked',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </button>
      </div>
    </Panel>
  )
}
