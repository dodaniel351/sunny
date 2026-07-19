import { z } from 'zod'

// Shared row shapes for Sunny's SQLite layer (spec §10). These Zod schemas are
// the single source of truth for the v1 data model and are importable by BOTH
// the main process and the renderer — so this file MUST stay free of native
// imports (better-sqlite3, sqlite-vec, keytar). Types only.
//
// Convention: primary keys are uuid-style TEXT, timestamps are ISO-8601 TEXT.
// SQLite has no boolean type, so flags are stored as 0/1 INTEGER and surfaced
// here as `z.number().int()` (callers coerce to boolean at the edge).

/** ISO-8601 timestamp string, e.g. "2026-06-17T12:34:56.000Z". */
export const isoTimestamp = z.string().datetime({ offset: true }).or(z.string())

// --- Enums -----------------------------------------------------------------

// Kanban columns (spec §6). Default set; configurable per project later.
export const taskStatusValues = ['Backlog', 'Planned', 'In Progress', 'Blocked', 'Done'] as const
export const TaskStatus = z.enum(taskStatusValues)
export type TaskStatus = z.infer<typeof TaskStatus>

// Memory scope tiers (spec §5): session / project / global.
export const memoryScopeValues = ['session', 'project', 'global'] as const
export const MemoryScope = z.enum(memoryScopeValues)
export type MemoryScope = z.infer<typeof MemoryScope>

// Memory kind (spec §5): a flat `kind` column instead of five subsystems.
export const memoryKindValues = ['working', 'episodic', 'semantic', 'fact', 'instruction'] as const
export const MemoryKind = z.enum(memoryKindValues)
export type MemoryKind = z.infer<typeof MemoryKind>

// Message roles in a transcript (spec §8).
export const messageRoleValues = ['system', 'user', 'assistant', 'tool'] as const
export const MessageRole = z.enum(messageRoleValues)
export type MessageRole = z.infer<typeof MessageRole>

// Agent permission modes (spec §7): the v1 guardrail in place of OS sandboxing.
export const permissionModeValues = ['ask', 'plan', 'autopilot'] as const
export const PermissionMode = z.enum(permissionModeValues)
export type PermissionMode = z.infer<typeof PermissionMode>

// Run lifecycle (spec §7 runtime loop).
export const runStatusValues = [
  'queued',
  'running',
  'blocked',
  'succeeded',
  'failed',
  'cancelled'
] as const
export const RunStatus = z.enum(runStatusValues)
export type RunStatus = z.infer<typeof RunStatus>

// --- Structure-layer enums (migration 006) ---------------------------------

// Goal lifecycle: an objective/goal is being pursued, reached, or dropped.
export const goalStatusValues = ['active', 'achieved', 'abandoned'] as const
export const GoalStatus = z.enum(goalStatusValues)
export type GoalStatus = z.infer<typeof GoalStatus>

// Agent lifecycle (governance): a paused agent is skipped by the heartbeat; a
// terminated one is retired. Distinct from permission_mode.
export const agentLifecycleValues = ['active', 'paused', 'terminated'] as const
export const AgentLifecycle = z.enum(agentLifecycleValues)
export type AgentLifecycle = z.infer<typeof AgentLifecycle>

// What a budget is attached to. `global` has a null scope_ref.
export const budgetScopeValues = ['global', 'project', 'goal', 'agent', 'task'] as const
export const BudgetScope = z.enum(budgetScopeValues)
export type BudgetScope = z.infer<typeof BudgetScope>

// Budget state, derived from spend vs. warn/limit thresholds.
export const budgetStateValues = ['ok', 'warned', 'exceeded'] as const
export const BudgetState = z.enum(budgetStateValues)
export type BudgetState = z.infer<typeof BudgetState>

// Approval gate decision lifecycle.
export const approvalStatusValues = ['pending', 'approved', 'rejected', 'expired'] as const
export const ApprovalStatus = z.enum(approvalStatusValues)
export type ApprovalStatus = z.infer<typeof ApprovalStatus>

// Task dependency edge kind: a hard blocker vs. a soft relation.
export const dependencyKindValues = ['blocks', 'relates'] as const
export const DependencyKind = z.enum(dependencyKindValues)
export type DependencyKind = z.infer<typeof DependencyKind>

