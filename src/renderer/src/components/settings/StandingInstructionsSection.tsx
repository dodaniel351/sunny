import { CheckCircle2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'

/** The setting key these global instructions are persisted under. */
const STANDING_INSTRUCTIONS_KEY = 'standing_instructions'

/**
 * Standing Instructions (spec §9) — a constitution-style editor for global
 * guidance every agent reads before acting. Loads the persisted value on mount
 * and saves it back through the settings API, tracking dirty + saved state.
 */
export function StandingInstructionsSection(): JSX.Element {
  const inputId = useId()
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.sunny.settings
      .get({ key: STANDING_INSTRUCTIONS_KEY })
      .then((res) => {
        if (cancelled) return
        const next = res.value ?? ''
        setValue(next)
        setSaved(next)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load standing instructions.')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dirty = value !== saved

  async function handleSave(): Promise<void> {
    if (saving || !dirty) return
    setSaving(true)
    setError(null)
    setJustSaved(false)
    try {
      const res = await window.sunny.settings.set({
        key: STANDING_INSTRUCTIONS_KEY,
        value
      })
      if (!res.ok) {
        setError('Could not save standing instructions.')
        return
      }
      setSaved(value)
      setJustSaved(true)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save standing instructions.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-subtle">
        Global guidance applied to every agent before it acts — preferences, guardrails, and house
        style that should always hold.
      </p>

      <label htmlFor={inputId} className="sr-only">
        Standing instructions
      </label>
      <textarea
        id={inputId}
        rows={6}
        value={value}
        disabled={!loaded}
        onChange={(e) => {
          setValue(e.target.value)
          if (error) setError(null)
          if (justSaved) setJustSaved(false)
        }}
        placeholder="e.g. Prefer TypeScript. Never run destructive shell commands outside the project directory…"
        className="w-full resize-y rounded-xl border border-ink-700 bg-ink-850/60 px-4 py-3 text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60"
      />

      <div className="flex items-center justify-between gap-3">
        <div className="min-h-[1.25rem] text-xs" role="status" aria-live="polite">
          {error ? (
            <span className="text-status-blocked" role="alert">
              {error}
            </span>
          ) : !loaded ? (
            <span className="inline-flex items-center gap-1.5 text-fg-subtle">
              <Spinner className="h-3.5 w-3.5" label="Loading standing instructions" />
              Loading…
            </span>
          ) : dirty ? (
            <span className="text-amber-300">Unsaved changes</span>
          ) : justSaved ? (
            <span className="inline-flex items-center gap-1.5 text-status-success">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Saved.
            </span>
          ) : (
            <span className="text-fg-subtle">All changes saved.</span>
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!loaded || !dirty || saving}
          className={cn(
            'inline-flex shrink-0 items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
            'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-40'
          )}
        >
          {saving ? <Spinner className="text-ink-950" label="Saving" /> : null}
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
