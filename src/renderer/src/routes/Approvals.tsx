import { Check, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import { useApprovals } from '@renderer/hooks/useApprovals'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'
import type { ApprovalView } from '@shared/ipc/contract'

/** "tool:write_file" → "write_file" for the gate chip. */
function gateLabel(gate: string): string {
  return gate.startsWith('tool:') ? gate.slice('tool:'.length) : gate
}

/**
 * Approvals (structure layer, governance) — the inbox of gates the autonomous
 * worker raised before a side-effecting action shipped. Approving re-queues the
 * parked task so the agent re-runs and proceeds; rejecting leaves it blocked.
 * Interactive chats are unaffected — they confirm inline, never here.
 */
export function Approvals(): JSX.Element {
  const { approvals, loading, error, refresh, decide } = useApprovals()
  const [refreshing, setRefreshing] = useState(false)
  // The gate currently being decided (disables its buttons), plus a per-row error.
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [decideError, setDecideError] = useState<string | null>(null)

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  async function handleDecide(id: string, decision: 'approved' | 'rejected'): Promise<void> {
    setDecidingId(id)
    setDecideError(null)
    try {
      await decide(id, decision)
    } catch (err) {
      setDecideError(err instanceof Error ? err.message : 'Failed to record the decision.')
    } finally {
      setDecidingId(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <PageHeader
        title="Approvals"
        description="When an agent needs to take a risky action while running unattended, it pauses here for your decision. Approve to let it proceed; reject to keep it blocked."
        actions={
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} aria-hidden="true" />
            Refresh
          </button>
        }
      />

      {error ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-status-blocked/40 bg-status-blocked/5 px-4 py-3 text-sm text-status-blocked"
        >
          Couldn&apos;t load approvals: {error}
        </div>
      ) : null}

      {decideError ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-status-blocked/40 bg-status-blocked/5 px-4 py-3 text-sm text-status-blocked"
        >
          {decideError}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Spinner label="Loading approvals" />
          Loading approvals…
        </div>
      ) : approvals.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No pending approvals"
          description="You're all clear. When an unattended agent hits an action its permission mode gates — a write, a command, anything risky — it'll wait here for your go-ahead."
          className="mt-8"
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {approvals.map((a) => (
            <ApprovalRow
              key={a.id}
              approval={a}
              deciding={decidingId === a.id}
              onApprove={() => void handleDecide(a.id, 'approved')}
              onReject={() => void handleDecide(a.id, 'rejected')}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface ApprovalRowProps {
  approval: ApprovalView
  deciding: boolean
  onApprove: () => void
  onReject: () => void
}

function ApprovalRow({ approval, deciding, onApprove, onReject }: ApprovalRowProps): JSX.Element {
  return (
    <li className="rounded-2xl border border-ink-700 bg-ink-850 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-amber-400/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-300">
          {gateLabel(approval.gate)}
        </span>
        {approval.agent_name ? (
          <span className="text-xs text-fg-muted">
            <span className="text-fg">{approval.agent_name}</span>
            {approval.task_title ? (
              <>
                {' · '}
                <span title={approval.task_title}>{approval.task_title}</span>
              </>
            ) : null}
          </span>
        ) : null}
        <time
          className="ml-auto shrink-0 whitespace-nowrap text-[11px] tabular-nums text-fg-subtle"
          dateTime={approval.created_at}
          title={new Date(approval.created_at).toLocaleString()}
        >
          {relativeTime(approval.created_at)}
        </time>
      </div>

      <p className="mt-2 text-sm font-medium text-fg-heading">{approval.title}</p>
      {approval.detail ? (
        <p className="mt-1 break-words font-mono text-xs text-fg-muted">{approval.detail}</p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={deciding}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg bg-status-success/15 px-3 py-1.5 text-xs font-semibold text-status-success',
            'transition-colors hover:bg-status-success/25 disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-success/50'
          )}
        >
          {deciding ? (
            <Spinner className="h-3.5 w-3.5" label="Deciding" />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Approve
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={deciding}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-semibold text-fg-muted',
            'transition-colors hover:border-status-blocked/50 hover:text-status-blocked disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Reject
        </button>
      </div>
    </li>
  )
}