// --- Row schemas -----------------------------------------------------------

// Projects scope chats, tasks, files, and project-tier memory (spec §7).
export const Project = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  // Per-project Kanban column overrides, JSON-encoded; null = use defaults.
  columns: z.string().nullable(),
  archived: z.number().int(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Project = z.infer<typeof Project>

// Agents are named configurations (spec §7): role/system prompt, default
// model+provider, allowed tool set, permission mode.
export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  system_prompt: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  // JSON-encoded allowlist of tool ids the agent may invoke.
  allowed_tools: z.string().nullable(),
  permission_mode: PermissionMode,
  // 0/1: whether this agent may use web search when run autonomously (the board
  // worker). Native web on web-capable models, else Sunny's own web tools.
  web_access: z.number().int(),
  // Distinguishes the built-in presets (Cowork/Research/Code/Ops/Write) from
  // user-created agents so presets can be reseeded/protected.
  is_preset: z.number().int(),
  // --- structure layer (migration 006) ---
  // Reporting line: this agent's manager (another agent), or null for a lead.
  manager_id: z.string().nullable(),
  // Org title, distinct from the free-form `role` persona label.
  title: z.string().nullable(),
  // Governance state — a paused agent is skipped by the heartbeat.
  lifecycle_state: AgentLifecycle,
  // Optional scoped spend budget for this agent.
  budget_id: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Agent = z.infer<typeof Agent>

// A chat/conversation, optionally scoped to a project (spec §8).
export const Chat = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  title: z.string().nullable(),
  // Default provider/model for the chat; switchable mid-conversation per message.
  provider: z.string().nullable(),
  model: z.string().nullable(),
  // Optional agent this chat runs as (its system prompt is injected). spec §7.
  agent_id: z.string().nullable(),
  archived: z.number().int(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Chat = z.infer<typeof Chat>

// A single transcript message (spec §8). Full tool-call/result payloads are
// kept in `content`/`tool_calls` as JSON so history is fully reconstructable.
export const Message = z.object({
  id: z.string(),
  chat_id: z.string(),
  role: MessageRole,
  content: z.string(),
  // The provider/model that produced this message (assistant turns).
  provider: z.string().nullable(),
  model: z.string().nullable(),
  // JSON-encoded tool calls / tool results attached to this turn.
  tool_calls: z.string().nullable(),
  // Optional link to the agent run that produced this message.
  run_id: z.string().nullable(),
  // JSON-encoded image attachments (ImageAttachment[]) the user attached to this
  // turn, or null. Persisted so vision models still see them across turns.
  attachments: z.string().nullable(),
  // The model's reasoning for this turn (thinking summaries / <think> content),
  // or null. Displayed in a collapsible section; never part of the answer text.
  thinking: z.string().nullable(),
  created_at: isoTimestamp
})
export type Message = z.infer<typeof Message>

// The unified task store that backs the Kanban board (spec §6). Agents read and
// write these rows directly; the board is just a view over them.
export const Task = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatus,
  // Assignee is a user or a named agent (free-form identifier per spec §6).
  assignee: z.string().nullable(),
  // Self-reference for agent-decomposed subtasks.
  parent_task_id: z.string().nullable(),
  // Manual ordering within a column.
  sort_order: z.number().int(),
  // Links back to the run/chat that produced or worked this card (spec §6).
  run_id: z.string().nullable(),
  chat_id: z.string().nullable(),
  // --- structure layer (migration 006) ---
  // The goal this task traces back to (the "why"), or null.
  goal_id: z.string().nullable(),
  // Execution lock: the run id that has this task checked out; null = free. The
  // heartbeat claims a task by atomically setting this only when it is null.
  locked_by: z.string().nullable(),
  // When the lock was taken (ISO), so a stale lock can be reclaimed.
  locked_at: isoTimestamp.nullable(),
  // DB-backed wakeup queue: the heartbeat skips a task until now >= wake_at.
  wake_at: isoTimestamp.nullable(),
  // Chat the agent resumes across heartbeats (defaults to chat_id).
  context_ref: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  // --- board annotations (computed by TasksRepo.list, not stored columns) ---
  // Why a Blocked card is blocked (the note on its latest Blocked transition).
  blocked_reason: z.string().nullable().optional(),
  // 1 when a pending approval gate exists for this task (0/absent otherwise).
  awaiting_approval: z.number().int().optional()
})
export type Task = z.infer<typeof Task>

