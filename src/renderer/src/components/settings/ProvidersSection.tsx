import {
  CheckCircle2,
  ChevronRight,
  HardDrive,
  KeyRound,
  LogIn,
  LogOut,
  Plug,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
  XCircle
} from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { useProviders } from '@renderer/hooks/useProviders'
import { cn } from '@renderer/lib/cn'
import { relativeFuture } from '@renderer/lib/time'
import type { LocalStatus, OAuthStatus, ProviderStatus } from '@shared/ipc/contract'

interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible label describing what the switch toggles. */
  label: string
  disabled?: boolean
  busy?: boolean
  /** 'sm' for the compact per-model rows, 'md' for the prominent provider toggle. */
  size?: 'sm' | 'md'
}

/** Accessible on/off switch matching the dark + amber theme (role="switch"). */
function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  busy = false,
  size = 'md'
}: SwitchProps): JSX.Element {
  const sm = size === 'sm'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        sm ? 'h-4 w-7' : 'h-5 w-9',
        checked ? 'bg-amber-400' : 'bg-ink-700'
      )}
    >
      <span
        className={cn(
          'inline-block transform rounded-full bg-ink-950 transition-transform',
          sm ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5',
          checked ? (sm ? 'translate-x-3.5' : 'translate-x-4') : 'translate-x-1'
        )}
      />
    </button>
  )
}

/** Connected / disconnected pill for a provider. */
function StatusBadge({ connected }: { connected: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        connected ? 'bg-status-success/15 text-status-success' : 'bg-ink-800 text-fg-subtle'
      )}
    >
      {connected ? (
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
      ) : (
        <XCircle className="h-3 w-3" aria-hidden="true" />
      )}
      {connected ? 'Connected' : 'Not connected'}
    </span>
  )
}

/** Running / Not detected pill for a keyless local provider (Ollama). */
function LocalStatusBadge({ reachable }: { reachable: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        reachable ? 'bg-status-success/15 text-status-success' : 'bg-ink-800 text-fg-subtle'
      )}
    >
      {reachable ? (
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
      ) : (
        <XCircle className="h-3 w-3" aria-hidden="true" />
      )}
      {reachable ? 'Running' : 'Not detected'}
    </span>
  )
}

interface ModelManagerProps {
  provider: ProviderStatus
  onChanged: () => Promise<void>
}

/**
 * Searchable per-model on/off list with a bulk toggle. A model is on unless its
 * id is in `disabledModels`. The bulk switch and counts operate on whatever the
 * search currently SHOWS, so "disable all" can be scoped by typing a filter.
 */
