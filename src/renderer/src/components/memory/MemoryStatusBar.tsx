import { Sparkles, SparklesIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { MemoryStatusResult } from '@shared/ipc/contract'

interface MemoryStatusBarProps {
  status: MemoryStatusResult | null
  loading: boolean
  onToggleAuto: (enabled: boolean) => void
}

interface CountStat {
  label: string
  value: number
}

/** A single labelled count chip in the status bar. */
function Stat({ label, value }: CountStat): JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-sm font-semibold tabular-nums text-fg">{value.toLocaleString()}</span>
      <span className="text-xs text-fg-subtle">{label}</span>
    </div>
  )
}

/**
 * The Memory view's header strip: entity/relation/observation counts from
 * `memories.status()`, an auto-memory toggle (`setAuto`), and a one-line note on
 * whether semantic recall (embeddings) is available. Renders a quiet skeleton
 * while the first status call is in flight.
 */
export function MemoryStatusBar({
  status,
  loading,
  onToggleAuto
}: MemoryStatusBarProps): JSX.Element {
  const auto = status?.autoMemory ?? false
  const embeddingsOn = status?.embeddingsAvailable ?? false
  const embeddingProvider = status?.embeddingProvider ?? null
  const embeddingModel = status?.embeddingModel ?? null
  // Name the active embedding source, falling back gracefully if the model is
  // unknown: "on — Ollama (nomic-embed-text)" or just "on — Ollama".
  const embeddingLabel =
    embeddingProvider !== null
      ? embeddingModel !== null
        ? `${embeddingProvider} (${embeddingModel})`
        : embeddingProvider
      : null

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-ink-700/70 bg-ink-850 px-5 py-4 shadow-panel sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {loading && !status ? (
          <span className="text-xs text-fg-subtle">Loading status…</span>
        ) : (
          <>
            <Stat label="entities" value={status?.entityCount ?? 0} />
            <Stat label="relations" value={status?.relationCount ?? 0} />
            <Stat label="observations" value={status?.observationCount ?? 0} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p
          className={cn(
            'flex items-center gap-1.5 text-xs',
            embeddingsOn ? 'text-status-success' : 'text-fg-subtle'
          )}
        >
          {embeddingsOn ? (
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <SparklesIcon className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
          )}
          {embeddingsOn
            ? `Semantic recall on${embeddingLabel !== null ? ` — ${embeddingLabel}` : ''}`
            : 'Semantic recall off — add an OpenAI key or run `ollama pull nomic-embed-text`'}
        </p>

        <label className="flex cursor-pointer items-center gap-2 select-none">
          <span className="text-xs font-medium text-fg-muted">Auto-memory</span>
          <button
            type="button"
            role="switch"
            aria-checked={auto}
            aria-label="Toggle auto-memory"
            disabled={loading && !status}
            onClick={() => onToggleAuto(!auto)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-50',
              auto ? 'bg-amber-400' : 'bg-ink-700'
            )}
          >
            <span
              className={cn(
                'inline-block h-3.5 w-3.5 transform rounded-full bg-ink-950 transition-transform',
                auto ? 'translate-x-4' : 'translate-x-1'
              )}
            />
          </button>
        </label>
      </div>
    </div>
  )
}
