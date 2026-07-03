import { useEffect } from 'react'
import { useUiStore } from '@renderer/store/uiStore'

/** Background poll interval for the rail's pending-approvals badge. */
const POLL_MS = 15_000

/**
 * Keep the rail's pending-approvals badge live no matter the current route, so a
 * gate raised by the worker shows up even while the user is on the Board or in a
 * chat. Mounted once in AppShell. Best-effort: transient failures are ignored,
 * and the Approvals view's own hook keeps the count exact while it's open.
 */
export function useApprovalsBadge(): void {
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setPendingApprovalsCount = useUiStore((s) => s.setPendingApprovalsCount)

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const { count } = await window.sunny.approvals.pendingCount({
          projectId: activeProjectId ?? undefined
        })
        if (!cancelled) setPendingApprovalsCount(count)
      } catch {
        // Best-effort badge — ignore transient IPC failures.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeProjectId, setPendingApprovalsCount])
}