// Status transitions for a task (spec §6/§10) — the audit trail that feeds the
// Live Activity pane (claimed / working / blocked / finished).
export const TaskEvent = z.object({
  id: z.string(),
  task_id: z.string(),
  from_status: TaskStatus.nullable(),
  to_status: TaskStatus,
  // Who/what made the transition (user id or agent name).
  actor: z.string().nullable(),
  note: z.string().nullable(),
  created_at: isoTimestamp
})
export type TaskEvent = z.infer<typeof TaskEvent>

// An agent execution (spec §7 runtime loop). Manager/worker relationships are
// captured via parent_run_id so multi-agent fleets are observable (spec §8).
export const Run = z.object({
  id: z.string(),
  agent_id: z.string().nullable(),
  project_id: z.string().nullable(),
  chat_id: z.string().nullable(),
  task_id: z.string().nullable(),
  parent_run_id: z.string().nullable(),
  status: RunStatus,
  // JSON-encoded goal/input and final result/output for replay.
  input: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  started_at: isoTimestamp.nullable(),
  finished_at: isoTimestamp.nullable(),
  // --- structure layer (migration 006) ---
  // The goal this run served, the heartbeat tick that produced it, and the
  // captured cost (tokens/USD) + the provider/model that incurred it. cost_usd
  // and the token counts stay null until cost capture lands (a later phase).
  goal_id: z.string().nullable(),
  heartbeat_seq: z.number().int(),
  prompt_tokens: z.number().int().nullable(),
  completion_tokens: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Run = z.infer<typeof Run>

// Structured memory rows (spec §5). The embedded chunk lives alongside in the
// sqlite-vec `memory_vectors` table, joined by `id`.
export const Memory = z.object({
  id: z.string(),
  scope: MemoryScope,
  kind: MemoryKind,
  // The tier anchor: chat id for session scope, project id for project scope,
  // null for global. Kept generic so one column serves all three tiers.
  scope_ref: z.string().nullable(),
  project_id: z.string().nullable(),
  content: z.string(),
  // JSON-encoded structured metadata (source, tags, etc.).
  metadata: z.string().nullable(),
  // Whether an embedding has been generated into memory_vectors.
  embedded: z.number().int(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Memory = z.infer<typeof Memory>

// Knowledge-graph memory (spec §5, migration 002). Entities = nodes, relations
// = edges. `type` and `provenance` are stored as free TEXT so extraction can
// introduce new kinds without a migration — kept as z.string() on the wire.
export const MemoryEntity = z.object({
  id: z.string(),
  name: z.string(),
  normalized_name: z.string(),
  type: z.string(),
  summary: z.string().nullable(),
  scope: MemoryScope,
  scope_ref: z.string().nullable(),
  project_id: z.string().nullable(),
  mention_count: z.number().int(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type MemoryEntity = z.infer<typeof MemoryEntity>

// Provenance mirrors Graphify's labelling: a fact stated outright vs. derived.
export const memoryProvenanceValues = ['extracted', 'inferred', 'ambiguous'] as const
export const MemoryProvenance = z.enum(memoryProvenanceValues)
export type MemoryProvenance = z.infer<typeof MemoryProvenance>

export const MemoryRelation = z.object({
  id: z.string(),
  source_id: z.string(),
  target_id: z.string(),
  relation: z.string(),
  provenance: z.string(),
  weight: z.number(),
  source_memory_id: z.string().nullable(),
  valid: z.number().int(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type MemoryRelation = z.infer<typeof MemoryRelation>

// Provider config/state (spec §10). CRITICAL: NO SECRETS here — keys/tokens
// live only in the OS keychain (spec §2), referenced by `secret_ref`.
export const Provider = z.object({
  id: z.string(),
  // Adapter kind, e.g. 'anthropic' | 'openai' | 'google' | 'openai-compatible'
  // | 'codex' | 'grok'. Free-form string so adapters can be added without a
  // migration.
  kind: z.string(),
  label: z.string(),
  // Auth method in use: 'api_key' | 'oauth'.
  auth_method: z.string().nullable(),
  // Opaque keychain id — the ONLY link to a secret. Never the secret itself.
  secret_ref: z.string().nullable(),
  // For the OpenAI-compatible adapter (OpenRouter/Groq/custom).
  base_url: z.string().nullable(),
  enabled: z.number().int(),
  // JSON-encoded provider config (reachable models, token freshness, etc.).
  config: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Provider = z.infer<typeof Provider>

// A scheduled task/agent run (spec §7 scheduler). Kept minimal for v1.
export const Schedule = z.object({
  id: z.string(),
  name: z.string(),
  // Cron expression OR a plain-language preset like 'daily' / 'weekly'.
  cron: z.string().nullable(),
  agent_id: z.string().nullable(),
  project_id: z.string().nullable(),
  // JSON-encoded payload describing what to run.
  payload: z.string().nullable(),
  enabled: z.number().int(),
  last_run_at: isoTimestamp.nullable(),
  next_run_at: isoTimestamp.nullable(),
  // Trailing failed firings (migration 007) — the scheduler's circuit breaker
  // auto-disables a schedule after repeated consecutive failures.
  consecutive_failures: z.number().int(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Schedule = z.infer<typeof Schedule>

// Simple key/value app settings (spec §10), e.g. data location, constitution
// file path, default embedding dimension.
export const Setting = z.object({
  key: z.string(),
  value: z.string(),
  updated_at: isoTimestamp
})
export type Setting = z.infer<typeof Setting>

// --- Structure-layer rows (migration 006) ----------------------------------

// An objective/goal above the board. `parent_goal_id` chains objective→goal;
// tasks link up to a goal via `tasks.goal_id` so every task knows its "why".
export const Goal = z.object({
  id: z.string(),
  parent_goal_id: z.string().nullable(),
  project_id: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: GoalStatus,
  owner_agent_id: z.string().nullable(),
  budget_id: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Goal = z.infer<typeof Goal>

// A first-class dependency edge: `task_id` is blocked by `depends_on_task_id`.
export const TaskDependency = z.object({
  id: z.string(),
  task_id: z.string(),
  depends_on_task_id: z.string(),
  kind: DependencyKind,
  created_at: isoTimestamp
})
export type TaskDependency = z.infer<typeof TaskDependency>

// A scoped spend budget. `spent_usd` is denormalized for a cheap pre-run check
// and reconciled from the cost_events ledger.
export const Budget = z.object({
  id: z.string(),
  scope: BudgetScope,
  scope_ref: z.string().nullable(),
  limit_usd: z.number().nullable(),
  warn_usd: z.number().nullable(),
  period: z.string(),
  spent_usd: z.number(),
  state: BudgetState,
  created_at: isoTimestamp,
  updated_at: isoTimestamp
})
export type Budget = z.infer<typeof Budget>

// One append-only spend ledger entry, attributed across every dimension.
export const CostEvent = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  task_id: z.string().nullable(),
  goal_id: z.string().nullable(),
  project_id: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  prompt_tokens: z.number().int().nullable(),
  completion_tokens: z.number().int().nullable(),
  cost_usd: z.number(),
  created_at: isoTimestamp
})
export type CostEvent = z.infer<typeof CostEvent>

// A durable audit-log entry. `kind` is free TEXT so new event types need no
// migration; `payload` is a JSON blob that carries a denormalized `summary`
// string the Activity feed renders without joins.
export const ActivityEvent = z.object({
  id: z.string(),
  kind: z.string(),
  actor: z.string().nullable(),
  agent_id: z.string().nullable(),
  task_id: z.string().nullable(),
  goal_id: z.string().nullable(),
  run_id: z.string().nullable(),
  project_id: z.string().nullable(),
  payload: z.string().nullable(),
  created_at: isoTimestamp
})
export type ActivityEvent = z.infer<typeof ActivityEvent>

// An approval gate: an agent paused before a side-effect ships, awaiting a
// decision.
export const Approval = z.object({
  id: z.string(),
  task_id: z.string().nullable(),
  run_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  gate: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  status: ApprovalStatus,
  decided_by: z.string().nullable(),
  decided_at: isoTimestamp.nullable(),
  created_at: isoTimestamp
})
export type Approval = z.infer<typeof Approval>
