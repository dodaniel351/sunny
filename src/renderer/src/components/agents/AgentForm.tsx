import { AlertTriangle, Globe, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { useProviders } from '@renderer/hooks/useProviders'
import type { Agent, PermissionMode } from '@shared/db/types'
import { permissionModeValues } from '@shared/db/types'
import { AGENT_TOOL_GROUPS, groupsFromTools, toolsFromGroups } from '@shared/tools'
import { permissionModeLabel } from './AgentBadge'

/**
 * Parse an agent's stored `allowed_tools` JSON into the checked group ids.
 * Guards JSON.parse so a malformed value never crashes the editor — it just
 * yields no checked groups.
 */
function initialGroups(agent: Agent | null): string[] {
  if (!agent?.allowed_tools) return []
  try {
    const parsed: unknown = JSON.parse(agent.allowed_tools)
    return groupsFromTools(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    return []
  }
}

/** Hint shown under side-effecting tool groups (write / shell). */
const SIDE_EFFECT_HINT =
  'Requires a workspace folder; runs under this agent’s permission mode ' +
  '(Ask confirms each action, Plan blocks them, Autopilot runs them).'

/** Values collected by the form, normalised for the agents create/update API. */
export interface AgentFormValues {
  name: string
  role: string | null
  systemPrompt: string | null
  provider: string | null
  model: string | null
  permissionMode: PermissionMode
  /** Whether this agent may search the web when it runs autonomously. */
  webAccess: boolean
  /** Flat list of allowed tool ids, expanded from the checked tool groups. */
  allowedTools: string[]
}

interface AgentFormProps {
  /** Whether the form creates a new agent or edits an existing one. */
  mode: 'create' | 'edit'
  /** Prefill source: the agent being edited, or a seed for a duplicate. */
  agent: Agent | null
  /** True while a save request is in flight (disables the form). */
  saving: boolean
  /** Optional save error to surface inline. */
  error: string | null
  onSubmit: (values: AgentFormValues) => void
  onClose: () => void
}

const inputClass = cn(
  'w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg',
  'placeholder:text-fg-subtle transition-colors',
  'focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30',
  'disabled:cursor-not-allowed disabled:opacity-50'
)

const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-fg-subtle'

/**
 * Modal form to create or edit an agent (spec §7). Provider + model come from
 * the connected providers; both default to "global default" (none) so an agent
 * can defer to the composer's selection. Never crashes when no provider is
 * connected — the model select is simply disabled with a hint.
 */
export function AgentForm({
  mode,
  agent,
  saving,
  error,
  onSubmit,
  onClose
}: AgentFormProps): JSX.Element {
  const { providers } = useProviders()
  const connected = useMemo(() => providers.filter((p) => p.connected), [providers])

  const [name, setName] = useState(agent?.name ?? '')
  const [role, setRole] = useState(agent?.role ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? '')
  const [provider, setProvider] = useState<string>(agent?.provider ?? '')
  const [model, setModel] = useState<string>(agent?.model ?? '')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    agent?.permission_mode ?? 'ask'
  )
  const [webAccess, setWebAccess] = useState(agent?.web_access === 1)
  // Checked tool groups. New agents start empty (safe/opt-in); editing an agent
  // initialises from its stored allowed_tools.
  const [toolGroups, setToolGroups] = useState<string[]>(() => initialGroups(agent))

  const titleId = useId()
  const nameId = useId()
  const roleId = useId()
  const promptId = useId()
  const providerId = useId()
  const modelId = useId()
  const permissionName = useId()
  const webAccessId = useId()
  const toolsLabelId = useId()

  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Close on Escape; focus the name field on open.
  useEffect(() => {
    nameRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Models available for the chosen provider; empty when none/disconnected.
  const providerModels = useMemo(
    () => connected.find((p) => p.kind === provider)?.models ?? [],
    [connected, provider]
  )

  // If the selected model no longer belongs to the chosen provider, clear it.
  useEffect(() => {
    if (model && !providerModels.some((m) => m.id === model)) setModel('')
  }, [model, providerModels])

  const trimmedName = name.trim()
  const canSave = trimmedName.length > 0 && !saving

  function toggleToolGroup(id: string): void {
    setToolGroups((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]))
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSave) return
    onSubmit({
      name: trimmedName,
      role: role.trim() ? role.trim() : null,
      systemPrompt: systemPrompt.trim() ? systemPrompt.trim() : null,
      provider: provider || null,
      model: provider && model ? model : null,
      permissionMode,
      webAccess,
      allowedTools: toolsFromGroups(toolGroups)
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" aria-hidden="true" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden',
          'rounded-2xl border border-ink-700 bg-ink-850 shadow-panel'
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-ink-700/60 px-6 py-4">
          <h2 id={titleId} className="text-lg font-bold text-fg-heading">
            {mode === 'edit' && agent ? `Edit ${agent.name}` : 'Create agent'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-1.5">
              <label htmlFor={nameId} className={labelClass}>
                Name <span className="text-amber-300">*</span>
              </label>
              <input
                id={nameId}
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                required
                placeholder="e.g. Research"
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={roleId} className={labelClass}>
                Role
              </label>
              <input
                id={roleId}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={saving}
                placeholder="e.g. Specialist"
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={promptId} className={labelClass}>
                System prompt
              </label>
              <textarea
                id={promptId}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={saving}
                rows={4}
                placeholder="Instructions that define how this agent behaves…"
                className={cn(inputClass, 'resize-y leading-relaxed')}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={providerId} className={labelClass}>
                  Default provider
                </label>
                <select
                  id={providerId}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  disabled={saving}
                  className={inputClass}
                >
                  <option value="">Global default</option>
                  {connected.map((p) => (
                    <option key={p.kind} value={p.kind}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor={modelId} className={labelClass}>
                  Default model
                </label>
                <select
                  id={modelId}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving || !provider || providerModels.length === 0}
                  className={inputClass}
                >
                  <option value="">{provider ? 'Provider default' : 'Default'}</option>
                  {providerModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className={labelClass}>Permission mode</legend>
              <div className="flex flex-wrap gap-2">
                {permissionModeValues.map((mode) => {
                  const active = permissionMode === mode
                  return (
                    <label
                      key={mode}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
                        active
                          ? 'border-amber-400/60 bg-amber-400/10 text-amber-300'
                          : 'border-ink-700 bg-ink-900 text-fg-muted hover:border-ink-600 hover:text-fg'
                      )}
                    >
                      <input
                        type="radio"
                        name={permissionName}
                        value={mode}
                        checked={active}
                        onChange={() => setPermissionMode(mode)}
                        disabled={saving}
                        className="sr-only"
                      />
                      {permissionModeLabel[mode]}
                    </label>
                  )
                })}
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <label
                htmlFor={webAccessId}
                className={cn(
                  'flex cursor-pointer items-start justify-between gap-3 rounded-xl border px-3 py-3 transition-colors',
                  webAccess
                    ? 'border-amber-400/60 bg-amber-400/10'
                    : 'border-ink-700 bg-ink-900 hover:border-ink-600'
                )}
              >
                <span className="flex items-start gap-2.5">
                  <Globe
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      webAccess ? 'text-amber-300' : 'text-fg-subtle'
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg">Web access</span>
                    <span className="text-xs text-fg-subtle">
                      Let this agent search the web when it works tasks autonomously.
                    </span>
                  </span>
                </span>
                <input
                  id={webAccessId}
                  type="checkbox"
                  checked={webAccess}
                  onChange={(e) => setWebAccess(e.target.checked)}
                  disabled={saving}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400"
                />
              </label>
            </div>

            <fieldset className="space-y-2" aria-labelledby={toolsLabelId}>
              <legend id={toolsLabelId} className={labelClass}>
                Tools
              </legend>
              <p className="text-xs text-fg-subtle">
                Pick what this agent may do. Nothing is allowed until you opt in.
              </p>
              <div className="space-y-2">
                {AGENT_TOOL_GROUPS.map((group) => {
                  const checked = toolGroups.includes(group.id)
                  return (
                    <label
                      key={group.id}
                      className={cn(
                        'flex cursor-pointer items-start justify-between gap-3 rounded-xl border px-3 py-3 transition-colors',
                        checked
                          ? 'border-amber-400/60 bg-amber-400/10'
                          : 'border-ink-700 bg-ink-900 hover:border-ink-600'
                      )}
                    >
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-fg">{group.label}</span>
                        <span className="text-xs text-fg-subtle">{group.description}</span>
                        {group.sideEffecting ? (
                          <span className="mt-1 inline-flex items-start gap-1.5 text-xs text-amber-300/90">
                            <AlertTriangle
                              className="mt-0.5 h-3.5 w-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span>{SIDE_EFFECT_HINT}</span>
                          </span>
                        ) : null}
                      </span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleToolGroup(group.id)}
                        disabled={saving}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400"
                      />
                    </label>
                  )
                })}
              </div>
            </fieldset>

            {error ? (
              <p role="alert" className="text-sm text-status-blocked">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="flex items-center justify-end gap-3 border-t border-ink-700/60 px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className={cn(
                'rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 transition-colors',
                'hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                'disabled:cursor-not-allowed disabled:opacity-40'
              )}
            >
              {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create agent'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
