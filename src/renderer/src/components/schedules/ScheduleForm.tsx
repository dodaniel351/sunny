import { X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { useProviders } from '@renderer/hooks/useProviders'
import { isUsableProvider, usableModels } from '@renderer/lib/providers'
import type { Agent, Project, Schedule } from '@shared/db/types'
import { CADENCES, CADENCE_LABELS, type Cadence } from '@shared/scheduler'

/**
 * Parse a schedule's stored `payload` JSON into its goal/prompt. Guards
 * JSON.parse so a malformed value never crashes the editor — it just yields an
 * empty prompt.
 */
function promptFromPayload(payload: string | null): string {
  if (!payload) return ''
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed && typeof parsed === 'object' && 'prompt' in parsed) {
      const value = (parsed as { prompt?: unknown }).prompt
      return typeof value === 'string' ? value : ''
    }
    return ''
  } catch {
    return ''
  }
}

/** Coerce a stored cadence keyword to a known preset, defaulting to 'daily'. */
function cadenceFromCron(cron: string | null): Cadence {
  return CADENCES.includes(cron as Cadence) ? (cron as Cadence) : 'daily'
}

/** Parse a schedule's stored model override (provider + model) from its payload. */
function overrideFromPayload(payload: string | null): { provider: string; model: string } {
  if (!payload) return { provider: '', model: '' }
  try {
    const parsed = JSON.parse(payload) as { provider?: unknown; model?: unknown }
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : '',
      model: typeof parsed.model === 'string' ? parsed.model : ''
    }
  } catch {
    return { provider: '', model: '' }
  }
}

/** Values collected by the form, normalised for the schedules create/update API. */
export interface ScheduleFormValues {
  name: string
  prompt: string
  cadence: Cadence
  /** null = "Default agent". */
  agentId: string | null
  /** null = "All / unassigned". */
  projectId: string | null
  enabled: boolean
  /** Model override: provider kind, or null to use the agent's model. */
  provider: string | null
  /** Model id for the override (null when no provider override). */
  model: string | null
}

