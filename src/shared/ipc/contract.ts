import { z } from 'zod'
import {
  Chat,
  Message,
  Task,
  TaskEvent,
  Agent,
  Memory,
  MemoryEntity,
  MemoryRelation,
  Project,
  Schedule,
  Setting,
  ActivityEvent,
  Goal,
  GoalStatus,
  DependencyKind,
  Approval,
  ApprovalStatus,
  AgentLifecycle,
  TaskStatus,
  MemoryScope,
  MemoryKind,
  PermissionMode,
  isoTimestamp
} from '@shared/db/types'
import { CADENCES } from '@shared/scheduler'

// Typed IPC contract (spec §11: "Typed IPC with Zod-validated payloads both
// directions"). Channel names live here as constants; every response has a Zod
// schema the main process validates before returning, so a malformed payload is
// caught at the boundary rather than surfacing as an undefined deep in the UI.
//
// This module is renderer-safe: it imports only zod (no native/electron code),
// so both the preload bridge and the renderer can import the inferred types.

export const IPC = {
  ping: 'app:ping',
  dbHealth: 'db:health',
  secretsHealth: 'secrets:health',
  secretsSelfTest: 'secrets:selftest',
  // Providers (spec §4)
  providersList: 'providers:list',
  providersSaveKey: 'providers:saveKey',
  providersRemoveKey: 'providers:removeKey',
  providersOauthLogin: 'providers:oauthLogin',
  providersOauthLogout: 'providers:oauthLogout',
  providersSetEnabled: 'providers:setEnabled',
  providersSetModelEnabled: 'providers:setModelEnabled',
  providersSetModelsEnabled: 'providers:setModelsEnabled',
  dialogPickFolder: 'folder:pick',
  dialogPickFiles: 'files:pick',
  clipboardWrite: 'clipboard:write',
  // Open / save-a-copy of a generated file (the create_file tool's output).
  filesOpen: 'files:open',
  filesSaveAs: 'files:saveAs',
  // History (spec §8)
  chatsList: 'chats:list',
  chatsGet: 'chats:get',
  chatsCreate: 'chats:create',
  chatsRename: 'chats:rename',
  chatsSetProject: 'chats:setProject',
  chatsDelete: 'chats:delete',
  // Streaming chat (spec §4 / Phase 2)
  chatSend: 'chat:send',
  chatRetry: 'chat:retry',
  chatCancel: 'chat:cancel',
  // Main → renderer stream events (one-way; see preload onChatStream).
  chatStream: 'chat:stream',
  // Agent tool approval (spec §7 Ask mode): main → renderer asks to approve a
  // side-effecting action; renderer replies via chatConfirmRespond.
  chatConfirm: 'chat:confirm',
  chatConfirmRespond: 'chat:confirmRespond',
  // Tasks / Kanban board (spec §6)
  tasksList: 'tasks:list',
  tasksCreate: 'tasks:create',
  tasksUpdate: 'tasks:update',
  tasksMove: 'tasks:move',
  tasksDelete: 'tasks:delete',
  // Run one task NOW through the autonomous worker, in the background (no chat
  // navigation). The worker claims it (→ In Progress) and works it as its agent.
  tasksWorkNow: 'tasks:workNow',
  taskEvents: 'tasks:events',
  tasksActivity: 'tasks:activity',
  // Main → renderer broadcast: a task changed (created/claimed/moved) anywhere —
  // the autonomous worker, a schedule, or another window. Lets the board refresh
  // live instead of going stale until a manual reload (see preload tasks.onChanged).
  tasksChanged: 'tasks:changed',
  // Multi-agent delegation (spec §7): a manager decomposes a task into subtasks.
  tasksDelegate: 'tasks:delegate',
  // Rework-with-feedback: re-queue a reviewed task with the user's critique
  // threaded into its working chat (the resumed run sees what to fix).
  taskRework: 'tasks:rework',
  // Agents library (spec §7)
  agentsList: 'agents:list',
  agentsCreate: 'agents:create',
  agentsUpdate: 'agents:update',
  agentsDelete: 'agents:delete',
  // Projects (spec §7) — scope chats/tasks/memory.
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  projectsUpdate: 'projects:update',
  projectsDelete: 'projects:delete',
  // Scheduler (spec §7) — run an agent on a goal on a cadence.
  schedulesList: 'schedules:list',
  schedulesCreate: 'schedules:create',
  schedulesUpdate: 'schedules:update',
  schedulesDelete: 'schedules:delete',
  schedulesRunNow: 'schedules:runNow',
  // Memory browser (spec §5)
  memoriesList: 'memories:list',
  memoriesCreate: 'memories:create',
  memoriesUpdate: 'memories:update',
  memoriesDelete: 'memories:delete',
  memoryGraph: 'memory:graph',
  memoryEntity: 'memory:entity',
  memoryStatus: 'memory:status',
  memorySetAuto: 'memory:setAuto',
  // Embedding provider selection + re-embed (structure layer / memory).
  memorySetEmbedding: 'memory:setEmbedding',
  memoryReembed: 'memory:reembed',
  // Objectives / goals (structure layer) — the "why" above the board.
  goalsList: 'goals:list',
  goalGet: 'goals:get',
  goalsCreate: 'goals:create',
  goalsUpdate: 'goals:update',
  goalsDelete: 'goals:delete',
  // Task ↔ goal link + first-class blocker dependencies (structure layer).
  taskSetGoal: 'tasks:setGoal',
  taskDependencies: 'tasks:dependencies',
  taskDependencyAdd: 'tasks:dependencyAdd',
  taskDependencyRemove: 'tasks:dependencyRemove',
  // Activity log (structure layer) — the durable audit feed.
  activityList: 'activity:list',
  // Count of unseen review-worthy events (the rail badge; cheaper than list).
  activityUnseenCount: 'activity:unseenCount',
  // Mark the activity feed as seen (clears the rail's "new" badge).
  activityMarkSeen: 'activity:markSeen',
  // Approvals + agent lifecycle (structure layer, governance) — the gate inbox
  // and pause/resume/terminate.
  approvalsList: 'approvals:list',
  // Count of pending approvals (the rail badge; cheaper than list).
  approvalsPendingCount: 'approvals:pendingCount',
  approvalsDecide: 'approvals:decide',
  agentsSetLifecycle: 'agents:setLifecycle',
  // Team (structure layer) — the agent reporting tree + live heartbeat.
  agentsOrgChart: 'agents:orgChart',
  // Autonomous task worker (spec §7)
  workerStatus: 'worker:status',
  workerSetEnabled: 'worker:setEnabled',
  workerSetInterval: 'worker:setInterval',
  workerRunNow: 'worker:runNow',
  // MCP (Model Context Protocol) servers — external tool servers the agent
  // toolset can call once the orchestrator wires them in (structure layer).
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  // Settings / app config (spec §10)
  settingsAll: 'settings:all',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsDataPaths: 'settings:dataPaths',
  // Costs (structure layer) — month-to-date spend + budget for the Budget
  // settings section and the autonomous worker's pre-run budget gate.
  costsSummary: 'costs:summary'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export const PingResult = z.object({
  ok: z.literal(true),
  ts: z.number(),
  version: z.string()
})
export type PingResult = z.infer<typeof PingResult>

export const DbHealthResult = z.object({
  currentVersion: z.number().int(),
  tables: z.array(z.string()),
  vecAvailable: z.boolean()
})
export type DbHealthResult = z.infer<typeof DbHealthResult>

export const SecretsHealthResult = z.object({
  backend: z.enum(['keytar', 'safeStorage', 'unavailable']),
  available: z.boolean()
})
export type SecretsHealthResult = z.infer<typeof SecretsHealthResult>

// Diagnostic only: round-trips a throwaway secret through the real keychain to
// prove the secure store works in the live runtime (asserted by the smoke test).
export const SecretsSelfTestResult = z.object({
  ok: z.boolean(),
  roundTrip: z.boolean(),
  backend: z.enum(['keytar', 'safeStorage', 'unavailable'])
})
export type SecretsSelfTestResult = z.infer<typeof SecretsSelfTestResult>

// --- Providers (spec §4) ---------------------------------------------------

export const ModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  contextWindow: z.number().int().optional()
})
export type ModelInfoSchema = z.infer<typeof ModelInfoSchema>

