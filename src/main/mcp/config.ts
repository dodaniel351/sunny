// MCP (Model Context Protocol) server config — a PURE module (no electron/SDK
// imports) so it's unit-testable without booting Electron. `manager.ts` is the
// only consumer that actually talks to the SDK/settings repo.

/** One configured MCP server (stdio-launched child process). Persisted as JSON
 *  under the `mcp_servers` settings key via serializeMcpServers/parseMcpServers. */
export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
}

/** Defensive parse of the `mcp_servers` setting: null/malformed JSON/non-array
 *  all degrade to an empty list rather than throwing, so a corrupt setting never
 *  blocks startup. Entries missing id/name/command are skipped; `args` is
 *  coerced to a string array (non-string items dropped); `enabled` defaults to
 *  true when absent. */
export function parseMcpServers(json: string | null): McpServerConfig[] {
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const servers: McpServerConfig[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const name = typeof e.name === 'string' ? e.name : ''
    const command = typeof e.command === 'string' ? e.command : ''
    if (!id || !name || !command) continue
    const args = Array.isArray(e.args)
      ? e.args.filter((a): a is string => typeof a === 'string')
      : []
    const enabled = typeof e.enabled === 'boolean' ? e.enabled : true
    servers.push({ id, name, command, args, enabled })
  }
  return servers
}

export function serializeMcpServers(servers: McpServerConfig[]): string {
  return JSON.stringify(servers)
}

/** Sanitize the serverId segment: replace any character outside [a-zA-Z0-9_-]
 *  with '-' (NOT '_'), then collapse any run of underscores down to a single
 *  '_' so a sanitized serverId can NEVER contain '__' — that keeps the
 *  `mcp__<serverId>__<toolName>` delimiter unambiguous even if the raw id
 *  already had adjacent underscores. */
function sanitizeServerId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/_{2,}/g, '_')
}

/** Sanitize the toolName segment: replace any character outside [a-zA-Z0-9_-]
 *  with '_'. Unlike serverId, a toolName MAY legitimately contain '__' (some
 *  MCP servers namespace their own tools that way) — that's fine because
 *  parsing splits on the FIRST '__' boundary after the (never-'__') serverId. */
function sanitizeToolName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Build the full function-calling tool name Sunny exposes for one MCP server's
 *  tool: `mcp__<serverId>__<toolName>`. Function-calling APIs require tool names
 *  to match ^[a-zA-Z0-9_-]+$, so both segments are sanitized first. */
export function mcpToolFullName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeServerId(serverId)}__${sanitizeToolName(toolName)}`
}

/** Reverse of mcpToolFullName. Splits on the first two `__` groups: the prefix
 *  `mcp`, then the (sanitized, so '__'-free) serverId, then everything else is
 *  the toolName — which may itself legitimately contain '__'. Returns null for
 *  anything that doesn't match the `mcp__<serverId>__<rest>` shape. */
export function parseMcpToolFullName(
  fullName: string
): { serverId: string; toolName: string } | null {
  const match = /^mcp__([a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*)__(.+)$/.exec(fullName)
  if (!match) return null
  const [, serverId, toolName] = match
  return { serverId, toolName }
}
