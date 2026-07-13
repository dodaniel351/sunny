import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { agentPresets } from '@renderer/data/agentPresets'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'
import { isUsableProvider } from '@renderer/lib/providers'
import type { Agent } from '@shared/db/types'

/**
 * Row of five preset agent cards (spec §7). Clicking a card looks up the
 * matching agent (by name), starts a new chat configured for that agent's
 * default provider/model (falling back to the composer's current selection),
 * reflects that selection in the UI store, and navigates to the chat view.
 */
export function AgentPresetRow(): JSX.Element {
  const navigate = useNavigate()
  const selectedProvider = useUiStore((s) => s.selectedProvider)
  const selectedModel = useUiStore((s) => s.selectedModel)
  const setSelectedModel = useUiStore((s) => s.setSelectedModel)
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  // A preset chat is only useful once a provider is connected — otherwise it
  // drops the user into a chat whose composer is disabled ("Connect a
  // provider"), a dead end. Mirror the composer's own gate.
  const hasConnected = useUiStore((s) => s.providers.some(isUsableProvider))

  const [agents, setAgents] = useState<Agent[]>([])
  const [launching, setLaunching] = useState<string | null>(null)

  // Load the agents once so each preset can resolve to its configuration.
  useEffect(() => {
    let cancelled = false
    window.sunny.agents
      .list()
      .then((list) => {
        if (!cancelled) setAgents(list)
      })
      .catch(() => {
        // Degrade gracefully: cards still launch a chat with the current model.
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function startPresetChat(presetName: string): Promise<void> {
    if (launching) return
    // No usable provider → send them to Settings to connect one instead of into
    // an unusable chat.
    if (!hasConnected) {
      navigate('/settings')
      return
    }
    setLaunching(presetName)
    try {
      const agent = agents.find((a) => a.name === presetName)
      const provider = agent?.provider ?? selectedProvider ?? undefined
      const model = agent?.model ?? selectedModel ?? undefined

      // Reflect the agent's own provider+model so the chat view uses it.
      if (agent?.provider && agent.model) setSelectedModel(agent.provider, agent.model)

      const chat = await window.sunny.chats.create({
        provider,
        model,
        // Pass the matched agent so its (rewritten) preset persona is applied.
        agentId: agent?.id,
        title: agent?.name ?? presetName,
        // Attach the chat to the active project scope (null = unattached).
        projectId: activeProjectId ?? undefined
      })
      navigate(`/chats/${chat.id}`)
    } finally {
      setLaunching(null)
    }
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {agentPresets.map(({ id, name, role, description, icon: Icon, tint }) => (
        <button
          key={id}
          type="button"
          onClick={() => void startPresetChat(name)}
          disabled={launching !== null}
          title={hasConnected ? undefined : 'Connect a provider in Settings first'}
          aria-label={`Start a chat with the ${name} agent — ${description}`}
          className={cn(
            'group flex flex-col items-start gap-3 rounded-2xl border border-ink-700/70 bg-ink-800 p-4 text-left',
            'transition-colors hover:border-ink-600 hover:bg-ink-750',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-60'
          )}
        >
          <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', tint)}>
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="flex flex-col gap-1.5">
            <span>
              <span className="block text-sm font-bold leading-tight text-fg-heading">{name}</span>
              <span className="mt-1 block text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">
                {role}
              </span>
            </span>
            <span className="text-xs leading-snug text-fg-muted">{description}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