// OAuth status for providers that support it (xAI subscription, OpenAI Codex).
export const OAuthStatus = z.object({
  // Whether an OAuth session is currently active.
  connected: z.boolean(),
  // Whether the prerequisite is present (e.g. the Codex CLI is installed).
  available: z.boolean(),
  // The signed-in account identifier (email/plan), when known.
  account: z.string().nullable(),
  // Access-token expiry (epoch ms), when we manage the token (xAI). null = n/a.
  expiresAt: z.number().nullable(),
  // True when the provider needs an external CLI (Codex) the user must install.
  requiresCli: z.boolean()
})
export type OAuthStatus = z.infer<typeof OAuthStatus>

// Status for a keyless LOCAL provider (Ollama): reachability + endpoint.
export const LocalStatus = z.object({
  reachable: z.boolean(),
  baseUrl: z.string()
})
export type LocalStatus = z.infer<typeof LocalStatus>

export const ProviderStatus = z.object({
  kind: z.string(),
  label: z.string(),
  // Whether the provider is usable right now (a key saved, an OAuth session, or
  // a reachable local endpoint).
  connected: z.boolean(),
  // User on/off toggle, independent of credentials: a disabled provider keeps
  // its key/OAuth but is hidden from the model picker and can't be used.
  enabled: z.boolean(),
  // Model ids the user has switched off for this provider (hidden from picking).
  disabledModels: z.array(z.string()),
  // Whether this provider can do web search at all — natively OR via Sunny's own
  // web tools (true when webMode !== null).
  webCapable: z.boolean(),
  // How web search works for this provider: 'native' = the provider's own search
  // (OpenAI/Gemini/Anthropic/Perplexity); 'tool' = Sunny runs keyless web tools
  // for it (Ollama/Grok/OpenRouter/Groq); null = no web access.
  webMode: z.enum(['native', 'tool']).nullable(),
  // Auth methods this provider supports. 'local' = keyless local daemon (Ollama).
  authMethods: z.array(z.enum(['api_key', 'oauth', 'local'])),
  // The method currently configured/active, if any.
  activeAuth: z.enum(['api_key', 'oauth', 'local']).nullable(),
  defaultModel: z.string(),
  models: z.array(ModelInfoSchema),
  // Present only when 'oauth' is in authMethods.
  oauth: OAuthStatus.optional(),
  // Present only when 'local' is in authMethods.
  local: LocalStatus.optional()
})
export type ProviderStatus = z.infer<typeof ProviderStatus>

