import { useCallback, useEffect, useState } from 'react'
import { useUiStore } from '@renderer/store/uiStore'
import type { ActivityEvent } from '@shared/db/types'

/** How often the feed refreshes itself so it stays live without a reload. */
const POLL_MS = 10_000

export interface UseActivityResult {
  events: ActivityEvent[]
  loading: boolean
  error: string | null
  /** Re-fetch immediately (e.g. the Refresh button). */
  refresh: () => Promise<void>
}

/**
 * Load the durable activity feed (structure layer), scoped to the active
 * project and an optional set of `kind`s. Refreshes on mount, whenever the
 * filters change, and on a light interval so new heartbeat/board events appear
 * without a manual reload. Opening the view also clears the rail's unseen badge.
 */
export function useActivity(kinds?: readonly string[], limit = 100): UseActivityResult {
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setUnseenActivityCount = useUiStore((s) => s.setUnseenActivityCount)

  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Serialize `kinds` so the effect/refresh dependency is stable by value, not
  // by array identity (a new array every render would loop the effect).
  const kindsKey = kinds && kinds.length > 0 ? kinds.join(',') : ''

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await window.sunny.activity.list({
        limit,
        kinds: kindsKey ? kindsKey.split(',') : undefined,
        projectId: activeProjectId ?? undefined
      })
      setEvents(list)
      setError(null)
      // Seeing the feed marks everything as read.
      setUnseenActivityCount(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity.')
    }
  }, [activeProjectId, kindsKey, limit, setUnseenActivityCount])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })

    const timer = setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  return { events, loading, error, refresh }
}
