import { Check, Copy, HardDrive, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import type { DataPathsResult } from '@shared/ipc/contract'

interface CopyFieldProps {
  label: string
  value: string
}

/** A read-only, monospace value row with a copy-to-clipboard button. */
function CopyField({ label, value }: CopyFieldProps): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be unavailable (e.g. denied permission); fail silently.
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-fg">
          {value}
        </code>
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label={`Copy ${label.toLowerCase()}`}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs font-medium text-fg-muted',
            'transition-colors hover:border-ink-600 hover:text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

/**
 * Data Location (spec §2) — read-only display of where Sunny keeps its local
 * data: the user-data directory, the SQLite database file, and the active
 * secrets backend. Never shows secret values, only paths + the backend name.
 */
export function DataLocationSection(): JSX.Element {
  const [paths, setPaths] = useState<DataPathsResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.sunny.settings
      .dataPaths()
      .then((next) => {
        if (!cancelled) setPaths(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load data locations.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <p className="text-sm text-status-blocked" role="alert">
        {error}
      </p>
    )
  }

  if (!paths) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
        <Spinner label="Loading data locations" />
        Loading data locations…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <CopyField label="User-data directory" value={paths.userDataDir} />
      <CopyField label="SQLite database" value={paths.dbPath} />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-muted">Secrets backend</span>
        <span className="inline-flex w-fit items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs text-fg">
          <ShieldCheck className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
          {paths.secretsBackend}
        </span>
      </div>
      <p className="inline-flex items-start gap-2 text-xs text-fg-subtle">
        <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        All Sunny data stays local to this machine — nothing is uploaded to a server.
      </p>
    </div>
  )
}
