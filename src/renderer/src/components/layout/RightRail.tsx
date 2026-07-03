import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  ListTodo,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TaskActivityItem } from '@shared/ipc/contract'
import type { TaskStatus } from '@shared/db/types'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'

/** How many recent transitions to show, and how often to refresh them. */
const ACTIVITY_LIMIT = 12
const POLL_MS = 6000

/** Presentation tokens derived from a transition's destination status. */
interface StatusLook {
  label: string
  icon: LucideIcon
  /** Left accent border tint (reuses the board's status colors). */
  accent: string
  /** Icon tint. */
  iconColor: string
}

/**
 * Map a `to_status` onto the activity card's label/icon/colour. Backlog &
 * Planned collapse to "Queued"; In Progress → "Working"; the rest map 1:1. The
 * accent tints match `components/board/columns.ts` so the rail stays on-theme.
 */
const statusLook: Record<TaskStatus, StatusLook> = {
  Backlog: {
    label: 'Queued',
    icon: ListTodo,
    accent: 'border-l-status-queued',
    iconColor: 'text-status-queued'
  },
  Planned: {
    label: 'Queued',
    icon: ListTodo,
    accent: 'border-l-status-queued',
    iconColor: 'text-status-queued'
  },
  'In Progress': {
    label: 'Working',
    icon: Loader2,
    accent: 'border-l-status-working',
    iconColor: 'text-status-working'
  },
  Blocked: {
    label: 'Blocked',
    icon: AlertTriangle,
    accent: 'border-l-status-blocked',
    iconColor: 'text-status-blocked'
  },
  Done: {
    label: 'Done',
    icon: CheckCircle2,
    accent: 'border-l-status-success',
    iconColor: 'text-status-success'
  }
}

/** Friendly actor label: 'user' → "by you", any other name → "by <name>". */
function actorLabel(actor: string | null): string | null {
  if (!actor) return null
  if (actor === 'user') return 'by you'
  return `by ${actor}`
}

/** A single activity card with a colored left accent border. */
function ActivityCard({
  item,
  onOpenChat
}: {
  item: TaskActivityItem
  onOpenChat: (chatId: string) => void
}): JSX.Element {
  const look = statusLook[item.to_status]
  const Icon = look.icon
  const who = actorLabel(item.actor)
  const clickable = item.chat_id !== null
  // Animate only when the task is CURRENTLY in progress — a finished task's
  // historical 'In Progress' event must never keep spinning.
  const live = item.task_status === 'In Progress'

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-fg-heading">
          <Icon
            className={cn('h-3.5 w-3.5', look.iconColor, live && 'animate-spin')}
            aria-hidden="true"
          />
          {look.label}
        </span>
        <span className="shrink-0 text-xs text-fg-subtle">{relativeTime(item.created_at)}</span>
      </div>

      <p className="mt-1 line-clamp-2 text-sm leading-snug text-fg-muted">{item.task_title}</p>

      {who ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-fg-subtle">{who}</span>
          {live ? (
            <span className="flex items-center gap-1.5" aria-hidden="true">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse-glow" />
              <span className="h-1.5 w-1.5 rounded-full bg-ink-600" />
              <span className="h-1.5 w-1.5 rounded-full bg-ink-600" />
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  )

  const baseClass = cn(
    'block rounded-r-lg border-l-2 bg-ink-850/40 py-2.5 pl-3.5 pr-2',
    look.accent
  )

  if (clickable) {
    return (
      <button
        type="button"
        onClick={() => onOpenChat(item.chat_id as string)}
        className={cn(
          baseClass,
          'w-full text-left transition-colors hover:bg-ink-850/70',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
        )}
      >
        {body}
      </button>
    )
  }

  return <article className={baseClass}>{body}</article>
}

/** Right rail: pulsing header + live activity feed + pinned task-history button. */
export function RightRail(): JSX.Element {
  const navigate = useNavigate()
  const [items, setItems] = useState<TaskActivityItem[]>([])
  const [loaded, setLoaded] = useState(false)

  // Load on mount, then poll every ~6s. We ignore late responses after unmount
  // and clear the interval so the rail never updates a torn-down component.
  useEffect(() => {
    let active = true

    async function refresh(): Promise<void> {
      try {
        const next = await window.sunny.tasks.activity({ limit: ACTIVITY_LIMIT })
        if (active) setItems(next)
      } catch {
        // Transient IPC errors are non-fatal; keep the last good feed.
      } finally {
        if (active) setLoaded(true)
      }
    }

    void refresh()
    const handle = window.setInterval(() => void refresh(), POLL_MS)
    return () => {
      active = false
      window.clearInterval(handle)
    }
  }, [])

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-ink-700/60 bg-ink-900">
      <div className="flex items-center justify-between px-5 pb-4 pt-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-fg-heading">
          Live Activity
        </h2>
        <span
          className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-glow animate-pulse-glow"
          aria-label="Live"
        />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-4">
        {loaded && items.length === 0 ? (
          <p className="px-1 pt-2 text-sm leading-relaxed text-fg-subtle">
            No agent activity yet — work a task on the board.
          </p>
        ) : (
          items.map((item) => (
            <ActivityCard
              key={item.id}
              item={item}
              onOpenChat={(chatId) => navigate(`/chats/${chatId}`)}
            />
          ))
        )}
      </div>

      <div className="border-t border-ink-700/60 p-4">
        <button
          type="button"
          onClick={() => navigate('/board')}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-4 py-2.5 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <History className="h-4 w-4" aria-hidden="true" />
          Open Board
        </button>
      </div>
    </aside>
  )
}
