import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { SettingsRepo } from '@main/repositories'
import type { ToolSpec } from '@main/providers/types'
import {
  parseMcpServers,
  serializeMcpServers,
  mcpToolFullName,
  parseMcpToolFullName,
  type McpServerConfig
} from './config'

// The MCP (Model Context Protocol) client manager: connects to each configured
// stdio server, caches its tool list, and exposes them as Sunny ToolSpecs the
// agent toolset can merge in (wired by the orchestrator once this lands).
// Server config persists in the `mcp_servers` settings key as JSON (see
// config.ts); this module owns the actual SDK connections.

const SETTINGS_KEY = 'mcp_servers'
const CALL_TIMEOUT_MS = 60_000
const MAX_RESULT_CHARS = 8000

/** One MCP tool as listed by `client.listTools()` — the fields we use. */
interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

interface ConnectedServer {
  config: McpServerConfig
  client: Client
  transport: StdioClientTransport
  tools: McpToolInfo[]
}

export interface McpServerStatusLike {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
  connected: boolean
  toolCount: number
  error: string | null
}

/** Windows shim fix: `npx`/`.cmd`/`.bat` aren't directly spawnable as a Win32
 *  process image the way StdioClientTransport spawns them (Node's child_process
 *  needs `shell: true` or a `.exe`/`cmd /c` wrapper to resolve them on PATH,
 *  since they're actually a shell script the OS association machinery handles,
 *  not a native executable) — so route them through `cmd /c` on win32. Direct
 *  `.exe` paths spawn fine as-is. */
function winSafeSpawn(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  const lower = command.toLowerCase()
  if (lower.endsWith('.exe')) return { command, args }
  return { command: 'cmd', args: ['/c', command, ...args] }
}

export class McpManager {
  private readonly settings: SettingsRepo
  private servers = new Map<string, ConnectedServer>()
  // Configs (including disabled/errored ones) so status() can report on every
  // configured server, not just the ones currently connected.
  private configs: McpServerConfig[] = []
  private errors = new Map<string, string>()

  constructor({ settings }: { settings: SettingsRepo }) {
    this.settings = settings
  }

  /** (Re)connect all enabled servers from settings; disconnect any that were
   *  removed or disabled. Never throws — per-server failures are captured in
   *  `errors` and surfaced via status(). */
  async refresh(): Promise<void> {
    this.configs = parseMcpServers(this.settings.get(SETTINGS_KEY))
    const wanted = new Map(this.configs.map((c) => [c.id, c]))

    // Disconnect servers that were removed or disabled, or whose command/args
    // changed (reconnect fresh rather than diffing a live transport).
    for (const [id, connected] of this.servers) {
      const next = wanted.get(id)
      const changed =
        !next ||
        !next.enabled ||
        next.command !== connected.config.command ||
        JSON.stringify(next.args) !== JSON.stringify(connected.config.args)
      if (changed) {
        await this.disconnectOne(id)
      }
    }

    // Connect every enabled server not already connected.
    for (const config of this.configs) {
      if (!config.enabled) continue
      if (this.servers.has(config.id)) continue
      await this.connectOne(config)
    }
  }

  private async connectOne(config: McpServerConfig): Promise<void> {
    this.errors.delete(config.id)
    try {
      const spawn = winSafeSpawn(config.command, config.args)
      const transport = new StdioClientTransport({ command: spawn.command, args: spawn.args })
      const client = new Client({ name: 'sunny', version: '0.5.0' })
      await client.connect(transport)
      const { tools } = await client.listTools()
      this.servers.set(config.id, { config, client, transport, tools: tools as McpToolInfo[] })
    } catch (err) {
      this.errors.set(config.id, err instanceof Error ? err.message : 'Failed to connect')
    }
  }

  private async disconnectOne(id: string): Promise<void> {
    const connected = this.servers.get(id)
    this.servers.delete(id)
    if (!connected) return
    try {
      await connected.client.close()
    } catch {
      // best effort
    }
  }

  /** Every configured server's connection status, in configured order. */
  status(): McpServerStatusLike[] {
    return this.configs.map((config) => {
      const connected = this.servers.get(config.id)
      return {
        id: config.id,
        name: config.name,
        command: config.command,
        args: config.args,
        enabled: config.enabled,
        connected: Boolean(connected),
        toolCount: connected?.tools.length ?? 0,
        error: this.errors.get(config.id) ?? null
      }
    })
  }

  /** Every connected server's tools as Sunny ToolSpecs, tagged read-only. */
  tools(): Array<{ spec: ToolSpec; readOnly: boolean }> {
    const out: Array<{ spec: ToolSpec; readOnly: boolean }> = []
    for (const { config, tools } of this.servers.values()) {
      for (const tool of tools) {
        out.push({
          spec: {
            type: 'function',
            function: {
              name: mcpToolFullName(config.id, tool.name),
              description: `[${config.name}] ${tool.description ?? tool.name}`,
              parameters: tool.inputSchema ?? { type: 'object', properties: {} }
            }
          },
          readOnly: tool.annotations?.readOnlyHint === true
        })
      }
    }
    return out
  }

  isReadOnly(fullName: string): boolean {
    const parsed = parseMcpToolFullName(fullName)
    if (!parsed) return false
    const connected = this.servers.get(parsed.serverId)
    const tool = connected?.tools.find((t) => mcpToolFullName(parsed.serverId, t.name) === fullName)
    return tool?.annotations?.readOnlyHint === true
  }

  /** Invoke an MCP tool by its Sunny full name, returning flattened text. */
  async call(fullName: string, argsJson: string): Promise<string> {
    const parsed = parseMcpToolFullName(fullName)
    if (!parsed) throw new Error(`Unknown MCP tool: ${fullName}`)
    const connected = this.servers.get(parsed.serverId)
    if (!connected) throw new Error(`Unknown MCP tool: ${fullName}`)
    const tool = connected.tools.find((t) => mcpToolFullName(parsed.serverId, t.name) === fullName)
    if (!tool) throw new Error(`Unknown MCP tool: ${fullName}`)

    let args: Record<string, unknown> = {}
    try {
      const parsedArgs = JSON.parse(argsJson) as unknown
      if (parsedArgs && typeof parsedArgs === 'object') args = parsedArgs as Record<string, unknown>
    } catch {
      args = {}
    }

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`MCP tool "${fullName}" timed out`)), CALL_TIMEOUT_MS)
    })
    const result = await Promise.race([
      connected.client.callTool({ name: tool.name, arguments: args }),
      timeout
    ])

    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .map((part) => (part.type === 'text' ? part.text : `[${part.type} content]`))
      .join('\n')

    if (result.isError) throw new Error(text || `MCP tool "${fullName}" failed`)

    return text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated — ${text.length} chars total]`
      : text
  }

  /** Persist the new server list and reconnect accordingly. */
  async saveServers(servers: McpServerConfig[]): Promise<void> {
    this.settings.set(SETTINGS_KEY, serializeMcpServers(servers))
    await this.refresh()
  }

  /** Close all client connections. Best-effort — never throws. */
  dispose(): void {
    for (const id of [...this.servers.keys()]) {
      const connected = this.servers.get(id)
      this.servers.delete(id)
      if (connected) {
        connected.client.close().catch(() => {
          // best effort
        })
      }
    }
  }
}
