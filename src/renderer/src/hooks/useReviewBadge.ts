import { useEffect } from 'react'
import { useUiStore } from '@renderer/store/uiStore'

/** Background poll interval for the rail's "ready for review" badge. */
const POLL_MS = 15_000
/** Events that mean an agent produced something worth a look. */
const REVIEW_KINDS = ['run.finished', 'run.failed', 'task.awaiting_approval']

/**
 * Keep the rail's Activity badge live: the count of agent completions /
 * blocks / approval-waits since the user last opened Activity. Mounted once in
 * AppShell so a finish shows up even while the user is elsewhere. Best-effort —
 * the Activity view clears the count and bumps the watermark on open.
 */
export function useReviewBadge(): void {
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setUnseenActivityCount = useUiStore((s) => s.setUnseenActivityCount)

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        // The main process compares against the seen watermark and returns just
        // the integer — no row payloads, and the count is no longer capped at 100.
        const { count } = await window.sunny.activity.unseenCount({
          kinds: REVIEW_KINDS,
          projectId: activeProjectId ?? undefined
        })
        if (!cancelled) setUnseenActivityCount(count)
      } catch {
        // Best-effort badge — ignore transient failures.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [activeProjectId, setUnseenActivityCount])
}
