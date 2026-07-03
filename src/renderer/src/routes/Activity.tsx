import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowRightLeft,
  CheckCheck,
  CheckCircle2,
  Hand,
  Play,
  Plus,
  RefreshCw,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AgentStatusPanel } from '@renderer/components/activity/AgentStatusPanel'
import { ReviewModal } from '@renderer/components/activity/ReviewModal'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import { useActivity } from '@renderer/hooks/useActivity'
import { useUiStore } from '@renderer/store/uiStore'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'
import type { ActivityEvent } from '@shared/db/types'

// Feed filters → the activity `kind`s each includes.
const FILTERS = [
  { key: 'all', label: 'All', kinds: undefined as string[] | undefined },
  { key: 'tasks', label: 'Tasks', kinds: ['task.created', 'task.moved', 'task.claimed'] },
  { key: 'runs', label: 'Runs', kinds: ['run.started', 'run.finished', 'run.failed'] },
  // The durable tool-call audit trail: every file/shell/board/MCP/web tool an
  // agent executed, with args + result previews in the payload.
  { key: 'tools', label: 'Tools', kinds: ['tool.executed'] },
  {
    key: 'approvals',
    label: 'Approvals',
    kinds: [
      'approval.requested',
      'approval.approved',
      'approval.rejected',
      'task.awaiting_approval',
      'schedule.disabled'
    ]
  }
] as const

type FilterKey = (typeof FILTERS)[number]['key']

// Visual treatment per event kind: an icon + a semantic color. Keyed by exact
// kind, with a neutral fallback so an unknown future kind still renders.
const KIND_STYLE: Record<string, { icon: LucideIcon; className: string }> = {
  'task.created': { icon: Plus, className: 'bg-status-info/15 text-status-info' },
  'task.moved': { icon: ArrowRightLeft, className: 'bg-status-info/15 text-status-info' },
  'task.claimed': { icon: Hand, className: 'bg-amber-400/15 text-amber-300' },
  'task.awaiting_approval': { icon: Hand, className: 'bg-amber-400/15 text-amber-300' },
  'run.started': { icon: Play, className: 'bg-status-queued/15 text-status-queued' },
  'run.finished': { icon: CheckCircle2, className: 'bg-status-success/15 text-status-success' },
  'run.failed': { icon: AlertTriangle, className: 'bg-status-blocked/15 text-status-blocked' },
  'approval.requested': { icon: Hand, className: 'bg-amber-400/15 text-amber-300' },
  'approval.approved': { icon: CheckCircle2, className: 'bg-status-success/15 text-status-success' },
  'approval.rejected': { icon: AlertTriangle, className: 'bg-status-blocked/15 text-status-blocked' },
  // Scheduler circuit breaker (auto-disabled after repeated failures).
  'schedule.disabled': { icon: AlertTriangle, className: 'bg-status-blocked/15 text-status-blocked' },
  // Durable tool-call audit trail (what an agent actually executed).
  'tool.executed': { icon: Wrench, className: 'bg-status-info/15 text-status-info' }
}

const FALLBACK_STYLE = { icon: ActivityIcon, className: 'bg-ink-700 text-fg-muted' }

/** Pull a linked chat id out of an event's payload, when present (completions). */
function chatIdOf(event: ActivityEvent): string | null {
  if (!event.payload) return null
  try {
    const parsed = JSON.parse(event.payload) as { chatId?: unknown }
    return typeof parsed.chatId === 'string' ? parsed.chatId : null
  } catch {
    return null
  }
}

/** Pull the denormalized `summary` out of an event's JSON payload, else show the kind. */
function summaryOf(event: ActivityEvent): string {
  if (event.payload) {
    try {
      const parsed = JSON.parse(event.payload) as { summary?: unknown }
      if (typeof parsed.summary === 'string' && parsed.summary.length > 0) return parsed.summary
    } catch {
      // fall through to the raw kind
    }
  }
  return event.kind
}

/**
 * Activity (structure layer) — the durable, immutable audit feed. Every board
 * transition, heartbeat run, and (in later phases) cost/approval event lands
 * here. Filterable by kind; refreshes on a light interval and on demand.
 */
