import { Ban, Copy, Cpu, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { Panel } from '@renderer/components/ui/Panel'
import { useUiStore } from '@renderer/store/uiStore'
import { cn } from '@renderer/lib/cn'
import type { Agent, AgentLifecycle } from '@shared/db/types'
import { Badge, PermissionBadge } from './AgentBadge'

interface AgentCardProps {
  agent: Agent
  onEdit: (agent: Agent) => void
  onDuplicate: (agent: Agent) => void
  onDelete: (agent: Agent) => void
  /** Pause/resume/terminate the agent (governance lifecycle, structure layer). */
  onSetLifecycle: (agent: Agent, state: AgentLifecycle) => void
}

const ctrlBtn =
  'inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'

/** A single agent card in the library grid (spec §7). */
export function AgentCard({
  agent,
  onEdit,
  onDuplicate,
  onDelete,
  onSetLifecycle
}: AgentCardProps): JSX.Element {
  const providers = useUiStore((s) => s.providers)
  const isPreset = agent.is_preset === 1
  const lifecycle = agent.lifecycle_state

  // Resolve human labels for the agent's default provider/model when set.
  const modelLabel = useMemo(() => {
    if (!agent.provider && !agent.model) return null
    const provider = providers.find((p) => p.kind === agent.provider)
    const providerLabel = provider?.label ?? agent.provider
    const modelName =
      provider?.models.find((m) => m.id === agent.model)?.label ?? agent.model ?? null
    if (providerLabel && modelName) return `${providerLabel} · ${modelName}`
    return modelName ?? providerLabel ?? null
  }, [agent.provider, agent.model, providers])

  return (
    <Panel className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-bold text-fg-heading">{agent.name}</h3>
            {isPreset ? <Badge className="bg-amber-dim text-amber-300">Preset</Badge> : null}
            {lifecycle === 'paused' ? (
              <Badge className="bg-amber-400/15 text-amber-300">Paused</Badge>
            ) : null}
            {lifecycle === 'terminated' ? (
              <Badge className="bg-status-blocked/15 text-status-blocked">Retired</Badge>
            ) : null}
          </div>
          {agent.role ? (
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">
              {agent.role}
            </p>
          ) : null}
        </div>
        <PermissionBadge mode={agent.permission_mode} />
      </div>

      {agent.system_prompt ? (
        <p className="line-clamp-2 text-sm text-fg-muted">{agent.system_prompt}</p>
      ) : (
        <p className="text-sm text-fg-subtle">No system prompt set.</p>
      )}

      <div className="flex items-center gap-2 text-xs text-fg-subtle">
        <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{modelLabel ?? 'Global default model'}</span>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <button type="button" onClick={() => onEdit(agent)} className={ctrlBtn}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </button>

        {/* Governance lifecycle: a paused/terminated agent is skipped by the worker. */}
        {lifecycle === 'active' ? (
          <button
            type="button"
            onClick={() => onSetLifecycle(agent, 'paused')}
            aria-label={`Pause ${agent.name}`}
            className={ctrlBtn}
          >
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            Pause
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSetLifecycle(agent, 'active')}
            aria-label={`Resume ${agent.name}`}
            className={ctrlBtn}
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            Resume
          </button>
        )}
        {lifecycle !== 'terminated' ? (
          <button
            type="button"
            onClick={() => onSetLifecycle(agent, 'terminated')}
            aria-label={`Retire ${agent.name}`}
            className={ctrlBtn}
          >
            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            Retire
          </button>
        ) : null}

        {isPreset ? (
          <button type="button" onClick={() => onDuplicate(agent)} className={ctrlBtn}>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            Duplicate
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onDelete(agent)}
            aria-label={`Delete ${agent.name}`}
            className={cn(
              ctrlBtn,
              'hover:border-status-blocked/50 hover:text-status-blocked'
            )}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Delete
          </button>
        )}
      </div>
    </Panel>
  )
}
