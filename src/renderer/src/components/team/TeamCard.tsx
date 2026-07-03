import { Ban, Pause, Play } from 'lucide-react'
import { useState } from 'react'
import { HeartbeatDot } from '@renderer/components/ui/HeartbeatDot'
import { heartbeatState } from '@renderer/lib/agentStatus'
import { cn } from '@renderer/lib/cn'
import type { AgentLifecycle } from '@shared/db/types'
import type { AgentOrgNode } from '@shared/ipc/contract'

// A small, stable palette for agent avatars (keyed off the id).
const AVATAR = [
  'bg-amber-400/20 text-amber-200',
  'bg-status-info/20 text-status-info',
  'bg-status-success/20 text-status-success',
  'bg-status-queued/20 text-status-queued'
]

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR[h % AVATAR.length]
}

const ctrlBtn =
  'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'

interface TeamCardProps {
  node: AgentOrgNode
  /** All agents — the options for the reports-to selector. */
  agents: AgentOrgNode[]
  onSetManager: (id: string, managerId: string | null) => void
  onSetTitle: (id: string, title: string) => void
  onSetLifecycle: (id: string, state: AgentLifecycle) => void
}

/**
 * One agent node in the Team tree (structure layer, Phase 5): avatar, name, an
 * editable org title, a live HeartbeatDot, the task it's currently working, a
 * reports-to selector (sets the reporting line), and lifecycle controls.
 */
export function TeamCard({
  node,
  agents,
  onSetManager,
  onSetTitle,
  onSetLifecycle
}: TeamCardProps): JSX.Element {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const state = heartbeatState(node)

  function beginEdit(): void {
    setTitleDraft(node.title ?? '')
    setEditingTitle(true)
  }
  function saveTitle(): void {
    const next = titleDraft.trim()
    if (next !== (node.title ?? '')) onSetTitle(node.id, next)
    setEditingTitle(false)
  }

  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-850 p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold',
            avatarColor(node.id)
          )}
          aria-hidden="true"
        >
          {initials(node.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-bold text-fg-heading">{node.name}</h3>
            <HeartbeatDot state={state} showLabel />
          </div>
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  saveTitle()
                } else if (e.key === 'Escape') {
                  setEditingTitle(false)
                }
              }}
              placeholder="Title (e.g. Research lead)"
              aria-label={`Title for ${node.name}`}
              className="mt-1 w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-fg placeholder:text-fg-subtle/70 focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            />
          ) : (
            <button
              type="button"
              onClick={beginEdit}
              title="Edit title"
              className="mt-0.5 block max-w-full truncate text-left text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              {node.title ?? node.role ?? 'Set a title…'}
            </button>
          )}
        </div>
      </div>

      {node.current_task_title ? (
        <p
          className="mt-3 truncate rounded-lg bg-ink-900 px-2.5 py-1.5 text-xs text-fg-muted"
          title={node.current_task_title}
        >
          <span className="text-fg-subtle">Working: </span>
          {node.current_task_title}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
          Reports to
          <select
            value={node.manager_id ?? ''}
            onChange={(e) => onSetManager(node.id, e.target.value || null)}
            aria-label={`Manager for ${node.name}`}
            className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-fg focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
          >
            <option value="">— No manager (lead)</option>
            {agents
              .filter((a) => a.id !== node.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>

        {node.lifecycle_state === 'active' ? (
          <button
            type="button"
            onClick={() => onSetLifecycle(node.id, 'paused')}
            className={ctrlBtn}
          >
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            Pause
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSetLifecycle(node.id, 'active')}
            className={ctrlBtn}
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            Resume
          </button>
        )}
        {node.lifecycle_state !== 'terminated' ? (
          <button
            type="button"
            onClick={() => onSetLifecycle(node.id, 'terminated')}
            className={ctrlBtn}
          >
            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            Retire
          </button>
        ) : null}
      </div>
    </div>
  )
}
