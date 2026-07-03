// The agent-tool execution contract (spec §7). A `ToolDefinition` is one callable
// tool (read a file, run a command, …); the registry (registry.ts) assembles the
// set available for a turn and enforces the allowlist + permission mode before
// running any of them. Tool implementations (fs.ts, shell.ts) are pure functions
// of (args, context) → result string, so they're unit-testable in isolation.

import type { ToolSpec, ToolCall } from '@main/providers/types'
import type { PermissionMode } from '@shared/db/types'

/** Ask the user to approve a side-effecting action. Resolves true to proceed.
 *  Interactive chat round-trips this to a renderer modal; the autonomous worker
 *  passes a function that always denies (no human present). */
export type ConfirmFn = (req: { tool: string; title: string; detail: string }) => Promise<boolean>

/** A file an agent produced this turn (the `create_file` tool). Surfaced on the
 *  assistant message as a download chip; the bytes live on disk at `path`. */
export interface FileArtifact {
  name: string
  path: string
  format: string
  mediaType: string
  bytes: number
}

/** Everything a tool needs to run safely for one turn. */
export interface ToolContext {
  /** Absolute workspace root. fs/shell tools refuse to touch anything outside it.
   *  Undefined means no workspace is set — those tools are then unavailable. */
  workspace?: string
  /** The agent's permission mode: ask = confirm side effects, plan = read-only
   *  (side effects blocked), autopilot = act, confirming only destructive ones. */
  mode: PermissionMode
  /** Tool ids the agent is allowed to use (its `allowed_tools`). */
  allowed: Set<string>
  /** Aborts in-flight tool work (and the surrounding turn). */
  signal?: AbortSignal
  /** Approval gate for side-effecting actions (see ConfirmFn). */
  confirm: ConfirmFn
  /** App-managed output dir for generated files (the `create_file` tool). */
  generatedDir?: string
  /** Record a file the turn produced, so the caller can attach it to the message. */
  recordArtifact?: (artifact: FileArtifact) => void
}

/** One agent tool. `run` must NEVER throw — it returns a result string (including
 *  for errors) that is fed back to the model as the tool result. */
export interface ToolDefinition {
  /** The OpenAI function-calling spec advertised to the model. */
  spec: ToolSpec
  /** Stable id; must equal spec.function.name and a TOOL_IDS value. */
  id: string
  /** True if it can change the filesystem / run code (write/edit/shell). */
  sideEffecting: boolean
  /** True if it needs a workspace root (all fs/shell tools). */
  requiresWorkspace: boolean
  /** For autopilot: return true when these args look destructive (→ confirm). */
  destructive?: (args: Record<string, unknown>) => boolean
  /** Execute. Resolve to the result text. Must not throw. */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

/** What the registry hands to the stream loop: the advertised specs + a single
 *  dispatcher that applies the allowlist + permission gate, then runs the tool. */
export interface AgentToolset {
  tools: ToolSpec[]
  runTool: (call: ToolCall) => Promise<string>
  /** Files produced during the turn (create_file), for the caller to attach to
   *  the assistant message. Mutated as tools run; read after the stream finishes. */
  artifacts: FileArtifact[]
}