export const ProvidersListResult = z.array(ProviderStatus)
export type ProvidersListResult = z.infer<typeof ProvidersListResult>

export const SaveKeyParams = z.object({ kind: z.string(), apiKey: z.string().min(1) })
export type SaveKeyParams = z.infer<typeof SaveKeyParams>

export const SaveKeyResult = z.object({ ok: z.boolean(), error: z.string().optional() })
export type SaveKeyResult = z.infer<typeof SaveKeyResult>

export const RemoveKeyParams = z.object({ kind: z.string() })
export type RemoveKeyParams = z.infer<typeof RemoveKeyParams>

// Drive an OAuth login (opens the system browser / device flow) for a provider.
export const OAuthLoginParams = z.object({ kind: z.string() })
export type OAuthLoginParams = z.infer<typeof OAuthLoginParams>

export const OAuthLoginResult = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  account: z.string().nullable().optional()
})
export type OAuthLoginResult = z.infer<typeof OAuthLoginResult>

export const OAuthLogoutParams = z.object({ kind: z.string() })
export type OAuthLogoutParams = z.infer<typeof OAuthLogoutParams>

// Toggle a provider on/off without removing its key/OAuth.
export const SetProviderEnabledParams = z.object({ kind: z.string(), enabled: z.boolean() })
export type SetProviderEnabledParams = z.infer<typeof SetProviderEnabledParams>

// Toggle a single model on/off under a provider.
export const SetModelEnabledParams = z.object({
  kind: z.string(),
  model: z.string(),
  enabled: z.boolean()
})
export type SetModelEnabledParams = z.infer<typeof SetModelEnabledParams>

// Toggle MANY models on/off at once (bulk "enable/disable all", or all currently
// shown by a search filter) — one round trip instead of N.
export const SetModelsEnabledParams = z.object({
  kind: z.string(),
  models: z.array(z.string()),
  enabled: z.boolean()
})
export type SetModelsEnabledParams = z.infer<typeof SetModelsEnabledParams>

// "Chat in Folder": result of the native folder picker. path is null on cancel.
export const FolderPickResult = z.object({
  path: z.string().nullable(),
  name: z.string().nullable(),
  fileCount: z.number().int(),
  tree: z.string(),
  truncated: z.boolean()
})
export type FolderPickResult = z.infer<typeof FolderPickResult>

export const OkResult = z.object({ ok: z.boolean() })
export type OkResult = z.infer<typeof OkResult>

// An image attached to a chat message, sent to vision-capable models. `dataUrl`
// is a self-contained `data:<mediaType>;base64,…` URL (also used for thumbnails).
export const ImageAttachment = z.object({
  name: z.string(),
  mediaType: z.string(),
  dataUrl: z.string()
})
export type ImageAttachment = z.infer<typeof ImageAttachment>

// "Attach files": one file the user attached to a chat message. Text/document
// files carry extracted UTF-8 `content` (capped; `truncated` if over the cap);
// image files carry `mediaType` + `dataUrl` instead (kind: 'image').
export const FileAttachment = z.object({
  name: z.string(),
  kind: z.enum(['text', 'image']).default('text'),
  content: z.string().default(''),
  bytes: z.number().int(),
  truncated: z.boolean().default(false),
  // Present only for kind: 'image'.
  mediaType: z.string().optional(),
  dataUrl: z.string().optional()
})
export type FileAttachment = z.infer<typeof FileAttachment>

// Result of the native file picker: the readable text files, plus the names of
// any that were skipped (binary, unreadable, or over the total size cap).
export const FilePickResult = z.object({
  files: z.array(FileAttachment),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() }))
})
export type FilePickResult = z.infer<typeof FilePickResult>

// --- History (spec §8) -----------------------------------------------------

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  // The project this chat belongs to (null = unfiled). Lets the sidebar group
  // chats under their project folder.
  project_id: z.string().nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  messageCount: z.number().int(),
  lastMessageAt: isoTimestamp.nullable()
})
export type ChatSummary = z.infer<typeof ChatSummary>

// Optional project scope for the history list: omitted = all chats, a string =
// that project's chats, null = unattached chats.
export const ChatsListParams = z.object({ projectId: z.string().nullable().optional() })
export type ChatsListParams = z.infer<typeof ChatsListParams>

export const ChatsListResult = z.array(ChatSummary)
export type ChatsListResult = z.infer<typeof ChatsListResult>

export const ChatGetParams = z.object({ chatId: z.string() })
export type ChatGetParams = z.infer<typeof ChatGetParams>