function ModelManager({ provider, onChanged }: ModelManagerProps): JSX.Element {
  const [query, setQuery] = useState('')
  // The id being updated, or '__bulk__' during a bulk toggle.
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const disabledSet = new Set(provider.disabledModels)
  const q = query.trim().toLowerCase()
  const filtered = provider.models.filter(
    (m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
  )
  const shownOn = filtered.filter((m) => !disabledSet.has(m.id)).length
  const allShownOn = filtered.length > 0 && shownOn === filtered.length
  const totalOn = provider.models.length - disabledSet.size

  async function toggleOne(modelId: string, next: boolean): Promise<void> {
    if (pending) return
    setPending(modelId)
    setError(null)
    try {
      const res = await window.sunny.providers.setModelEnabled({
        kind: provider.kind,
        model: modelId,
        enabled: next
      })
      if (!res.ok) {
        setError('Could not update that model.')
        return
      }
      await onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update that model.')
    } finally {
      setPending(null)
    }
  }

  async function toggleAllShown(next: boolean): Promise<void> {
    if (pending || filtered.length === 0) return
    setPending('__bulk__')
    setError(null)
    try {
      const res = await window.sunny.providers.setModelsEnabled({
        kind: provider.kind,
        models: filtered.map((m) => m.id),
        enabled: next
      })
      if (!res.ok) {
        setError('Could not update those models.')
        return
      }
      await onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update those models.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        Models{' '}
        <span className="text-fg-subtle/70">
          ({totalOn}/{provider.models.length} on)
        </span>
      </span>

      <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          aria-label="Search models"
          className="w-full bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
        />
      </div>

      {/* Bulk toggle — applies to whatever the search currently shows. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-2">
        <span className="text-xs font-medium text-fg-muted">
          {q ? `All ${filtered.length} shown` : 'All models'}{' '}
          <span className="text-fg-subtle">
            ({shownOn}/{filtered.length} on)
          </span>
        </span>
        <div className="flex items-center gap-2">
          {pending === '__bulk__' ? <Spinner className="h-3 w-3" label="Updating models" /> : null}
          <Switch
            checked={allShownOn}
            busy={pending === '__bulk__'}
            disabled={filtered.length === 0}
            label={`Enable all ${q ? 'shown ' : ''}models`}
            onChange={(next) => void toggleAllShown(next)}
          />
        </div>
      </div>

      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <li className="px-1 py-4 text-center text-xs text-fg-subtle">
            No models match “{query}”.
          </li>
        ) : (
          filtered.map((model) => {
            const on = !disabledSet.has(model.id)
            return (
              <li
                key={model.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-ink-700/60 bg-ink-900/40 px-2.5 py-1.5"
              >
                <span
                  className={cn('min-w-0 flex-1 truncate text-xs', on ? 'text-fg-muted' : 'text-fg-subtle')}
                  title={model.id}
                >
                  {model.label}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {typeof model.contextWindow === 'number' ? (
                    <span className="text-[10px] text-fg-subtle">
                      {Math.round(model.contextWindow / 1000)}k
                    </span>
                  ) : null}
                  {pending === model.id ? (
                    <Spinner className="h-3 w-3" label={`Updating ${model.label}`} />
                  ) : null}
                  <Switch
                    size="sm"
                    checked={on}
                    busy={pending === model.id}
                    label={`${model.label} — ${on ? 'on' : 'off'}`}
                    onChange={(next) => void toggleOne(model.id, next)}
                  />
                </div>
              </li>
            )
          })
        )}
      </ul>

      {error ? (
        <p className="text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

interface ProviderKeyFormProps {
  provider: ProviderStatus
  /** Heading shown above the field; lets a dual-auth card label the choice. */
  heading?: string
  onSaved: () => Promise<void>
}

/** Password input + Save for a provider's API key, with validating + status UI. */
function ProviderKeyForm({ provider, heading, onSaved }: ProviderKeyFormProps): JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const inputId = useId()

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!apiKey || saving) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await window.sunny.providers.saveKey({ kind: provider.kind, apiKey })
      // Never log or echo the key; clear it regardless of outcome.
      setApiKey('')
      if (!res.ok) {
        setError(res.error ?? 'Could not validate that key.')
        return
      }
      setSaved(true)
      await onSaved()
    } catch (err: unknown) {
      setApiKey('')
      setError(err instanceof Error ? err.message : 'Failed to save key.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-xs font-medium text-fg-muted">
        {heading ?? `${provider.label} API key`}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value)
            if (error) setError(null)
            if (saved) setSaved(false)
          }}
          disabled={saving}
          placeholder="Paste API key…"
          className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!apiKey || saving}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
            'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-40'
          )}
        >
          {saving ? <Spinner className="text-ink-950" label="Validating key" /> : null}
          {saving ? 'Validating…' : 'Save'}
        </button>
      </div>
      {error ? (
        <p className="text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-status-success" role="status">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          Key saved.
        </p>
      ) : null}
      <p className="text-xs text-fg-subtle">
        Stored in your OS keychain — Sunny never writes the key to disk or logs.
      </p>
    </form>
  )
}

interface ProviderOAuthSectionProps {
  provider: ProviderStatus
  oauth: OAuthStatus
  /** Heading shown above the controls; lets a dual-auth card label the choice. */
  heading?: string
  onChanged: () => Promise<void>
}

