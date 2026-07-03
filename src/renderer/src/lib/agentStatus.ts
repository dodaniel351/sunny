import type { HeartbeatState } from '@renderer/components/ui/HeartbeatDot'
import type { AgentOrgNode } from '@shared/ipc/contract'

/**
 * Derive an agent's live heartbeat state (structure layer) from its lifecycle
 * and whether it currently holds a task. Shared by the Team view and the Activity
 * agent-status panel so both read the same rules.
 */
export function heartbeatState(node: AgentOrgNode): HeartbeatState {
  if (node.lifecycle_state === 'terminated') return 'retired'
  if (node.lifecycle_state === 'paused') return 'paused'
  return node.current_task_id ? 'working' : 'idle'
}