export const ChatGetResult = z.object({ chat: Chat, messages: z.array(Message) })
export type ChatGetResult = z.infer<typeof ChatGetResult>

export const ChatCreateParams = z.object({
  title: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  // Run this chat as a specific agent (its system prompt is injected). spec §7.
  agentId: z.string().optional(),
  // Scope this chat to a project (spec §7); omitted/unset = unattached.
  projectId: z.string().optional()
})
export type ChatCreateParams = z.infer<typeof ChatCreateParams>

export const ChatCreateResult = Chat
export type ChatCreateResult = z.infer<typeof ChatCreateResult>

export const ChatRenameParams = z.object({ chatId: z.string(), title: z.string() })
export type ChatRenameParams = z.infer<typeof ChatRenameParams>

// Write text to the OS clipboard (main-process clipboard; reliable in the
// sandboxed renderer). Used by the chat bubbles' copy buttons.
export const ClipboardWriteParams = z.object({ text: z.string() })
export type ClipboardWriteParams = z.infer<typeof ClipboardWriteParams>

// Open a generated file in the OS default app, or save a copy of it elsewhere.
// The main process validates the path is inside Sunny's generated-files dir.
export const FileOpenParams = z.object({ path: z.string() })
export type FileOpenParams = z.infer<typeof FileOpenParams>

export const FileSaveAsParams = z.object({ path: z.string(), name: z.string() })
export type FileSaveAsParams = z.infer<typeof FileSaveAsParams>

// Move a chat to a project (or to "Unfiled" with projectId: null).
export const ChatSetProjectParams = z.object({
  chatId: z.string(),
  projectId: z.string().nullable()
})
export type ChatSetProjectParams = z.infer<typeof ChatSetProjectParams>

export const ChatDeleteParams = z.object({ chatId: z.string() })
export type ChatDeleteParams = z.infer<typeof ChatDeleteParams>

// --- Streaming chat (spec §4 / Phase 2) ------------------------------------

export const ChatSendParams = z.object({
  chatId: z.string(),
  content: z.string().min(1),
  model: z.string(),
  // Provider kind for this turn. Lets the user switch provider+model
  // mid-conversation (spec §1). Falls back to the chat's provider, then openai.
  provider: z.string().optional(),
  // Optional working folder (spec §9 "Chat in Folder"): its file tree is
  // injected as context so the assistant understands the project.
  folderPath: z.string().optional(),
  // Per-message web-search toggle (the composer 🔍 button). When on, the model
  // searches the web — natively if it can, else via Sunny's own web tools.
  webSearch: z.boolean().optional(),
  // The composer's permission mode for this interactive turn (Ask confirms each
  // tool action, Plan blocks them, Autopilot runs them). Overrides the chat
  // agent's stored mode for interactive runs; omitted falls back to that.
  permissionMode: PermissionMode.optional(),
  // Images attached to this turn, sent to vision-capable models and persisted on
  // the user message so the model still sees them on later turns.
  images: z.array(ImageAttachment).optional()
})
export type ChatSendParams = z.infer<typeof ChatSendParams>

// chat:send resolves quickly with the persisted user message + a streamId; the
// assistant reply arrives as ChatStreamEvent deltas, then a final 'done' event
// carrying the persisted assistant Message.
export const ChatSendResult = z.object({
  streamId: z.string(),
  userMessage: Message,
  // Set only when this send auto-derived a title for a previously-untitled
  // chat, so the header can reflect it live (no reload needed).
  title: z.string().optional()
})
export type ChatSendResult = z.infer<typeof ChatSendResult>

// chat:retry re-streams the assistant reply for the chat's EXISTING trailing
// user turn (after a failed stream) — it does NOT persist a new user message,
// so retrying never duplicates the prompt or drops its images (they're already
// on the persisted turn). Same knobs as send, minus content/images.
export const ChatRetryParams = z.object({
  chatId: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  folderPath: z.string().optional(),
  webSearch: z.boolean().optional(),
  permissionMode: PermissionMode.optional()
})
export type ChatRetryParams = z.infer<typeof ChatRetryParams>

export const ChatRetryResult = z.object({ streamId: z.string() })
export type ChatRetryResult = z.infer<typeof ChatRetryResult>

export const ChatCancelParams = z.object({ streamId: z.string() })
export type ChatCancelParams = z.infer<typeof ChatCancelParams>

export const ChatStreamEvent = z.discriminatedUnion('type', [
  z.object({ streamId: z.string(), type: z.literal('delta'), text: z.string() }),
  // Transient progress (e.g. "🔎 Searching the web…") shown live but NOT part of
  // the saved answer — only delta text is accumulated.
  z.object({ streamId: z.string(), type: z.literal('status'), text: z.string() }),
  // The model's reasoning (thinking summaries / <think> blocks) — rendered in a
  // collapsible section of the live bubble and persisted on the saved message.
  z.object({ streamId: z.string(), type: z.literal('thinking'), text: z.string() }),
  z.object({ streamId: z.string(), type: z.literal('done'), message: Message }),
  z.object({ streamId: z.string(), type: z.literal('error'), message: z.string() })
])
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>