/** OAuth connect / disconnect controls for providers that support sign-in. */
function ProviderOAuthSection({
  provider,
  oauth,
  heading,
  onChanged
}: ProviderOAuthSectionProps): JSX.Element {
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleConnect(): Promise<void> {
    if (busy) return
    setBusy('login')
    setError(null)
    try {
      const res = await window.sunny.providers.oauthLogin({ kind: provider.kind })
      if (!res.ok) {
        setError(res.error ?? 'Sign-in failed.')
        return
      }
      await onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setBusy(null)
    }
  }

  async function handleDisconnect(): Promise<void> {
    if (busy) return
    setBusy('logout')
    setError(null)
    try {
      await window.sunny.providers.oauthLogout({ kind: provider.kind })
      await onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-out failed.')
    } finally {
      setBusy(null)
    }
  }

  // Codex (or any CLI-backed provider) without its prerequisite installed: no
  // Connect path is possible, so explain what to install instead.
  const cliMissing = oauth.requiresCli && !oauth.available

  return (
    <div className="flex flex-col gap-2">
      {heading ? <p className="text-xs font-medium text-fg-muted">{heading}</p> : null}

      {cliMissing ? (
        <div className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs text-fg-muted">
          <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          <span>
            Requires the Codex CLI — install it and ensure{' '}
            <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-fg">codex</code> is on
            your PATH, then return here to connect.
          </span>
        </div>
      ) : oauth.connected ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-success">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {oauth.account ? (
                <span className="truncate">Signed in as {oauth.account}</span>
              ) : (
                <span>Signed in</span>
              )}
            </span>
            <span className="text-xs text-fg-subtle">
              {oauth.expiresAt !== null
                ? `Session expires ${relativeFuture(oauth.expiresAt)}`
                : 'Session active'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={busy !== null}
            aria-label={`Disconnect ${provider.label}`}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-fg-muted',
              'transition-colors hover:border-status-blocked/50 hover:text-status-blocked',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'
            )}
          >
            {busy === 'logout' ? (
              <Spinner className="h-3.5 w-3.5" label="Disconnecting" />
            ) : (
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Disconnect
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void handleConnect()}
          disabled={busy !== null}
          aria-label={`Connect ${provider.label}`}
          className={cn(
            'inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
            'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-60'
          )}
        >
          {busy === 'login' ? (
            <Spinner className="text-ink-950" label="Connecting" />
          ) : (
            <LogIn className="h-4 w-4" aria-hidden="true" />
          )}
          {busy === 'login' ? 'Connecting… (complete sign-in in your browser)' : 'Connect'}
        </button>
      )}

      {error ? (
        <p className="text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

interface LocalConnectionSectionProps {
  /** Provider kind — selects the settings key + the right hints (ollama | opencode). */
  kind: string
  local: LocalStatus
  onChanged: () => Promise<void>
}

/** Reachability hint + editable Base URL for a keyless local provider (Ollama / opencode). */
function LocalConnectionSection({
  kind,
  local,
  onChanged
}: LocalConnectionSectionProps): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(local.baseUrl)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  const isOpencode = kind === 'opencode'
  const settingKey = isOpencode ? 'opencode_base_url' : 'ollama_base_url'
  const placeholder = isOpencode ? 'http://localhost:4096' : 'http://localhost:11434'

  // Keep the field in sync when a refresh re-probes (unless mid-edit).
  useEffect(() => {
    if (!saving) setBaseUrl(local.baseUrl)
  }, [local.baseUrl, saving])

  async function handleSaveUrl(e: FormEvent): Promise<void> {
    e.preventDefault()
    const trimmed = baseUrl.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setError(null)
    try {
      await window.sunny.settings.set({ key: settingKey, value: trimmed })
      await onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the base URL.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {!local.reachable ? (
        <div className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs text-fg-muted">
          <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          {isOpencode ? (
            <span>
              Run <span className="font-mono text-fg">opencode serve</span>, then Refresh. Install
              from <span className="font-mono text-fg">opencode.ai</span> and connect your ChatGPT
              subscription with <span className="font-mono text-fg">opencode auth login</span>.
            </span>
          ) : (
            <span>
              Start Ollama, then Refresh. Install from{' '}
              <span className="font-mono text-fg">ollama.com</span>.
            </span>
          )}
        </div>
      ) : null}

      <form onSubmit={handleSaveUrl} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-xs font-medium text-fg-muted">
          Base URL
        </label>
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              if (error) setError(null)
            }}
            disabled={saving}
            placeholder={placeholder}
            className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!baseUrl.trim() || saving}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
              'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            {saving ? <Spinner className="text-ink-950" label="Saving base URL" /> : null}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error ? (
          <p className="text-xs text-status-blocked" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      {isOpencode ? (
        <p className="text-xs text-fg-subtle">
          opencode owns its own auth — models here are whatever you&apos;ve connected via{' '}
          <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-fg">opencode auth login</code>
          . Works unattended (board worker + schedules) too.
        </p>
      ) : (
        <p className="text-xs text-fg-subtle">
          For local memory embeddings, run{' '}
          <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-fg">
            ollama pull nomic-embed-text
          </code>
          .
        </p>
      )}
    </div>
  )
}

