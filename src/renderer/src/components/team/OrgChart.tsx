import { TeamCard } from './TeamCard'
import type { OrgTreeNode } from '@renderer/lib/orgTree'
import type { AgentLifecycle } from '@shared/db/types'
import type { AgentOrgNode } from '@shared/ipc/contract'

interface OrgChartProps {
  forest: OrgTreeNode<AgentOrgNode>[]
  /** All agents — the options for each card's reports-to selector. */
  agents: AgentOrgNode[]
  onSetManager: (id: string, managerId: string | null) => void
  onSetTitle: (id: string, title: string) => void
  onSetLifecycle: (id: string, state: AgentLifecycle) => void
}

/**
 * The Team as a top-down org chart (structure layer, Phase 5). Renders the same
 * cycle-safe forest as the list view, but laid out hierarchically with connector
 * lines (see `.org-tree` in index.css). Reuses `TeamCard`, so every node keeps
 * its heartbeat, reports-to selector, and lifecycle controls. Wide trees scroll
 * horizontally; small ones center.
 */
export function OrgChart({
  forest,
  agents,
  onSetManager,
  onSetTitle,
  onSetLifecycle
}: OrgChartProps): JSX.Element {
  const renderNode = (n: OrgTreeNode<AgentOrgNode>): JSX.Element => (
    <li key={n.node.id}>
      <div className="w-72">
        <TeamCard
          node={n.node}
          agents={agents}
          onSetManager={onSetManager}
          onSetTitle={onSetTitle}
          onSetLifecycle={onSetLifecycle}
        />
      </div>
      {n.children.length > 0 ? <ul>{n.children.map(renderNode)}</ul> : null}
    </li>
  )

  return (
    <div className="overflow-x-auto pb-4">
      <div className="org-tree mx-auto w-max px-4">
        <ul>{forest.map(renderNode)}</ul>
      </div>
    </div>
  )
}