// Main → renderer: ask the user to approve a side-effecting agent tool action
// (Ask mode, or a destructive action under Autopilot). The renderer shows a
// modal and replies with ChatConfirmRespondParams (matched by requestId).
export const ChatConfirmRequest = z.object({
  streamId: z.string(),
  requestId: z.string(),
  // The tool id (e.g. 'write_file', 'run_command').
  tool: z.string(),
  // Short dialog title + a one-line description of exactly what will happen.
  title: z.string(),
  detail: z.string()
})
export type ChatConfirmRequest = z.infer<typeof ChatConfirmRequest>

export const ChatConfirmRespondParams = z.object({
  requestId: z.string(),
  allow: z.boolean()
})
export type ChatConfirmRespondParams = z.infer<typeof ChatConfirmRespondParams>

// --- Tasks / Kanban (spec §6) ----------------------------------------------

export const TasksListParams = z.object({ projectId: z.string().nullable().optional() })
export type TasksListParams = z.infer<typeof TasksListParams>
export const TasksListResult = z.array(Task)
export type TasksListResult = z.infer<typeof TasksListResult>

// Main → renderer broadcast payload for `tasks:changed`. `kind` is the activity
// kind that triggered it (task.created/claimed/moved); `projectId` lets a scoped
// board decide whether the change is in view (null = unattached / all scopes).
export const TasksChangedEvent = z.object({
  kind: z.string(),
  taskId: z.string().nullable(),
  projectId: z.string().nullable()
})
export type TasksChangedEvent = z.infer<typeof TasksChangedEvent>

export const TaskCreateParams = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: TaskStatus.optional(),
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  chatId: z.string().optional()
})
export type TaskCreateParams = z.infer<typeof TaskCreateParams>

export const TaskUpdateParams = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  status: TaskStatus.optional(),
  assignee: z.string().nullable().optional(),
  sortOrder: z.number().int().optional()
})
export type TaskUpdateParams = z.infer<typeof TaskUpdateParams>

// Drag-and-drop move: change column and/or ordering. Writes a task_event.
export const TaskMoveParams = z.object({
  id: z.string(),
  status: TaskStatus,
  sortOrder: z.number().int().optional(),
  actor: z.string().optional()
})
export type TaskMoveParams = z.infer<typeof TaskMoveParams>

export const TaskDeleteParams = z.object({ id: z.string() })
export type TaskDeleteParams = z.infer<typeof TaskDeleteParams>

// Work one task now in the background (the worker runs it as its agent).
export const TaskWorkNowParams = z.object({ id: z.string() })
export type TaskWorkNowParams = z.infer<typeof TaskWorkNowParams>

export const TaskEventsParams = z.object({ taskId: z.string() })
export type TaskEventsParams = z.infer<typeof TaskEventsParams>
export const TaskEventsResult = z.array(TaskEvent)
export type TaskEventsResult = z.infer<typeof TaskEventsResult>

// Recent board transitions across all tasks — the live data behind the Live
// Activity pane (a task_events row + its task title + chat link).
export const TaskActivityItem = z.object({
  id: z.string(),
  task_id: z.string(),
  task_title: z.string(),
  chat_id: z.string().nullable(),
  from_status: TaskStatus.nullable(),
  to_status: TaskStatus,
  actor: z.string().nullable(),
  note: z.string().nullable(),
  created_at: isoTimestamp,
  // The task's CURRENT status, so the rail animates only genuinely-live work.
  task_status: TaskStatus
})
export type TaskActivityItem = z.infer<typeof TaskActivityItem>

export const TaskActivityParams = z.object({ limit: z.number().int().min(1).max(100).optional() })
export type TaskActivityParams = z.infer<typeof TaskActivityParams>
export const TaskActivityResult = z.array(TaskActivityItem)
export type TaskActivityResult = z.infer<typeof TaskActivityResult>

// Multi-agent delegation: a manager agent decomposes the task into subtasks and
// dispatches each to a worker agent. Both agents default to the board's default
// agent when omitted. Fire-and-forget — progress shows on the board.
export const TaskDelegateParams = z.object({
  taskId: z.string(),
  managerAgentId: z.string().optional(),
  workerAgentId: z.string().optional()
})
export type TaskDelegateParams = z.infer<typeof TaskDelegateParams>

// Re-queue a reviewed task with the user's critique (rework-with-feedback).
export const TaskReworkParams = z.object({
  id: z.string(),
  feedback: z.string().min(1)
})
export type TaskReworkParams = z.infer<typeof TaskReworkParams>

// --- Agents (spec §7) ------------------------------------------------------

export const AgentsListResult = z.array(Agent)
export type AgentsListResult = z.infer<typeof AgentsListResult>

export const AgentCreateParams = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  systemPrompt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  permissionMode: PermissionMode.optional(),
  allowedTools: z.array(z.string()).optional(),
  // When this agent runs autonomously (the board worker), enable web access.
  webAccess: z.boolean().optional()
})
export type AgentCreateParams = z.infer<typeof AgentCreateParams>

