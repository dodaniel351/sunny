import { useEffect, useRef, useState } from 'react'

/** Setting key for the recall similarity floor ('0'..'1'; default 0.35). */
const RELEVANCE_KEY = 'memory_relevance_min'
const DEFAULT_MIN = 0.35
/** Debounce before persisting a slider drag. */
const COMMIT_MS = 400

/**
 * Recall-relevance tuning (0.4.2 gate, 0.4.3 UI). Auto-recall only injects
 * memories whose cosine similarity to your message clears this floor. Local
 * embedders (nomic et al.) have a higher baseline similarity and may want
 * ~0.55–0.6; OpenAI-style embeddings suit the 0.35 default. Persists the
 * `memory_relevance_min` setting the recall gate reads per query.
 */
export function RelevanceControl(): JSX.Element {
  const [value, setValue] = useState(DEFAULT_MIN)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    window.sunny.settings
      .get({ key: RELEVANCE_KEY })
      .then((res) => {
        if (cancelled) return
        const parsed = Number(res.value)
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) setValue(parsed)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true)
      })
    return () => {
      cancelled = true
      if (commitTimer.current) clearTimeout(commitTimer.current)
    }
  }, [])

  function handleChange(next: number): void {
    setValue(next)
    setSaved(false)
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null
      void window.sunny.settings
        .set({ key: RELEVANCE_KEY, value: String(next) })
        .then((res) => setSaved(res.ok))
        .catch(() => setSaved(false))
    }, COMMIT_MS)
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700/60 bg-ink-900/50 px-4 py-2.5">
      <label htmlFor="memory-relevance" className="text-xs font-medium text-fg-muted">
        Recall strictness
      </label>
      <input
        id="memory-relevance"
        type="range"
        min={0}
        max={0.9}
        step={0.05}
        value={value}
        disabled={!loaded}
        onChange={(e) => handleChange(Number(e.target.value))}
        className="h-1.5 w-40 cursor-pointer accent-amber-400"
      />
      <span className="font-mono text-xs text-fg" aria-live="polite">
        {value.toFixed(2)}
        {saved ? ' ✓' : ''}
      </span>
      <span className="text-[11px] text-fg-subtle">
        Higher = only closely-matching memories are recalled into chats (local embedders like
        nomic often want ~0.55).
      </span>
    </div>
  )
}