export function Activity(): JSX.Element {
  const [filter, setFilter] = useState<FilterKey>('all')
  const activeKinds = useMemo(() => FILTERS.find((f) => f.key === filter)?.kinds, [filter])
  const { events, loading, error, refresh } = useActivity(activeKinds)
  const [refreshing, setRefreshing] = useState(false)
  const navigate = useNavigate()
  const setUnseenActivityCount = useUiStore((s) => s.setUnseenActivityCount)
  // The completed item being reviewed in the report modal (its work chat id).
  const [reviewChatId, setReviewChatId] = useState<string | null>(null)
  // The reviewed event's task, so the ReviewModal can offer "Request changes".
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)

  // Opening Activity marks everything seen: stamp the watermark (so the rail
  // badge resets to "new since now") and clear the count immediately.
  useEffect(() => {
    void window.sunny.activity.markSeen()
    setUnseenActivityCount(0)
  }, [setUnseenActivityCount])

  async function handleMarkRead(): Promise<void> {
    await window.sunny.activity.markSeen()
    setUnseenActivityCount(0)
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <PageHeader
        title="Activity"
        description="A durable, immutable log of everything Sunny's agents do — board transitions, heartbeat runs, and (soon) cost and approval events."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleMarkRead()}
              className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <CheckCheck className="h-4 w-4" aria-hidden="true" />
              Mark all read
            </button>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              aria-label="Refresh"
              className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} aria-hidden="true" />
            </button>
          </div>
        }
      />

      <AgentStatusPanel />

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Filter activity">
        {FILTERS.map((f) => {
          const on = f.key === filter
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                on
                  ? 'border-amber-400/35 bg-amber-400/15 text-amber-300'
                  : 'border-ink-700 bg-ink-850 text-fg-muted hover:text-fg'
              )}
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-status-blocked/40 bg-status-blocked/5 px-4 py-3 text-sm text-status-blocked"
        >
          Couldn&apos;t load activity: {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Spinner label="Loading activity" />
          Loading activity…
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={ActivityIcon}
          title="No activity yet"
          description="As agents claim tasks, run on the heartbeat, and move cards on the board, every step is recorded here as a durable, replayable audit trail."
          className="mt-8"
        />
      ) : (
        <ol className="mt-6 overflow-hidden rounded-2xl border border-ink-700 bg-ink-850">
          {events.map((event) => {
            const style = KIND_STYLE[event.kind] ?? FALLBACK_STYLE
            const Icon = style.icon
            const chatId = chatIdOf(event)
            const body = (
              <>
                <span
                  className={cn(
                    'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                    style.className
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg">{summaryOf(event)}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-fg-subtle">
                    {event.kind}
                    {chatId ? <span className="ml-2 text-amber-300/80">· open to review</span> : null}
                  </p>
                </div>
                <time
                  className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-fg-subtle"
                  dateTime={event.created_at}
                  title={new Date(event.created_at).toLocaleString()}
                >
                  {relativeTime(event.created_at)}
                </time>
              </>
            )
            return chatId ? (
              <li key={event.id} className="border-b border-ink-800 last:border-b-0">
                <button
                  type="button"
                  onClick={() => {
                    setReviewChatId(chatId)
                    setReviewTaskId(event.task_id)
                  }}
                  title="Open a report of the agent's result"
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-800/60 focus-visible:bg-ink-800/60 focus-visible:outline-none"
                >
                  {body}
                </button>
              </li>
            ) : (
              <li
                key={event.id}
                className="flex items-start gap-3 border-b border-ink-800 px-4 py-3 last:border-b-0"
              >
                {body}
              </li>
            )
          })}
        </ol>
      )}

      {reviewChatId ? (
        <ReviewModal
          chatId={reviewChatId}
          taskId={reviewTaskId}
          onClose={() => {
            setReviewChatId(null)
            setReviewTaskId(null)
          }}
          onOpenChat={(id) => {
            setReviewChatId(null)
            setReviewTaskId(null)
            navigate(`/chats/${id}`)
          }}
        />
      ) : null}
    </div>
  )
}
