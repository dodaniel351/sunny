// Human-readable, one-line labels for a tool call, shown as transient `status`
// chunks while a tool runs ("📄 Reading src/index.ts", "⚙️ Running: npm test").
// Kept dependency-light (types only) so the tool-loop can import it without
// pulling in the fs/shell/web implementations.

import type { ToolCall } from '@main/providers/types'

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** A readable status line for any agent tool call. */
export function describeToolCall(call: ToolCall): string {
  const a = parseArgs(call.arguments)
  switch (call.name) {
    case 'web_search':
      return `🔎 Searching the web: ${str(a.query)}`.trim()
    case 'web_fetch':
      return `📄 Reading ${str(a.url)}`.trim()
    case 'read_file':
      return `📄 Reading ${str(a.path)}`.trim()
    case 'list_dir':
      return `📁 Listing ${str(a.path) || '.'}`
    case 'glob':
      return `🔍 Finding ${str(a.pattern)}`.trim()
    case 'write_file':
      return `✏️ Writing ${str(a.path)}`.trim()
    case 'edit_file':
      return `✏️ Editing ${str(a.path)}`.trim()
    case 'run_command':
      return `⚙️ Running: ${str(a.command)}`.trim()
    default:
      return `Running ${call.name}…`
  }
}