export const AgentUpdateParams = z.object({
  id: z.string(),
  name: z.string().optional(),
  role: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  permissionMode: PermissionMode.optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  webAccess: z.boolean().optional(),
  // Structure layer (Phase 5): reporting line + org title. `managerId: null`
  // makes the agent a lead; a self-reference is coerced to null by the repo.
  managerId: z.string().nullable().optional(),
  title: z.string().nullable().optional()
})
export type AgentUpdateParams = z.infer<typeof AgentUpdateParams>

export const AgentDeleteParams = z.object({ id: z.string() })
export type AgentDeleteParams = z.infer<typeof AgentDeleteParams>

// --- Projects (spec §7) ----------------------------------------------------

export const ProjectsListParams = z.object({ includeArchived: z.boolean().optional() })
export type ProjectsListParams = z.infer<typeof ProjectsListParams>
export const ProjectsListResult = z.array(Project)
export type ProjectsListResult = z.infer<typeof ProjectsListResult>

export const ProjectCreateParams = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional()
})
export type ProjectCreateParams = z.infer<typeof ProjectCreateParams>

export const ProjectUpdateParams = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional()
})
export type ProjectUpdateParams = z.infer<typeof ProjectUpdateParams>

export const ProjectDeleteParams = z.object({ id: z.string() })
export type ProjectDeleteParams = z.infer<typeof ProjectDeleteParams>

// --- Scheduler (spec §7) ---------------------------------------------------

export const Cadence = z.enum(CADENCES)
export type Cadence = z.infer<typeof Cadence>

export const SchedulesListResult = z.array(Schedule)
export type SchedulesListResult = z.infer<typeof SchedulesListResult>

export const ScheduleCreateParams = z.object({
  name: z.string().min(1),
  // The goal the agent runs each time it fires.
  prompt: z.string().optional(),
  cadence: Cadence,
  agentId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  // Optional model override for this schedule's runs (provider kind + model id).
  // When set, the run uses this instead of the agent's pinned/fallback model.
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional()
})
export type ScheduleCreateParams = z.infer<typeof ScheduleCreateParams>

export const ScheduleUpdateParams = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  prompt: z.string().optional(),
  cadence: Cadence.optional(),
  agentId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional()
})
export type ScheduleUpdateParams = z.infer<typeof ScheduleUpdateParams>

export const ScheduleDeleteParams = z.object({ id: z.string() })
export type ScheduleDeleteParams = z.infer<typeof ScheduleDeleteParams>

export const ScheduleRunNowParams = z.object({ id: z.string() })
export type ScheduleRunNowParams = z.infer<typeof ScheduleRunNowParams>

// --- Memory (spec §5) ------------------------------------------------------

export const MemoriesListParams = z.object({
  scope: MemoryScope.optional(),
  // Free-text substring filter over content (semantic vec search lands later).
  query: z.string().optional(),
  // Scope the browser to one project's own memories (omitted = all).
  projectId: z.string().optional()
})
export type MemoriesListParams = z.infer<typeof MemoriesListParams>
export const MemoriesListResult = z.array(Memory)
export type MemoriesListResult = z.infer<typeof MemoriesListResult>

export const MemoryCreateParams = z.object({
  content: z.string().min(1),
  scope: MemoryScope.optional(),
  kind: MemoryKind.optional(),
  scopeRef: z.string().optional(),
  projectId: z.string().optional(),
  metadata: z.string().optional()
})
export type MemoryCreateParams = z.infer<typeof MemoryCreateParams>

export const MemoryUpdateParams = z.object({
  id: z.string(),
  content: z.string().optional(),
  scope: MemoryScope.optional(),
  kind: MemoryKind.optional()
})
export type MemoryUpdateParams = z.infer<typeof MemoryUpdateParams>

export const MemoryDeleteParams = z.object({ id: z.string() })
export type MemoryDeleteParams = z.infer<typeof MemoryDeleteParams>

// Knowledge graph (spec §5). The Memory view renders this as a node-link graph.
export const MemoryGraphParams = z.object({
  scope: MemoryScope.optional(),
  projectId: z.string().optional(),
  limit: z.number().int().optional()
})
export type MemoryGraphParams = z.infer<typeof MemoryGraphParams>

export const MemoryGraphResult = z.object({
  entities: z.array(MemoryEntity),
  relations: z.array(MemoryRelation)
})
export type MemoryGraphResult = z.infer<typeof MemoryGraphResult>

export const MemoryEntityParams = z.object({ id: z.string() })
export type MemoryEntityParams = z.infer<typeof MemoryEntityParams>

// Entity detail: the node + its edges + the observations that mention it.
export const MemoryEntityDetail = z.object({
  entity: MemoryEntity,
  relations: z.array(MemoryRelation),
  observations: z.array(Memory)
})
export type MemoryEntityDetail = z.infer<typeof MemoryEntityDetail>

export const MemoryStatusResult = z.object({
  // Whether auto-capture/recall is enabled (user toggle).
  autoMemory: z.boolean(),
  // The provider/model used for embeddings, and whether it's usable right now.
  embeddingProvider: z.string().nullable(),
  embeddingModel: z.string().nullable(),
  embeddingsAvailable: z.boolean(),
  entityCount: z.number().int(),
  relationCount: z.number().int(),
  observationCount: z.number().int()
})
export type MemoryStatusResult = z.infer<typeof MemoryStatusResult>

