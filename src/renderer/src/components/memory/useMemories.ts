import { useCallback, useEffect, useRef, useState } from 'react'
import type { Memory, MemoryScope } from '@shared/db/types'
import type { MemoryCreateParams, MemoryUpdateParams } from '@shared/ipc/contract'

interface UseMemoriesArgs {
  /** Active scope filter; undefined means "All" (the param is omitted). */
  scope?: MemoryScope
  /** Debounced free-text query; empty means "no query". */
  query: string
  /** Active project scope; undefined means "All Projects" (the param is omitted). */
  projectId?: string
}

interface UseMemoriesResult {
  memories: Memory[]
  /** True until the first list call resolves (drives the initial skeleton). */
  loading: boolean
  /** Set if the most recent list call rejected. */
  error: string | null
  refresh: () => Promise<void>
  create: (params: MemoryCreateParams) => Promise<void>
  update: (params: MemoryUpdateParams) => Promise<void>
  remove: (id: string) => Promise<void>
}

/**
 * Owns the Memory route's data: lists with the current scope/query/project,
 * exposes the CRUD mutations, and refreshes after each one. Re-fetches whenever
 * scope, project, or the (already-debounced) query change. A request token guards
 * against out-of-order responses so a slow earlier query can't clobber a newer
 * result set.
 */
export function useMemories({ scope, query, projectId }: UseMemoriesArgs): UseMemoriesResult {
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const token = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      const trimmed = query.trim()
      const next = await window.sunny.memories.list({
        ...(scope ? { scope } : {}),
        ...(trimmed ? { query: trimmed } : {}),
        ...(projectId ? { projectId } : {})
      })
      if (token !== requestId.current) return
      setMemories(next)
    } catch (err: unknown) {
      if (token !== requestId.current) return
      setError(err instanceof Error ? err.message : 'Could not load memories.')
      setMemories([])
    } finally {
      if (token === requestId.current) setLoading(false)
    }
  }, [scope, query, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const create = useCallback(
    async (params: MemoryCreateParams): Promise<void> => {
      await window.sunny.memories.create(params)
      await load()
    },
    [load]
  )

  const update = useCallback(
    async (params: MemoryUpdateParams): Promise<void> => {
      await window.sunny.memories.update(params)
      await load()
    },
    [load]
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await window.sunny.memories.delete({ id })
      await load()
    },
    [load]
  )

  return { memories, loading, error, refresh: load, create, update, remove }
}