interface ProviderDetailModalProps {
  provider: ProviderStatus
  onClose: () => void
  onChanged: () => Promise<void>
}

/**
 * Full detail/management modal for one provider (opened from its row): connection
 * (API key / OAuth / local base URL), then a searchable, bulk-toggleable model
 * list. The provider on/off toggle stays on the main row, not here.
 */
function ProviderDetailModal({ provider, onClose, onChanged }: ProviderDetailModalProps): JSX.Element {
  const titleId = useId()
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const isLocal = provider.authMethods.includes('local') && Boolean(provider.local)
  const supportsKey = provider.authMethods.includes('api_key')
  const supportsOauth = provider.authMethods.includes('oauth')
  const both = supportsKey && supportsOauth
  const oauth = supportsOauth ? provider.oauth : undefined
  const keyConnected = provider.activeAuth === 'api_key'

  async function handleRemoveKey(): Promise<void> {
    if (removing) return
    setRemoving(true)
    try {
      await window.sunny.providers.removeKey({ kind: provider.kind })
      await onChanged()
    } finally {
      setRemoving(false)
    }
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-panel"
      >
        <header className="flex items-center gap-2 border-b border-ink-700/60 px-6 py-4">
          {isLocal ? (
            <HardDrive className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          ) : (
            <KeyRound className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          )}
          <h2 id={titleId} className="text-base font-bold text-fg-heading">
            {provider.label}
          </h2>
          {isLocal && provider.local ? (
            <LocalStatusBadge reachable={provider.local.reachable} />
          ) : (
            <StatusBadge connected={provider.connected} />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Connection management */}
          {isLocal && provider.local ? (
            <LocalConnectionSection
              kind={provider.kind}
              local={provider.local}
              onChanged={onChanged}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {supportsOauth && oauth ? (
                <ProviderOAuthSection
                  provider={provider}
                  oauth={oauth}
                  heading={both ? `Sign in with your ${provider.label} subscription` : undefined}
                  onChanged={onChanged}
                />
              ) : null}

              {both ? (
                <div className="flex items-center gap-2" aria-hidden="true">
                  <span className="h-px flex-1 bg-ink-700/60" />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                    or
                  </span>
                  <span className="h-px flex-1 bg-ink-700/60" />
                </div>
              ) : null}

              {supportsKey && keyConnected ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-success">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Connected via API key
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRemoveKey()}
                    disabled={removing}
                    aria-label={`Remove ${provider.label} key`}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-fg-muted',
                      'transition-colors hover:border-status-blocked/50 hover:text-status-blocked',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'
                    )}
                  >
                    {removing ? (
                      <Spinner className="h-3.5 w-3.5" label="Removing key" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    Remove
                  </button>
                </div>
              ) : null}

              {supportsKey && !keyConnected ? (
                <ProviderKeyForm
                  provider={provider}
                  heading={both ? `Use a ${provider.label} API key` : undefined}
                  onSaved={onChanged}
                />
              ) : null}
            </div>
          )}

          {/* Model management */}
          {provider.connected && provider.models.length > 0 ? (
            <div className="border-t border-ink-700/60 pt-5">
              <ModelManager provider={provider} onChanged={onChanged} />
            </div>
          ) : isLocal && provider.local?.reachable && provider.models.length === 0 ? (
            <p className="border-t border-ink-700/60 pt-5 text-xs text-fg-subtle">
              No models pulled — run{' '}
              <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-fg">
                ollama pull qwen3.5:9b
              </code>
              .
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface ProviderRowProps {
  provider: ProviderStatus
  onOpen: () => void
  onChanged: () => Promise<void>
}

/**
 * One compact provider row on the main Settings screen: name, status, a short
 * subtitle, the provider on/off toggle (only when connected), and a chevron to
 * open the detail modal. Everything else (keys, sign-in, models) lives in the
 * modal so this screen stays scannable.
 */
function ProviderRow({ provider, onOpen, onChanged }: ProviderRowProps): JSX.Element {
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isLocal = provider.authMethods.includes('local') && Boolean(provider.local)
  const onCount = provider.models.length - provider.disabledModels.length
  const offWithCreds = provider.connected && !provider.enabled

  async function handleToggleEnabled(next: boolean): Promise<void> {
    if (toggling) return
    setToggling(true)
    setError(null)
    try {
      const res = await window.sunny.providers.setEnabled({ kind: provider.kind, enabled: next })
      if (!res.ok) {
        setError('Could not update that setting.')
        return
      }
      await onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update that setting.')
    } finally {
      setToggling(false)
    }
  }

  const subtitle = !provider.connected
    ? isLocal
      ? 'Not detected — click to configure'
      : 'Not connected — click to add a key or sign in'
    : `${onCount}/${provider.models.length} models on` +
      (provider.activeAuth === 'oauth'
        ? ' • sign-in'
        : provider.activeAuth === 'api_key'
          ? ' • API key'
          : isLocal
            ? ' • local'
            : '')

  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border border-ink-700/60 bg-ink-850/50 py-3 pl-4 pr-3 transition-colors hover:border-ink-600',
          offWithCreds ? 'opacity-60' : ''
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          {isLocal ? (
            <HardDrive className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          ) : (
            <KeyRound className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-fg">{provider.label}</span>
              {isLocal && provider.local ? (
                <LocalStatusBadge reachable={provider.local.reachable} />
              ) : (
                <StatusBadge connected={provider.connected} />
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs text-fg-subtle">{subtitle}</span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-3">
          {provider.connected ? (
            <label className="flex cursor-pointer items-center gap-1.5 select-none">
              <span className="text-xs font-medium text-fg-muted">
                {provider.enabled ? 'On' : 'Off'}
              </span>
              <Switch
                checked={provider.enabled}
                busy={toggling}
                label={`Enable ${provider.label}`}
                onChange={(next) => void handleToggleEnabled(next)}
              />
            </label>
          ) : null}
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Manage ${provider.label}`}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {error ? (
        <p className="mt-1 px-4 text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}

/** The "Providers & Keys" body: a scannable provider list + a per-provider modal. */
export function ProvidersSection(): JSX.Element {
  const { providers, loaded, refresh } = useProviders()
  const [refreshing, setRefreshing] = useState(false)
  const [activeKind, setActiveKind] = useState<string | null>(null)

  const activeProvider = activeKind
    ? (providers.find((p) => p.kind === activeKind) ?? null)
    : null

  // If the open provider vanishes (shouldn't happen), close the modal.
  useEffect(() => {
    if (activeKind && !activeProvider) setActiveKind(null)
  }, [activeKind, activeProvider])

  async function handleRefresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
        <Spinner label="Loading providers" />
        Loading providers…
      </div>
    )
  }

  if (providers.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-ink-700/60 bg-ink-850/50 px-4 py-3 text-sm text-fg-muted">
        <Plug className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
        No providers available.
      </div>
    )
  }

  // Connected providers first; otherwise preserve the backend order.
  const ordered = [...providers].sort((a, b) => Number(b.connected) - Number(a.connected))

  return (
    <div className="flex flex-col gap-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          Toggle a provider on/off here; click any provider to connect it and pick its models.
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          aria-label="Refresh providers"
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-fg-muted',
            'transition-colors hover:border-amber-400/50 hover:text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'
          )}
        >
          {refreshing ? (
            <Spinner className="h-3.5 w-3.5" label="Refreshing" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Refresh
        </button>
      </div>

      <ul className="flex flex-col gap-2">
        {ordered.map((provider) => (
          <ProviderRow
            key={provider.kind}
            provider={provider}
            onOpen={() => setActiveKind(provider.kind)}
            onChanged={refresh}
          />
        ))}
      </ul>

      {activeProvider ? (
        <ProviderDetailModal
          provider={activeProvider}
          onClose={() => setActiveKind(null)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  )
}
