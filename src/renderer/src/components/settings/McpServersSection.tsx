import { CheckCircle2, Plus, Plug, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import type { McpServerStatus } from '@shared/ipc/contract'

/** Accessible on/off switch matching ProvidersSection's dark + amber theme. */
function Switch({
  checked,
  onChange,
  label,
  disabled = false
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-amber-400' : 'bg-ink-700'
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-ink-950 transition-transform',
          checked ? 'translate-x-4' : 'translate-x-1'
        )}
      />
    </button>
  )
}

/** Slugify a server name into an id, plus a short random suffix so two servers
 *  named the same thing don't collide. */
function makeServerId(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  const suffix = Math.random().toString(36).slice(2, 7)
  return `${slug}-${suffix}`
}

interface AddServerFormProps {
  busy: boolean
  onAdd: (server: { name: string; command: string; args: string[] }) => void
}

/** Add-server form: name, command, and a single space-separated args field. */
function AddServerForm({ busy, onAdd }: AddServerFormProps): JSX.Element {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    const trimmedName = name.trim()
    const trimmedCommand = command.trim()
    if (!trimmedName || !trimmedCommand || busy) return
    const args = argsText.trim().length > 0 ? argsText.trim().split(/\s+/) : []
    onAdd({ name: trimmedName, command: trimmedCommand, args })
    setName('')
    setCommand('')
    setArgsText('')
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded-lg border border-dashed border-ink-700 bg-ink-900/40 p-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Filesystem)"
          aria-label="Server name"
          disabled={busy}
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60"
        />
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Command (e.g. npx)"
          aria-label="Server command"
          disabled={busy}
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60"
        />
        <input
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder="Args (space-separated)"
          aria-label="Server arguments"
          disabled={busy}
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-60"
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-fg-subtle">
          Example: <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-fg">npx</code>{' '}
          <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-fg">
            -y @modelcontextprotocol/server-filesystem C:\some\folder
          </code>
        </p>
        <button
          type="submit"
          disabled={!name.trim() || !command.trim() || busy}
          className={cn(
            'inline-flex shrink-0 items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
            'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-40'
          )}
        >
          {busy ? (
            <Spinner className="text-ink-950" label="Adding server" />
          ) : (
            <Plus className="h-4 w-4" aria-hidden="true" />
          )}
          Add server
        </button>
      </div>
    </form>
  )
}

/**
 * MCP servers (structure layer) — external tool servers (Model Context
 * Protocol) the user can configure. Each row shows live connection status
 * (connected dot / tool count / error), an enable toggle, and Remove. The add
 * form launches a new stdio server by command + args.
 *
 * Tools these servers expose don't reach any agent yet — the orchestrator
 * wires the MCP toolset into the agent tool registry separately (see
 * McpManager.tools() in src/main/mcp/manager.ts). This section only manages
 * connections.
 */
export function McpServersSection(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.sunny.mcp
      .list()
      .then((res) => {
        if (cancelled) return
        setServers(res)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load MCP servers.')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function persist(next: McpServerStatus[]): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const saved = await window.sunny.mcp.save({
        servers: next.map((s) => ({
          id: s.id,
          name: s.name,
          command: s.command,
          args: s.args,
          enabled: s.enabled
        }))
      })
      setServers(saved)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save MCP servers.')
    } finally {
      setBusy(false)
    }
  }

  function handleAdd(input: { name: string; command: string; args: string[] }): void {
    const server: McpServerStatus = {
      id: makeServerId(input.name),
      name: input.name,
      command: input.command,
      args: input.args,
      enabled: true,
      connected: false,
      toolCount: 0,
      error: null
    }
    void persist([...servers, server])
  }

  function handleToggle(id: string, enabled: boolean): void {
    void persist(servers.map((s) => (s.id === id ? { ...s, enabled } : s)))
  }

  function handleRemove(id: string): void {
    void persist(servers.filter((s) => s.id !== id))
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
        <Spinner label="Loading MCP servers" />
        Loading MCP servers…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-fg-subtle">
        Connect external tool servers over the Model Context Protocol — email, GitHub, databases,
        and more. Agents will get these tools once the MCP tool group is enabled for them.
      </p>

      {servers.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-ink-700/60 bg-ink-850/50 px-4 py-3 text-sm text-fg-muted">
          <Plug className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
          No MCP servers configured yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => (
            <li
              key={server.id}
              className={cn(
                'flex items-center gap-3 rounded-xl border border-ink-700/60 bg-ink-850/50 py-3 pl-4 pr-3',
                !server.enabled ? 'opacity-60' : ''
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg">{server.name}</span>
                  {server.connected ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-status-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-success">
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      {server.toolCount} tool{server.toolCount === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-ink-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                      <XCircle className="h-3 w-3" aria-hidden="true" />
                      Not connected
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate font-mono text-xs text-fg-subtle">
                  {server.command} {server.args.join(' ')}
                </span>
                {server.error ? (
                  <span className="mt-0.5 block truncate text-xs text-status-blocked">
                    {server.error}
                  </span>
                ) : null}
              </span>

              <div className="flex shrink-0 items-center gap-3">
                <Switch
                  checked={server.enabled}
                  disabled={busy}
                  label={`Enable ${server.name}`}
                  onChange={(next) => handleToggle(server.id, next)}
                />
                <button
                  type="button"
                  onClick={() => handleRemove(server.id)}
                  disabled={busy}
                  aria-label={`Remove ${server.name}`}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle transition-colors',
                    'hover:bg-ink-800 hover:text-status-blocked',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'
                  )}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddServerForm busy={busy} onAdd={handleAdd} />

      {error ? (
        <p className="text-xs text-status-blocked" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