export const MemorySetAutoParams = z.object({ enabled: z.boolean() })
export type MemorySetAutoParams = z.infer<typeof MemorySetAutoParams>

// Choose the memory embedding provider + model. Applies live (no restart): the
// vector table is re-sized to the new model's dimension and memories re-embed in
// the background. Returns the refreshed memory status.
export const MemorySetEmbeddingParams = z.object({
  provider: z.string(),
  model: z.string().min(1)
})
export type MemorySetEmbeddingParams = z.infer<typeof MemorySetEmbeddingParams>

// Re-embed all memories with the active embedder (backfill / after a switch).
export const MemoryReembedResult = z.object({
  embedded: z.number().int(),
  total: z.number().int()
})
export type MemoryReembedResult = z.infer<typeof MemoryReembedResult>

// --- Objectives / goals (structure layer) ----------------------------------

// A goal plus its direct-task progress rollup (tasks linked straight to it).
// The Objectives tree aggregates children on top of these per-goal counts.
export const GoalNode = Goal.extend({
  task_total: z.number().int(),
  task_done: z.number().int()
})
export type GoalNode = z.infer<typeof GoalNode>

export const GoalsListParams = z.object({ projectId: z.string().optional() })
export type GoalsListParams = z.infer<typeof GoalsListParams>
export const GoalsListResult = z.array(GoalNode)
export type GoalsListResult = z.infer<typeof GoalsListResult>

export const GoalGetParams = z.object({ id: z.string() })
export type GoalGetParams = z.infer<typeof GoalGetParams>
// The goal, its ancestry (root objective → this goal), and the tasks linked to it.
export const GoalGetResult = z.object({
  goal: Goal,
  ancestry: z.array(Goal),
  tasks: z.array(Task)
})
export type GoalGetResult = z.infer<typeof GoalGetResult>

export const GoalCreateParams = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  parentGoalId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  ownerAgentId: z.string().nullable().optional(),
  status: GoalStatus.optional()
})
export type GoalCreateParams = z.infer<typeof GoalCreateParams>

export const GoalUpdateParams = z.object({
  id: z.string(),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  parentGoalId: z.string().nullable().optional(),
  ownerAgentId: z.string().nullable().optional(),
  status: GoalStatus.optional()
})
export type GoalUpdateParams = z.infer<typeof GoalUpdateParams>

export const GoalDeleteParams = z.object({ id: z.string() })
export type GoalDeleteParams = z.infer<typeof GoalDeleteParams>

// --- Task ↔ goal + dependencies (structure layer) --------------------------

export const TaskSetGoalParams = z.object({
  taskId: z.string(),
  goalId: z.string().nullable()
})
export type TaskSetGoalParams = z.infer<typeof TaskSetGoalParams>

export const TaskDependenciesParams = z.object({ taskId: z.string() })
export type TaskDependenciesParams = z.infer<typeof TaskDependenciesParams>
// Both sides of a task's blocker edges, resolved to full task rows.
export const TaskDependenciesResult = z.object({
  blockers: z.array(Task),
  blocking: z.array(Task)
})
export type TaskDependenciesResult = z.infer<typeof TaskDependenciesResult>

export const TaskDependencyAddParams = z.object({
  taskId: z.string(),
  dependsOnTaskId: z.string(),
  kind: DependencyKind.optional()
})
export type TaskDependencyAddParams = z.infer<typeof TaskDependencyAddParams>

export const TaskDependencyRemoveParams = z.object({
  taskId: z.string(),
  dependsOnTaskId: z.string()
})
export type TaskDependencyRemoveParams = z.infer<typeof TaskDependencyRemoveParams>

// --- Activity log (structure layer) ----------------------------------------

// The durable audit feed. Optional filters: a recency cap, a set of `kind`s to
// include, and a project scope (its events + global events). The renderer maps
// its active project to `projectId: activeProjectId ?? undefined`.
export const ActivityListParams = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  kinds: z.array(z.string()).optional(),
  projectId: z.string().optional()
})
export type ActivityListParams = z.infer<typeof ActivityListParams>

export const ActivityListResult = z.array(ActivityEvent)
export type ActivityListResult = z.infer<typeof ActivityListResult>

// Count of unseen review-worthy events (newer than the seen watermark), for the
// rail badge — a single integer instead of shipping ≤100 full rows per poll.
export const ActivityUnseenCountParams = z.object({
  kinds: z.array(z.string()).optional(),
  projectId: z.string().optional()
})
export type ActivityUnseenCountParams = z.infer<typeof ActivityUnseenCountParams>

export const CountResult = z.object({ count: z.number().int().min(0) })
export type CountResult = z.infer<typeof CountResult>

// --- Approvals + agent lifecycle (structure layer, governance) --------------

// An approval gate joined to its task title + agent name + project, for the
// inbox. Mirrors the `ApprovalView` row the ApprovalsRepo returns.
export const ApprovalView = Approval.extend({
  task_title: z.string().nullable(),
  agent_name: z.string().nullable(),
  project_id: z.string().nullable()
})
export type ApprovalView = z.infer<typeof ApprovalView>

