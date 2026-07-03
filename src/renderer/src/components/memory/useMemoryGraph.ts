import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryScope } from '@shared/db/types'
import type { MemoryGraphResult, MemoryStatusResult } from '@shared/ipc/contract'

interface UseMemoryGraphArgs {
  /** Active scope filter; undefined means "All" (the param is omitted). */
  scope?: MemoryScope
  /** Active project scope; undefined means "All Projects" (the param is omitted). */
  projectId?: string
  /** When false the hook stays idle — avoids fetching the graph until shown. */
  enabled: boolean
}

interface UseMemoryGraphResult {
  graph: MemoryGraphResult
  status: MemoryStatusResult | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Flip the auto-memory toggle; optimistic, reverts on failure. */
  setAuto: (enabled: boolean) => Promise<void>
}

const EMPTY_GRAPH: MemoryGraphResult = { entities: [], relations: [] }

// Cap nodes so the SVG sim stays smooth; spec targets ~200.
const GRAPH_LIMIT = 200

/**
 * Owns the knowledge-graph view's data: fetches the graph (entities + relations)
 * and the memory status (counts, embeddings, auto toggle) together, refreshing
 * when the scope or project changes or the view becomes enabled. A request token
 * guards against out-of-order responses. `setAuto` updates optimistically and
 * rolls back if the IPC call rejects.
 */
export function useMemoryGraph({
  scope,
  projectId,
  enabled
}: UseMemoryGraphArgs): UseMemoryGraphResult {
  const [graph, setGraph] = useState<MemoryGraphResult>(EMPTY_GRAPH)
  const [status, setStatus] = useState<MemoryStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const token = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const [nextGraph, nextStatus] = await Promise.all([
        window.sunny.memories.graph({
          ...(scope ? { scope } : {}),
          ...(projectId ? { projectId } : {}),
          limit: GRAPH_LIMIT
        }),
        window.sunny.memories.status()
      ])
      if (token !== requestId.current) return
      setGraph(nextGraph)
      setStatus(nextStatus)
    } catch (err: unknown) {
      if (token !== requestId.current) return
      setError(err instanceof Error ? err.message : 'Could not load the knowledge graph.')
      setGraph(EMPTY_GRAPH)
    } finally {
      if (token === requestId.current) setLoading(false)
    }
  }, [scope, projectId])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load])

  const setAuto = useCallback(async (next: boolean): Promise<void> => {
    setStatus((prev) => (prev ? { ...prev, autoMemory: next } : prev))
    try {
      await window.sunny.memories.setAuto({ enabled: next })
    } catch {
      // Revert the optimistic flip on failure.
      setStatus((prev) => (prev ? { ...prev, autoMemory: !next } : prev))
    }
  }, [])

  return { graph, status, loading, error, refresh: load, setAuto }
}
