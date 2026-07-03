// The agent-tool registry: given a ToolContext (workspace, permission mode, the
// agent's allowlist), it assembles the tools the model may see this turn and
// returns ONE dispatcher that enforces the rules before running anything:
//
//   1. allowlist  — the tool must be in the agent's `allowed_tools`.
//   2. workspace  — fs/shell tools require a workspace root (else unavailable).
//   3. permission — for side-effecting tools (write/edit/shell):
//        plan       → refuse and describe what it WOULD do (read-only mode)
//        ask        → ConfirmFn must approve
//        autopilot  → run, but ConfirmFn must approve DESTRUCTIVE actions
//   4. run        — the tool's own logic (it never throws; returns a string).
//
// Web tools (web_search/web_fetch) are NOT here — they're governed by the web
// toggle and dispatched in chat/complete.ts. This registry is fs/shell/board.
//
// Board tools (board.ts) are appended per-call, not into the static ALL_TOOLS
// list: they need a `BoardToolDeps` (the task repos) and an actor name that
// only the caller (worker/chat) knows, so `buildAgentToolset`'s ctx carries
// them as optional extras. They still flow through the SAME allowlist +
// permission gate below as every other tool — nothing about the gate is
// board-aware, it just sees more ToolDefinitions when ctx.board is set.

import type { ToolCall, ToolSpec } from '@main/providers/types'
import type { AgentToolset, FileArtifact, ToolContext, ToolDefinition } from './types'
import { FS_TOOLS } from './fs'
import { SHELL_TOOLS } from './shell'
import { DOCUMENT_TOOLS } from './documents'
import { buildBoardTools, type BoardToolDeps } from './board'

// All registered agent tool definitions (read/write/edit/list/glob + shell +
// document generation). Board tools are added per-call — see header comment.
const ALL_TOOLS: ToolDefinition[] = [...FS_TOOLS, ...SHELL_TOOLS, ...DOCUMENT_TOOLS]

/** External MCP tools, injected by the call site that owns the McpManager.
 *  Kept as a narrow interface so this module never imports the SDK. */
export interface McpToolSource {
  tools(): Array<{ spec: ToolSpec; readOnly: boolean }>
  call(fullName: string, argsJson: string): Promise<string>
}

/** `buildAgentToolset`'s ctx, plus the board deps + actor name + MCP source
 *  only the worker/chat call sites can supply (they own the repos/manager). */
export type BoardAwareToolContext = ToolContext & {
  /** Task repos for the board tools. Omit to leave list_tasks/create_task/etc
   *  unavailable regardless of the agent's allowlist. */
  board?: BoardToolDeps
  /** Name recorded as the actor on status-change events from update_task
   *  (so the audit trail says "Aria moved …", not "user moved …"). */
  actorName?: string
  /** Connected MCP servers' tools. Enabled per-agent by the `mcp_tools`
   *  allowlist sentinel (the concrete tool names are dynamic). Read-only MCP
   *  tools run like reads; everything else is gated like a write/command. */
  mcp?: McpToolSource
}

/** Summarize a tool call for a Plan-mode "would do" note / a confirm dialog /
 *  an approval gate. The default includes a deterministic args preview so two
 *  DIFFERENT calls of the same tool (board/MCP) get DISTINCT approval gates —
 *  the gate key digests this detail string. */
function summarizeCall(name: string, args: Record<string, unknown>): string {
  const get = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'write_file':
      return `write file "${get('path')}"`
    case 'edit_file':
      return `edit file "${get('path')}"`
    case 'run_command':
      return `run: ${get('command')}`
    default: {
      const preview = JSON.stringify(args)
      return `${name} ${preview.length > 200 ? preview.slice(0, 200) + '…' : preview}`
    }
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Build the toolset for a turn. Only includes a tool when it's in the agent's
 * allowlist AND (for fs/shell) a workspace is set. The returned dispatcher
 * applies the permission gate described in the file header before running.
 */
export function buildAgentToolset(ctx: BoardAwareToolContext): AgentToolset {
  // Board tools need no workspace (like documents.ts) but DO need per-call
  // deps, so they're built here and merged in BEFORE the allowlist filter —
  // exactly like the spec requires — rather than living in the static list.
  const boardTools = ctx.board ? buildBoardTools(ctx.board, ctx.actorName ?? 'agent') : []
  const available = [...ALL_TOOLS, ...boardTools].filter((def) => {
    if (!ctx.allowed.has(def.id)) return false
    if (def.requiresWorkspace && !ctx.workspace) return false
    return true
  })

  // MCP tools: dynamic names, so the allowlist gates them via the `mcp_tools`
  // sentinel (agent-level opt-in) rather than per-id entries. Read-only tools
  // (annotations.readOnlyHint) run like reads; everything else flows through
  // the same side-effect gate as writes/commands. Never destructive-classed —
  // Ask mode confirms each call, Autopilot runs them.
  if (ctx.mcp && ctx.allowed.has('mcp_tools')) {
    const mcp = ctx.mcp
    for (const { spec, readOnly } of mcp.tools()) {
      available.push({
        id: spec.function.name,
        spec,
        sideEffecting: !readOnly,
        requiresWorkspace: false,
        destructive: () => false,
        // run must never throw — surface MCP failures as a result string.
        run: async (args) => {
          try {
            return await mcp.call(spec.function.name, JSON.stringify(args))
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        }
      })
    }
  }

  const byName = new Map<string, ToolDefinition>(available.map((d) => [d.id, d]))
  const tools: ToolSpec[] = available.map((d) => d.spec)

  // Files produced this turn (create_file) — exposed on the toolset so the caller
  // can attach them to the assistant message after the stream finishes.
  const artifacts: FileArtifact[] = []
  const toolCtx: ToolContext = { ...ctx, recordArtifact: (a) => artifacts.push(a) }

  const runTool = async (call: ToolCall): Promise<string> => {
    const def = byName.get(call.name)
    if (!def) return `Tool "${call.name}" is not enabled for this agent.`

    const args = parseArgs(call.arguments)

    if (def.sideEffecting) {
      if (ctx.mode === 'plan') {
        return `Plan mode (read-only): not executing. Proposed action — ${summarizeCall(call.name, args)}. Describe the change instead of performing it.`
      }
      const isDestructive = def.destructive?.(args) ?? false
      const needsConfirm = ctx.mode === 'ask' || (ctx.mode === 'autopilot' && isDestructive)
      if (needsConfirm) {
        const approved = await ctx.confirm({
          tool: call.name,
          title: isDestructive ? `Confirm destructive action` : `Confirm action`,
          detail: summarizeCall(call.name, args)
        })
        if (!approved) {
          return `The user did not approve this action (${summarizeCall(call.name, args)}). It was not performed.`
        }
      }
    }

    if (ctx.signal?.aborted) return 'Cancelled before the tool ran.'
    return def.run(args, toolCtx)
  }

  return { tools, runTool, artifacts }
}