// Inbox query: optionally one status (the inbox passes 'pending') + project.
export const ApprovalsListParams = z.object({
  status: ApprovalStatus.optional(),
  projectId: z.string().optional()
})
export type ApprovalsListParams = z.infer<typeof ApprovalsListParams>

// Pending-approvals count for the rail badge (optionally project-scoped) —
// avoids pulling the full joined rows just to count them.
export const ApprovalsPendingCountParams = z.object({
  projectId: z.string().optional()
})
export type ApprovalsPendingCountParams = z.infer<typeof ApprovalsPendingCountParams>

export const ApprovalsListResult = z.array(ApprovalView)
export type ApprovalsListResult = z.infer<typeof ApprovalsListResult>

// A user decision on a gate. Only approve/reject are user-initiated (the worker
// owns 'pending'/'expired').
export const ApprovalDecideParams = z.object({
  id: z.string(),
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().optional()
})
export type ApprovalDecideParams = z.infer<typeof ApprovalDecideParams>

// Set an agent's governance lifecycle (paused agents are skipped by the worker).
export const AgentSetLifecycleParams = z.object({
  id: z.string(),
  state: AgentLifecycle
})
export type AgentSetLifecycleParams = z.infer<typeof AgentSetLifecycleParams>

// --- Team (structure layer) — the agent reporting tree ----------------------

// An agent enriched with the task it's currently working (its live heartbeat).
// `manager_id`/`title` (on Agent) define the tree; the renderer builds it.
export const AgentOrgNode = Agent.extend({
  current_task_id: z.string().nullable(),
  current_task_title: z.string().nullable()
})
export type AgentOrgNode = z.infer<typeof AgentOrgNode>

export const AgentsOrgChartResult = z.array(AgentOrgNode)
export type AgentsOrgChartResult = z.infer<typeof AgentsOrgChartResult>

// --- Autonomous task worker (spec §7) --------------------------------------

export const WorkerStatusResult = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int(),
  running: z.boolean(),
  lastScanAt: z.number().nullable()
})
export type WorkerStatusResult = z.infer<typeof WorkerStatusResult>

export const WorkerSetEnabledParams = z.object({ enabled: z.boolean() })
export type WorkerSetEnabledParams = z.infer<typeof WorkerSetEnabledParams>

export const WorkerSetIntervalParams = z.object({ minutes: z.number().int().min(1) })
export type WorkerSetIntervalParams = z.infer<typeof WorkerSetIntervalParams>

// --- MCP servers (structure layer) -----------------------------------------

// One configured MCP server (mirrors src/main/mcp/config.ts McpServerConfig —
// this schema is the renderer-safe copy the IPC boundary validates against).
export const McpServerConfig = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  enabled: z.boolean()
})
export type McpServerConfig = z.infer<typeof McpServerConfig>

// A configured server plus its live connection state, for the Settings list.
export const McpServerStatus = McpServerConfig.extend({
  connected: z.boolean(),
  toolCount: z.number().int(),
  error: z.string().nullable()
})
export type McpServerStatus = z.infer<typeof McpServerStatus>

export const McpListResult = z.array(McpServerStatus)
export type McpListResult = z.infer<typeof McpListResult>

export const McpSaveParams = z.object({ servers: z.array(McpServerConfig) })
export type McpSaveParams = z.infer<typeof McpSaveParams>

// --- Settings (spec §10) ---------------------------------------------------

export const SettingsAllResult = z.array(Setting)
export type SettingsAllResult = z.infer<typeof SettingsAllResult>

export const SettingGetParams = z.object({ key: z.string() })
export type SettingGetParams = z.infer<typeof SettingGetParams>
export const SettingGetResult = z.object({ key: z.string(), value: z.string().nullable() })
export type SettingGetResult = z.infer<typeof SettingGetResult>

export const SettingSetParams = z.object({ key: z.string(), value: z.string() })
export type SettingSetParams = z.infer<typeof SettingSetParams>

// Where Sunny stores data — surfaced in Settings → Data Location.
export const DataPathsResult = z.object({
  userDataDir: z.string(),
  dbPath: z.string(),
  secretsBackend: z.string()
})
export type DataPathsResult = z.infer<typeof DataPathsResult>

// --- Costs / budget (structure layer) --------------------------------------

// Month-to-date estimated spend + the configured monthly cap. `monthUsd` sums
// per-run cost estimates from src/main/costs/pricing.ts (unknown-price models
// count as $0 toward this total, per that module's doc comment). `budgetUsd`
// mirrors the `budget_monthly_usd` setting (null = no limit). `monthStart` is
// the ISO timestamp the current month window began, for display.
export const CostsSummaryResult = z.object({
  monthUsd: z.number(),
  monthTokensIn: z.number().int(),
  monthTokensOut: z.number().int(),
  budgetUsd: z.number().nullable(),
  monthStart: z.string()
})
export type CostsSummaryResult = z.infer<typeof CostsSummaryResult>
