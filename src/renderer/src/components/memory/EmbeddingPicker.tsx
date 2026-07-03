import { RefreshCw, Sparkles, Star } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useUiStore } from '@renderer/store/uiStore'
import { cn } from '@renderer/lib/cn'
import { EMBEDDING_PROVIDERS } from '@shared/embeddings'
import type { MemoryStatusResult } from '@shared/ipc/contract'

const CUSTOM = '__custom__'
const selectClass =
  'rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-fg focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30'

interface EmbeddingPickerProps {
  /** Refresh the parent's status after a change / re-embed. */
  onChanged: () => void
}

/**
 * Choose the memory embedding provider + model (structure layer). Recommended
 * models are starred, with a one-line note on each provider's tradeoff (notably:
 * local Ollama shares the GPU with chat). Switching applies live and re-embeds
 * existing memories in the background; "Re-embed all" backfills on demand. Owns
 * its own status fetch so it's accurate in both Memory views.
 */
export function EmbeddingPicker({ onChanged }: EmbeddingPickerProps): JSX.Element {
  const providers = useUiStore((s) => s.providers)
  const isConnected = (kind: string): boolean =>
    providers.find((p) => p.kind === kind)?.connected ?? false

  const [provider, setProvider] = useState<string>('openai')
  const [model, setModel] = useState<string>('text-embedding-3-small')
  const [useCustom, setUseCustom] = useState(false)
  const [busy, setBusy] = useState<null | 'save' | 'reembed'>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [memStatus, setMemStatus] = useState<MemoryStatusResult | null>(null)

  const providerRec = useMemo(
    () => EMBEDDING_PROVIDERS.find((p) => p.kind === provider) ?? EMBEDDING_PROVIDERS[0],
    [provider]
  )

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setMemStatus(await window.sunny.memories.status())
    } catch {
      // leave prior status
    }
  }, [])

  // Seed dropdowns from the saved choice + load the active status, once on mount.
  useEffect(() => {
    let cancelled = false
    void refreshStatus()
    Promise.all([
      window.sunny.settings.get({ key: 'embedding_provider' }),
      window.sunny.settings.get({ key: 'embedding_model' })
    ])
      .then(([p, m]) => {
        if (cancelled || !p.value) return
        setProvider(p.value)
        const rec = EMBEDDING_PROVIDERS.find((ep) => ep.kind === p.value)
        const known = rec?.models.some((mm) => mm.id === m.value)
        setModel(m.value ?? '')
        setUseCustom(Boolean(rec?.allowCustom) && !known)
      })
      .catch(() => {
        // keep defaults
      })
    return () => {
      cancelled = true
    }
  }, [refreshStatus])

  function pickProvider(kind: string): void {
    setProvider(kind)
    const rec = EMBEDDING_PROVIDERS.find((p) => p.kind === kind)
    const def = rec?.models.find((m) => m.recommended) ?? rec?.models[0]
    setModel(def?.id ?? '')
    setUseCustom(false)
    setMessage(null)
  }

  function pickModel(value: string): void {
    if (value === CUSTOM) {
      setUseCustom(true)
      setModel('')
    } else {
      setUseCustom(false)
      setModel(value)
    }
  }

  const connected = isConnected(provider)
  const canSave = connected && model.trim().length > 0 && busy === null

  async function handleSave(): Promise<void> {
    if (!canSave) return
    setBusy('save')
    setMessage(null)
    try {
      const next = await window.sunny.memories.setEmbedding({ provider, model: model.trim() })
      setMemStatus(next)
      onChanged()
      setMessage(
        next.embeddingsAvailable
          ? 'Saved — re-embedding your memories in the background…'
          : "Saved, but this provider isn't usable yet (check the key / model)."
      )
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to switch embedding provider.')
    } finally {
      setBusy(null)
    }
  }

  async function handleReembed(): Promise<void> {
    setBusy('reembed')
    setMessage(null)
    try {
      const r = await window.sunny.memories.reembed()
      await refreshStatus()
      onChanged()
      setMessage(`Re-embedded ${r.embedded} of ${r.total} memories.`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Re-embed failed.')
    } finally {
      setBusy(null)
    }
  }

  const activeLabel =
    memStatus?.embeddingsAvailable && memStatus.embeddingProvider
      ? `${memStatus.embeddingProvider}${memStatus.embeddingModel ? ` · ${memStatus.embeddingModel}` : ''}`
      : 'off'

  return (
    <div className="rounded-2xl border border-ink-700/70 bg-ink-850 p-5 shadow-panel">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-amber-300" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg-heading">Embedding provider</h2>
        <span className="ml-auto text-[11px] text-fg-subtle">
          Active: <span className="text-fg-muted">{activeLabel}</span>
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px] text-fg-subtle">
          Provider
          <select
            value={provider}
            onChange={(e) => pickProvider(e.target.value)}
            className={selectClass}
            aria-label="Embedding provider"
          >
            {EMBEDDING_PROVIDERS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
                {isConnected(p.kind) ? '' : ' (not connected)'}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-fg-subtle">
          Model
          <select
            value={useCustom ? CUSTOM : model}
            onChange={(e) => pickModel(e.target.value)}
            className={cn(selectClass, 'min-w-[16rem]')}
            aria-label="Embedding model"
          >
            {providerRec.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.recommended ? '★ ' : ''}
                {m.label}
              </option>
            ))}
            {providerRec.allowCustom ? <option value={CUSTOM}>Custom…</option> : null}
          </select>
        </label>

        {useCustom ? (
          <label className="flex flex-col gap-1 text-[11px] text-fg-subtle">
            Custom model id
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. nomic-embed-text"
              className={cn(selectClass, 'min-w-[16rem]')}
              aria-label="Custom embedding model id"
            />
          </label>
        ) : null}

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="rounded-lg bg-amber-400 px-3.5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'save' ? 'Saving…' : 'Use this'}
        </button>

        <button
          type="button"
          onClick={() => void handleReembed()}
          disabled={busy !== null || !memStatus?.embeddingsAvailable}
          title="Re-embed all existing memories with the active model"
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw
            className={cn('h-4 w-4', busy === 'reembed' && 'animate-spin')}
            aria-hidden="true"
          />
          Re-embed all
        </button>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-fg-subtle">
        <Star className="mt-0.5 h-3 w-3 shrink-0 text-amber-300/70" aria-hidden="true" />
        {providerRec.note}
      </p>
      {!connected ? (
        <p className="mt-1 text-xs text-status-blocked">
          {providerRec.label} isn&apos;t connected — add it in Settings first
          {provider === 'ollama' ? ' (or check your Ollama server)' : ''}.
        </p>
      ) : null}
      {message ? <p className="mt-1 text-xs text-amber-200">{message}</p> : null}
    </div>
  )
}
