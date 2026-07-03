import { Globe, KeyRound, MessageSquare, Plug, Sparkles } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { useProviders } from '@renderer/hooks/useProviders'
import { cn } from '@renderer/lib/cn'
import type { ProviderStatus } from '@shared/ipc/contract'

/** Settings keys for Sunny's own `web_search` tool (structure layer). The
 *  orchestrator adds both to the main-process settings:set allowlist. */
const SEARCH_PROVIDER_KEY = 'search_provider'
const SEARCH_API_KEY_KEY = 'search_api_key'

type SearchProviderChoice = 'ddg' | 'tavily' | 'brave'

const selectClass =
  'rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-fg focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30'

/**
 * Small badge describing how a provider does web search:
 *  - 'native' → the provider searches the web itself ("Native web", green-ish)
 *  - 'tool'   → Sunny runs its own keyless web tools for it ("Sunny web tools", amber-ish)
 *  - null     → no web access ("No web", muted)
 */
function WebModeBadge({ webMode }: { webMode: ProviderStatus['webMode'] }): JSX.Element {
  if (webMode === 'native') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-status-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-success">
        <Globe className="h-3 w-3" aria-hidden="true" />
        Native web
      </span>
    )
  }
  if (webMode === 'tool') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        Sunny web tools
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-ink-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
      No web
    </span>
  )
}

/**
 * "Search provider" control for Sunny's own keyless `web_search` tool (the one
 * used by local Ollama and the chat/completions providers — see web.ts). DDG
 * needs no key and stays the default; Tavily/Brave are optional upgrades for
 * higher-quality results. Reads/writes `search_provider` + `search_api_key` via
 * the generic settings IPC — no dedicated endpoint needed for either.
 */
function SearchProviderControl(): JSX.Element {
  const [provider, setProvider] = useState<SearchProviderChoice>('ddg')
  const [apiKey, setApiKey] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const selectId = useId()
  const keyId = useId()

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.sunny.settings.get({ key: SEARCH_PROVIDER_KEY }),
      window.sunny.settings.get({ key: SEARCH_API_KEY_KEY })
    ])
      .then(([p, k]) => {
        if (cancelled) return
        setProvider(p.value === 'tavily' || p.value === 'brave' ? p.value : 'ddg')
        setApiKey(k.value ?? '')
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true) // default: ddg, no key
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function persistProvider(next: SearchProviderChoice): Promise<void> {
    setProvider(next)
    setError(null)
    setSaved(false)
    try {
      const res = await window.sunny.settings.set({ key: SEARCH_PROVIDER_KEY, value: next })
      if (!res.ok) setError('Could not save the search provider.')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the search provider.')
    }
  }

  async function persistApiKey(): Promise<void> {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await window.sunny.settings.set({ key: SEARCH_API_KEY_KEY, value: apiKey.trim() })
      if (!res.ok) {
        setError('Could not save the API key.')
        return
      }
      setSaved(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the API key.')
    } finally {
      setSaving(false)
    }
  }

  const providerLabel = provider === 'tavily' ? 'tavily.com' : 'brave.com/search/api'

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-ink-700/60 bg-ink-850/50 px-4 py-3">
      <label htmlFor={selectId} className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
        Search provider
        <select
          id={selectId}
          value={provider}
          disabled={!loaded}
          onChange={(e) => void persistProvider(e.target.value as SearchProviderChoice)}
          className={cn(selectClass, 'w-fit min-w-[14rem]')}
        >
          <option value="ddg">DuckDuckGo (keyless, default)</option>
          <option value="tavily">Tavily (API key)</option>
          <option value="brave">Brave (API key)</option>
        </select>
      </label>

      <p className="text-xs text-fg-subtle">
        This is the search Sunny&apos;s own <span className="font-mono text-fg">web_search</span>{' '}
        tool runs on behalf of models with no native web access (local Ollama, and the
        chat/completions providers). DuckDuckGo needs no key; Tavily and Brave can give better
        results but require an API key.
      </p>

      {provider !== 'ddg' ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={keyId} className="text-xs font-medium text-fg-muted">
            {provider === 'tavily' ? 'Tavily' : 'Brave'} API key
          </label>
          <div className="flex items-center gap-2">
            <input
              id={keyId}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                if (error) setError(null)
                if (saved) setSaved(false)
              }}
              onBlur={() => void persistApiKey()}
              disabled={!loaded || saving}
              placeholder="Paste API key…"
              className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60"
            />
            {saving ? <Spinner className="text-fg-subtle" label="Saving API key" /> : null}
          </div>
          <p className="inline-flex items-start gap-1.5 text-xs text-fg-subtle">
            <KeyRound className="mt-0.5 h-3 w-3 shrink-0 text-amber-300/70" aria-hidden="true" />
            <span>
              Stored locally in Sunny&apos;s database. Get a key at{' '}
              <span className="font-mono text-fg">{providerLabel}</span>. If the key fails or the
              provider errors, agents automatically fall back to DuckDuckGo.
            </span>
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
      {saved && !error ? <p className="text-xs text-status-success">API key saved.</p> : null}
    </div>
  )
}

/**
 * Informational "Web search" section. Web search is no longer a single global
 * handoff model — it's controlled per-message by the 🔍 toggle in chat and
 * per-agent by each agent's Web access toggle (for the autonomous board worker).
 *
 * This section just explains that and lists each connected provider with how it
 * does web search ('native' provider search vs. Sunny's own keyless web tools).
 */
export function WebResearchSection(): JSX.Element {
  const { providers, loaded } = useProviders()

  if (!loaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
        <Spinner label="Loading providers" />
        Loading…
      </div>
    )
  }

  const connected = providers.filter((p) => p.connected)
  // Connected providers first; otherwise preserve backend order (mirrors ProvidersSection).
  const ordered = [...connected].sort((a, b) => Number(b.webCapable) - Number(a.webCapable))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 text-xs text-fg-muted">
        <p className="inline-flex items-start gap-2">
          <MessageSquare
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300"
            aria-hidden="true"
          />
          <span>
            In chat, turn on the <span className="font-medium text-fg">🔍 Web search</span> toggle
            in the composer to let the model search the web for that message.
          </span>
        </p>
        <p className="inline-flex items-start gap-2">
          <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          <span>
            For the autonomous board worker, enable an agent&apos;s{' '}
            <span className="font-medium text-fg">Web access</span> toggle so it can search the web
            while it works tasks.
          </span>
        </p>
      </div>

      {ordered.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-ink-700/60 bg-ink-850/50 px-4 py-3 text-sm text-fg-muted">
          <Plug className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
          No providers connected yet — connect one above to see how it handles web search.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {ordered.map((provider) => (
            <li
              key={provider.kind}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-2'
              )}
            >
              <span className="truncate text-sm font-medium text-fg" title={provider.label}>
                {provider.label}
              </span>
              <WebModeBadge webMode={provider.webMode} />
            </li>
          ))}
        </ul>
      )}

      <SearchProviderControl />
    </div>
  )
}
