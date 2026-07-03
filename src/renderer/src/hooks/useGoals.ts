import { useCallback, useEffect, useState } from 'react'
import { useUiStore } from '@renderer/store/uiStore'
import type { GoalsListResult } from '@shared/ipc/contract'
import type { Agent } from '@shared/db/types'

export interface UseGoalsResult {
  goals: GoalsListResult
  agents: Agent[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Load the objective/goal tree (with per-goal task rollups) scoped to the active
 * project, plus the agent library for owner names + the owner picker. Refreshes
 * on mount, on project switch, and on demand after create/edit/delete.
 */
export function useGoals(): UseGoalsResult {
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const [goals, setGoals] = useState<GoalsListResult>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [goalList, agentList] = await Promise.all([
        window.sunny.goals.list({ projectId: activeProjectId ?? undefined }),
        window.sunny.agents.list()
      ])
      setGoals(goalList)
      setAgents(agentList)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load objectives.')
    }
  }, [activeProjectId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

  return { goals, agents, loading, error, refresh }
}
