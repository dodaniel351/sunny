import { useCallback, useEffect, useState } from 'react'
import { useUiStore } from '@renderer/store/uiStore'
import type { ApprovalView } from '@shared/ipc/contract'

/** How often the inbox refreshes so new gates appear without a reload. */
const POLL_MS = 8_000

export interface UseApprovalsResult {
  approvals: ApprovalView[]
  loading: boolean
  error: string | null
  /** Re-fetch immediately. */
  refresh: () => Promise<void>
  /** Approve or reject a gate, then refresh. */
  decide: (id: string, decision: 'approved' | 'rejected') => Promise<void>
}

/**
 * Load the pending approval inbox (structure layer, governance), scoped to the
 * active project. Refreshes on mount and on a light interval; each refresh also
 * updates the rail's pending-approvals badge. `decide` approves/rejects a gate
 * (the main process re-queues the parked task on approval) and re-fetches.
 */
export function useApprovals(): UseApprovalsResult {
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setPendingApprovalsCount = useUiStore((s) => s.setPendingApprovalsCount)

  const [approvals, setApprovals] = useState<ApprovalView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.sunny.approvals.list({
        status: 'pending',
        projectId: activeProjectId ?? undefined
      })
      setApprovals(list)
      setPendingApprovalsCount(list.length)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals.')
    }
  }, [activeProjectId, setPendingApprovalsCount])

  const decide = useCallback(
    async (id: string, decision: 'approved' | 'rejected'): Promise<void> => {
      await window.sunny.approvals.decide({ id, decision })
      await refresh()
    },
    [refresh]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  return { approvals, loading, error, refresh, decide }
}
