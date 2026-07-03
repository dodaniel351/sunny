import { useEffect, useState } from 'react'
import { HeartbeatDot } from '@renderer/components/ui/HeartbeatDot'
import { heartbeatState } from '@renderer/lib/agentStatus'
import type { AgentOrgNode } from '@shared/ipc/contract'

/** Poll interval for the live agent roster. */
const POLL_MS = 6_000

const STATUS_LABEL = {
  working: 'Working',
  idle: 'Idle',
  paused: 'Paused',
  retired: 'Retired'
} as const

/**
 * A live quick-view of every agent and what it's doing right now (structure
 * layer) — shown above the Activity feed. Each agent shows a heartbeat, a status,
 * and the task it currently holds. Polls `agents.orgChart()` so it stays current.
 */
export function AgentStatusPanel(): JSX.Element | null {
  const [agents, setAgents] = useState<AgentOrgNode[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const list = await window.sunny.agents.orgChart()
        if (!cancelled) {
          setAgents(list)
          setLoaded(true)
        }
      } catch {
        if (!cancelled) setLoaded(true)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!loaded || agents.length === 0) return null

  const workingCount = agents.filter((a) => heartbeatState(a) === 'working').length

  return (
    <section className="mt-6 rounded-2xl border border-ink-700 bg-ink-850 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-fg-heading">Agents</h2>
        <span className="text-[11px] text-fg-subtle">
          {workingCount > 0 ? `${workingCount} working now` : 'All idle'}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => {
          const state = heartbeatState(agent)
          return (
            <li
              key={agent.id}
              className="flex items-center gap-2.5 rounded-xl border border-ink-700/70 bg-ink-900 px-3 py-2"
            >
              <HeartbeatDot state={state} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-fg">{agent.name}</span>
                  <span className="shrink-0 text-[11px] text-fg-subtle">{STATUS_LABEL[state]}</span>
                </div>
                <p className="truncate text-xs text-fg-muted" title={agent.current_task_title ?? ''}>
                  {agent.current_task_title ?? agent.title ?? agent.role ?? '—'}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
