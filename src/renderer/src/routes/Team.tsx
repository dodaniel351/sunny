import { LayoutList, Network, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import { OrgChart } from '@renderer/components/team/OrgChart'
import { TeamCard } from '@renderer/components/team/TeamCard'
import { useTasksChanged } from '@renderer/hooks/useTasksChanged'
import { buildOrgForest, type OrgTreeNode } from '@renderer/lib/orgTree'
import { cn } from '@renderer/lib/cn'
import type { AgentLifecycle } from '@shared/db/types'
import type { AgentOrgNode } from '@shared/ipc/contract'

// Backstop poll for heartbeats. The `tasks:changed` broadcast now drives instant
// updates when an agent claims/finishes a task, so this only needs to catch any
// drift the event stream misses — a longer interval keeps it cheap.
const POLL_MS = 20_000

type TeamView = 'list' | 'chart'

/**
 * Team (structure layer, Phase 5) — the agent reporting tree, viewable as an
 * indented list or a top-down org chart (toggle in the header). Each agent shows
 * a live heartbeat, the task it's currently working, a reports-to selector that
 * sets its place in the hierarchy, and pause/resume/retire controls. Delegation
 * spreads a lead's subtasks across the agents reporting to it.
 */
export function Team(): JSX.Element {
  const [nodes, setNodes] = useState<AgentOrgNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [view, setView] = useState<TeamView>('list')

  const reload = useCallback(async (): Promise<void> => {
    try {
      const list = await window.sunny.agents.orgChart()
      setNodes(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the team.')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void reload().finally(() => {
      if (!cancelled) setLoading(false)
    })
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [reload])

  // Instant heartbeat updates: a task claim/finish flips which task an agent is
  // working, so reload the tree on the same broadcast the board uses.
  useTasksChanged(() => void reload())

  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      await reload()
    } finally {
      setRefreshing(false)
    }
  }

  // Run a mutation, then reconcile from the server (any failure surfaces on the
  // next poll / reload — the tree is the source of truth).
  const mutate = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn()
      } finally {
        await reload()
      }
    },
    [reload]
  )

  const onSetManager = useCallback(
    (id: string, managerId: string | null): void => {
      void mutate(() => window.sunny.agents.update({ id, managerId }))
    },
    [mutate]
  )
  const onSetTitle = useCallback(
    (id: string, title: string): void => {
      void mutate(() => window.sunny.agents.update({ id, title: title || null }))
    },
    [mutate]
  )
  const onSetLifecycle = useCallback(
    (id: string, state: AgentLifecycle): void => {
      void mutate(() => window.sunny.agents.setLifecycle({ id, state }))
    },
    [mutate]
  )

  // One cycle-safe forest, shared by both views.
  const forest = useMemo(() => buildOrgForest(nodes), [nodes])

  function renderListNode(n: OrgTreeNode<AgentOrgNode>, depth: number): JSX.Element {
    return (
      <div key={n.node.id} className={cn(depth > 0 && 'border-l border-ink-700/60 pl-4')}>
        <TeamCard
          node={n.node}
          agents={nodes}
          onSetManager={onSetManager}
          onSetTitle={onSetTitle}
          onSetLifecycle={onSetLifecycle}
        />
        {n.children.length > 0 ? (
          <div className="mt-3 space-y-3 pl-4">
            {n.children.map((c) => renderListNode(c, depth + 1))}
          </div>
        ) : null}
      </div>
    )
  }

  const toggleBtn = (key: TeamView, label: string, Icon: typeof Network): JSX.Element => {
    const on = view === key
    return (
      <button
        type="button"
        onClick={() => setView(key)}
        aria-pressed={on}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
          on ? 'bg-amber-400/15 text-amber-300' : 'text-fg-muted hover:text-fg'
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
    )
  }

  // The header + list stay at a readable column width; the org chart uses the
  // FULL screen width (capped generously for ultrawide) so more of the tree is
  // visible before it has to scroll. `readable` centers a block at that width.
  const readable = 'mx-auto w-full max-w-5xl'

  return (
    <div className="w-full px-6 py-10 lg:px-10">
      <div className={readable}>
        <PageHeader
          title="Team"
          description="Your agents as a reporting tree. Set who reports to whom, watch live heartbeats, and pause an agent to keep the worker from running it. A lead's delegated work spreads across the agents reporting to it."
          actions={
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border border-ink-700 bg-ink-850 p-1">
                {toggleBtn('list', 'List', LayoutList)}
                {toggleBtn('chart', 'Org chart', Network)}
              </div>
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                aria-label="Refresh"
                className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                <RefreshCw
                  className={cn('h-4 w-4', refreshing && 'animate-spin')}
                  aria-hidden="true"
                />
              </button>
            </div>
          }
        />

        {error ? (
          <div
            role="alert"
            className="mt-6 rounded-2xl border border-status-blocked/40 bg-status-blocked/5 px-4 py-3 text-sm text-status-blocked"
          >
            Couldn&apos;t load the team: {error}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Spinner label="Loading team" />
          Loading team…
        </div>
      ) : nodes.length === 0 ? (
        <div className={readable}>
          <EmptyState
            icon={Network}
            title="No agents yet"
            description="Create agents in the Agents library, then set their reporting lines here to build a team."
            className="mt-8"
          />
        </div>
      ) : view === 'chart' ? (
        <div className="mt-6 w-full">
          <OrgChart
            forest={forest}
            agents={nodes}
            onSetManager={onSetManager}
            onSetTitle={onSetTitle}
            onSetLifecycle={onSetLifecycle}
          />
        </div>
      ) : (
        <div className={cn(readable, 'mt-6 space-y-3')}>
          {forest.map((r) => renderListNode(r, 0))}
        </div>
      )}
    </div>
  )
}
