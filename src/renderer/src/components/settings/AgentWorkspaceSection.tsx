import { FolderOpen, FolderSearch } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'

/** The setting key the autonomous worker's workspace folder is stored under. */
const AGENT_WORKSPACE_KEY = 'agent_workspace'

/**
 * Agent workspace (spec §7) — the folder the autonomous board worker runs agents'
 * file and shell tools inside. Loads the persisted path on mount; "Choose folder…"
 * opens the native picker and saves a non-null result; "Clear" resets it to "".
 *
 * Interactive chats use the folder picked per chat instead, so this only governs
 * the headless worker.
 */
export function AgentWorkspaceSection(): JSX.Element {
  const [path, setPath] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.sunny.settings
      .get({ key: AGENT_WORKSPACE_KEY })
      .then((res) => {
        if (cancelled) return
        setPath(res.value ?? '')
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load the agent workspace.')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function persist(next: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await window.sunny.settings.set({ key: AGENT_WORKSPACE_KEY, value: next })
      if (!res.ok) {
        setError('Could not save the agent workspace.')
        return
      }
      setPath(next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the agent workspace.')
    } finally {
      setBusy(false)
    }
  }

  async function handleChoose(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const picked = await window.sunny.folder.pick()
      // Cancelled picker → keep the existing value untouched.
      if (!picked.path) return
      await persist(picked.path)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-fg-subtle">
        The autonomous board worker runs agents’ file and shell tools inside this folder.
        Interactive chats use the folder you pick per chat instead.
      </p>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">Workspace folder</span>
        {!loaded ? (
          <span className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-fg-subtle">
            <Spinner className="h-3.5 w-3.5" label="Loading agent workspace" />
            Loading…
          </span>
        ) : path ? (
          <code className="overflow-x-auto whitespace-nowrap rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-fg">
            {path}
          </code>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-lg border border-dashed border-ink-700 bg-ink-900/40 px-3 py-2 text-xs text-fg-subtle">
            <FolderSearch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            No workspace set — the worker can’t use file or shell tools until you choose one.
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleChoose()}
          disabled={!loaded || busy}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
            'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-40'
          )}
        >
          {busy ? (
            <Spinner className="text-ink-950" label="Working" />
          ) : (
            <FolderOpen className="h-4 w-4" aria-hidden="true" />
          )}
          Choose folder…
        </button>

        <button
          type="button"
          onClick={() => void persist('')}
          disabled={!loaded || busy || !path}
          className={cn(
            'inline-flex items-center rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted',
            'transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-40'
          )}
        >
          Clear
        </button>
      </div>

      {error ? (
        <p className="text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