interface ScheduleFormProps {
  /** Whether the form creates a new schedule or edits an existing one. */
  mode: 'create' | 'edit'
  /** The schedule being edited; null when creating. */
  schedule: Schedule | null
  /** Agents for the assignment dropdown. */
  agents: Agent[]
  /** Projects for the scope dropdown. */
  projects: Project[]
  /** True while a save request is in flight (disables the form). */
  saving: boolean
  /** Optional save error to surface inline. */
  error: string | null
  onSubmit: (values: ScheduleFormValues) => void
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
 * Modal form to create or edit a schedule (spec §7) — "run an agent on a goal
 * automatically on a cadence". Agent defaults to "Default agent" (null) and
 * project to "All / unassigned" (null); enabled defaults on for new schedules.
 */
export function ScheduleForm({
  mode,
  schedule,
  agents,
  projects,
  saving,
  error,
  onSubmit,
  onClose
}: ScheduleFormProps): JSX.Element {
  const { providers } = useProviders()
  // Only providers usable for an override (connected AND enabled) — matching the
  // rest of the app's pickers. The scheduler/worker treat the override as
  // authoritative, so the picker shouldn't offer a disabled provider/model.
  const connected = useMemo(() => providers.filter(isUsableProvider), [providers])

  const initialOverride = useMemo(
    () => overrideFromPayload(schedule?.payload ?? null),
    [schedule?.payload]
  )

  const [name, setName] = useState(schedule?.name ?? '')
  const [prompt, setPrompt] = useState(() => promptFromPayload(schedule?.payload ?? null))
  const [cadence, setCadence] = useState<Cadence>(() => cadenceFromCron(schedule?.cron ?? null))
  const [agentId, setAgentId] = useState<string>(schedule?.agent_id ?? '')
  const [projectId, setProjectId] = useState<string>(schedule?.project_id ?? '')
  const [enabled, setEnabled] = useState(schedule ? schedule.enabled === 1 : true)
  const [provider, setProvider] = useState<string>(initialOverride.provider)
  const [model, setModel] = useState<string>(initialOverride.model)

  // Usable models for the chosen override provider (minus any switched off);
  // empty when none/disconnected.
  const providerModels = useMemo(() => {
    const p = connected.find((pp) => pp.kind === provider)
    return p ? usableModels(p) : []
  }, [connected, provider])

  // Switching the override provider picks its default/first USABLE model so the
  // override is always a concrete provider+model pair (the worker needs both).
  function pickProvider(kind: string): void {
    setProvider(kind)
    if (!kind) {
      setModel('')
      return
    }
    const p = connected.find((pp) => pp.kind === kind)
    const models = p ? usableModels(p) : []
    const def = models.find((m) => m.id === p?.defaultModel)?.id ?? models[0]?.id ?? ''
    setModel(def)
  }

  const titleId = useId()
  const nameId = useId()
  const promptId = useId()
  const cadenceId = useId()
  const agentFieldId = useId()
  const projectFieldId = useId()
  const providerFieldId = useId()
  const modelFieldId = useId()
  const enabledId = useId()

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

  const trimmedName = name.trim()
  const canSave = trimmedName.length > 0 && !saving

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSave) return
    onSubmit({
      name: trimmedName,
      prompt: prompt.trim(),
      cadence,
      agentId: agentId || null,
      projectId: projectId || null,
      enabled,
      // Override applies only as a complete provider+model pair.
      provider: provider && model ? provider : null,
      model: provider && model ? model : null
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
            {mode === 'edit' && schedule ? `Edit ${schedule.name}` : 'New schedule'}
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
            <p className="text-xs text-fg-subtle">
              Run an agent on a goal automatically on a cadence. When it fires, Sunny creates a
              board task in the chosen project, assigns it to the chosen agent, and works it — even
              when the board&apos;s auto-worker is off.
            </p>

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
                placeholder="e.g. Morning standup digest"
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={promptId} className={labelClass}>
                Goal
              </label>
              <textarea
                id={promptId}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={saving}
                rows={4}
                placeholder="What should the agent do each time this fires?"
                className={cn(inputClass, 'resize-y leading-relaxed')}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={cadenceId} className={labelClass}>
                Cadence
              </label>
              <select
                id={cadenceId}
                value={cadence}
                onChange={(e) => setCadence(e.target.value as Cadence)}
                disabled={saving}
                className={inputClass}
              >
                {CADENCES.map((value) => (
                  <option key={value} value={value}>
                    {CADENCE_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={agentFieldId} className={labelClass}>
                  Agent
                </label>
                <select
                  id={agentFieldId}
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  disabled={saving}
                  className={inputClass}
                >
                  <option value="">Default agent</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor={projectFieldId} className={labelClass}>
                  Project
                </label>
                <select
                  id={projectFieldId}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={saving}
                  className={inputClass}
                >
                  <option value="">All / unassigned</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={providerFieldId} className={labelClass}>
                  Model override
                </label>
                <select
                  id={providerFieldId}
                  value={provider}
                  onChange={(e) => pickProvider(e.target.value)}
                  disabled={saving}
                  className={inputClass}
                >
                  <option value="">Use agent&apos;s model</option>
                  {connected.map((p) => (
                    <option key={p.kind} value={p.kind}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor={modelFieldId} className={labelClass}>
                  Model
                </label>
                <select
                  id={modelFieldId}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving || !provider || providerModels.length === 0}
                  className={inputClass}
                >
                  {provider ? null : <option value="">—</option>}
                  {providerModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-fg-subtle">
              Unattended runs can&apos;t use the ChatGPT/Codex sign-in or a provider with no saved
              key — they fall back to whatever&apos;s connected. Pin a connected provider here so this
              schedule always runs on the model you expect.
            </p>

            <div className="space-y-1.5">
              <label
                htmlFor={enabledId}
                className={cn(
                  'flex cursor-pointer items-start justify-between gap-3 rounded-xl border px-3 py-3 transition-colors',
                  enabled
                    ? 'border-amber-400/60 bg-amber-400/10'
                    : 'border-ink-700 bg-ink-900 hover:border-ink-600'
                )}
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-fg">Enabled</span>
                  <span className="text-xs text-fg-subtle">
                    When on, this schedule fires automatically on its cadence.
                  </span>
                </span>
                <input
                  id={enabledId}
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={saving}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400"
                />
              </label>
            </div>

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
              {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create schedule'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
