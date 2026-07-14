import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IPC,
  type PingResult,
  type DbHealthResult,
  type SecretsHealthResult,
  type SecretsSelfTestResult,
  type ProvidersListResult,
  type SaveKeyParams,
  type SaveKeyResult,
  type RemoveKeyParams,
  type OAuthLoginParams,
  type OAuthLoginResult,
  type OAuthLogoutParams,
  type SetProviderEnabledParams,
  type SetModelEnabledParams,
  type SetModelsEnabledParams,
  type FolderPickResult,
  type FilePickResult,
  type FileOpenParams,
  type FileSaveAsParams,
  type OkResult,
  type ChatsListParams,
  type ChatsListResult,
  type ChatGetParams,
  type ChatGetResult,
  type ChatCreateParams,
  type ChatCreateResult,
  type ChatRenameParams,
  type ChatSetProjectParams,
  type ChatDeleteParams,
  type ChatSendParams,
  type ChatSendResult,
  type ChatRetryParams,
  type ChatRetryResult,
  type ChatCancelParams,
  type ChatStreamEvent,
  type ChatConfirmRequest,
  type ChatConfirmRespondParams,
  type TasksListParams,
  type TasksListResult,
  type TaskCreateParams,
  type TaskUpdateParams,
  type TaskMoveParams,
  type TaskDeleteParams,
  type TaskWorkNowParams,
  type TaskEventsParams,
  type TaskEventsResult,
  type TaskActivityParams,
  type TaskActivityResult,
  type TasksChangedEvent,
  type TaskDelegateParams,
  type TaskReworkParams,
  type AgentsListResult,
  type AgentCreateParams,
  type AgentUpdateParams,
  type AgentDeleteParams,
  type ProjectsListParams,
  type ProjectsListResult,
  type ProjectCreateParams,
  type ProjectUpdateParams,
  type ProjectDeleteParams,
  type SchedulesListResult,
  type ScheduleCreateParams,
  type ScheduleUpdateParams,
  type ScheduleDeleteParams,
  type ScheduleRunNowParams,
  type MemoriesListParams,
  type MemoriesListResult,
  type MemoryCreateParams,
  type MemoryUpdateParams,
  type MemoryDeleteParams,
  type MemoryGraphParams,
  type MemoryGraphResult,
  type MemoryEntityParams,
  type MemoryEntityDetail,
  type MemoryStatusResult,
  type MemorySetAutoParams,
  type MemorySetEmbeddingParams,
  type MemoryReembedResult,
  type WorkerStatusResult,
  type WorkerSetEnabledParams,
  type WorkerSetIntervalParams,
  type ActivityListParams,
  type ActivityListResult,
  type ActivityUnseenCountParams,
  type CountResult,
  type ApprovalsListParams,
  type ApprovalsListResult,
  type ApprovalsPendingCountParams,
  type ApprovalDecideParams,
  type AgentSetLifecycleParams,
  type AgentsOrgChartResult,
  type GoalsListParams,
  type GoalsListResult,
  type GoalGetParams,
  type GoalGetResult,
  type GoalCreateParams,
  type GoalUpdateParams,
  type GoalDeleteParams,
  type TaskSetGoalParams,
  type TaskDependenciesParams,
  type TaskDependenciesResult,
  type TaskDependencyAddParams,
  type TaskDependencyRemoveParams,
  type McpListResult,
  type McpSaveParams,
  type SettingsAllResult,
  type SettingGetParams,
  type SettingGetResult,
  type SettingSetParams,
  type DataPathsResult,
  type CostsSummaryResult
} from '@shared/ipc/contract'
import type { Task, Agent, Memory, Project, Schedule, Goal } from '@shared/db/types'

// Narrow, typed bridge between the untrusted renderer and the main process
// (spec §11). The renderer can ONLY call these methods — it never touches a raw
// key, a DB handle, or ipcRenderer directly. Response shapes are validated in
// main against the shared Zod schemas.
const api = {
  /** Round-trip health check; resolves with main-process status. */
  ping: (): Promise<PingResult> => ipcRenderer.invoke(IPC.ping),
  db: {
    /** Migration version, table list, and sqlite-vec availability. */
    health: (): Promise<DbHealthResult> => ipcRenderer.invoke(IPC.dbHealth)
  },
  secrets: {
    /** Which keychain backend is active and whether it is usable. */
    health: (): Promise<SecretsHealthResult> => ipcRenderer.invoke(IPC.secretsHealth),
    /** Diagnostic: round-trip a throwaway secret through the live keychain. */
    selfTest: (): Promise<SecretsSelfTestResult> => ipcRenderer.invoke(IPC.secretsSelfTest)
  },
  providers: {
    /** All known providers with connection status + reachable models. */
    list: (): Promise<ProvidersListResult> => ipcRenderer.invoke(IPC.providersList),
    /** Validate + store an API key in the keychain and enable the provider. */
    saveKey: (params: SaveKeyParams): Promise<SaveKeyResult> =>
      ipcRenderer.invoke(IPC.providersSaveKey, params),
    /** Remove a provider's stored key and disable it. */
    removeKey: (params: RemoveKeyParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.providersRemoveKey, params),
    /** Start an OAuth login (opens the system browser); resolves when complete. */
    oauthLogin: (params: OAuthLoginParams): Promise<OAuthLoginResult> =>
      ipcRenderer.invoke(IPC.providersOauthLogin, params),
    /** Sign out of an OAuth provider. */
    oauthLogout: (params: OAuthLogoutParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.providersOauthLogout, params),
    /** Toggle a provider on/off without removing its key/OAuth. */
    setEnabled: (params: SetProviderEnabledParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.providersSetEnabled, params),
    /** Toggle a single model on/off under a provider. */
    setModelEnabled: (params: SetModelEnabledParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.providersSetModelEnabled, params),
    /** Toggle many models on/off at once (bulk enable/disable). */
    setModelsEnabled: (params: SetModelsEnabledParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.providersSetModelsEnabled, params)
  },
  clipboard: {
    /** Copy text to the OS clipboard (via the main process — always works). */
    writeText: (text: string): Promise<OkResult> => ipcRenderer.invoke(IPC.clipboardWrite, { text })
  },
  folder: {
    /** Open the native folder picker; returns the path + a filtered file tree. */
    pick: (): Promise<FolderPickResult> => ipcRenderer.invoke(IPC.dialogPickFolder)
  },
  files: {
    /** Open the native multi-file picker; returns the readable text files
     *  (capped) + the names of any skipped (binary/unreadable/over the cap). */
    pick: (): Promise<FilePickResult> => ipcRenderer.invoke(IPC.dialogPickFiles),
    /** Open a generated file (create_file output) in the OS default app. */
    open: (params: FileOpenParams): Promise<OkResult> => ipcRenderer.invoke(IPC.filesOpen, params),
    /** Save a copy of a generated file to a user-chosen location. */
    saveAs: (params: FileSaveAsParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.filesSaveAs, params)
  },
  worker: {
    /** Autonomous task worker state (enabled / interval / running / last scan). */
    status: (): Promise<WorkerStatusResult> => ipcRenderer.invoke(IPC.workerStatus),
    /** Turn the board auto-worker on/off. */
    setEnabled: (params: WorkerSetEnabledParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.workerSetEnabled, params),
    /** Set the scan interval in minutes (min 1). */
    setInterval: (params: WorkerSetIntervalParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.workerSetInterval, params),
    /** Trigger a board scan immediately. */
    runNow: (): Promise<OkResult> => ipcRenderer.invoke(IPC.workerRunNow)
  },
  activity: {
    /** The durable audit feed (structure layer). Optional recency/kind/project
     *  filters; newest first. */
    list: (params: ActivityListParams = {}): Promise<ActivityListResult> =>
      ipcRenderer.invoke(IPC.activityList, params),
    /** Count of unseen review-worthy events for the rail badge (cheaper than list). */
    unseenCount: (params: ActivityUnseenCountParams = {}): Promise<CountResult> =>
      ipcRenderer.invoke(IPC.activityUnseenCount, params),
    /** Mark the feed as seen now — clears the rail's "new activity" badge. */
    markSeen: (): Promise<OkResult> => ipcRenderer.invoke(IPC.activityMarkSeen)
  },
  chats: {
    /** History: chats newest-first with message counts. Optionally scoped to a
     *  project (omit for all chats). */
    list: (params: ChatsListParams = {}): Promise<ChatsListResult> =>
      ipcRenderer.invoke(IPC.chatsList, params),
    /** Reopen a chat with its full transcript. */
    get: (params: ChatGetParams): Promise<ChatGetResult> =>
      ipcRenderer.invoke(IPC.chatsGet, params),
    create: (params: ChatCreateParams): Promise<ChatCreateResult> =>
      ipcRenderer.invoke(IPC.chatsCreate, params),
    rename: (params: ChatRenameParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.chatsRename, params),
    setProject: (params: ChatSetProjectParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.chatsSetProject, params),
    delete: (params: ChatDeleteParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.chatsDelete, params)
  },
  chat: {
    /** Start a streaming completion; resolves with the persisted user message. */
    send: (params: ChatSendParams): Promise<ChatSendResult> =>
      ipcRenderer.invoke(IPC.chatSend, params),
    /** Retry a failed turn: re-stream the reply for the existing last user
     *  message (no duplicate user turn, images preserved). */
    retry: (params: ChatRetryParams): Promise<ChatRetryResult> =>
      ipcRenderer.invoke(IPC.chatRetry, params),
    /** Cancel an in-flight stream. */
    cancel: (params: ChatCancelParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.chatCancel, params),
    /**
     * Subscribe to stream events (deltas + final message). Returns an
     * unsubscribe function. The caller filters events by `streamId`.
     */
    onStream: (callback: (event: ChatStreamEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: ChatStreamEvent): void => callback(payload)
      ipcRenderer.on(IPC.chatStream, listener)
      return () => ipcRenderer.removeListener(IPC.chatStream, listener)
    },
    /**
     * Subscribe to agent tool-approval requests (Ask mode / destructive actions).
     * Show a modal and reply via `respondConfirm`. Returns an unsubscribe function.
     */
    onConfirm: (callback: (req: ChatConfirmRequest) => void): (() => void) => {
      const listener = (_e: unknown, payload: ChatConfirmRequest): void => callback(payload)
      ipcRenderer.on(IPC.chatConfirm, listener)
      return () => ipcRenderer.removeListener(IPC.chatConfirm, listener)
    },
    /** Answer a tool-approval request (matched by requestId). */
    respondConfirm: (params: ChatConfirmRespondParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.chatConfirmRespond, params)
  },
  tasks: {
    /** The Kanban store (spec §6). Optionally scoped to a project. */
    list: (params: TasksListParams = {}): Promise<TasksListResult> =>
      ipcRenderer.invoke(IPC.tasksList, params),
    create: (params: TaskCreateParams): Promise<Task> =>
      ipcRenderer.invoke(IPC.tasksCreate, params),
    update: (params: TaskUpdateParams): Promise<Task> =>
      ipcRenderer.invoke(IPC.tasksUpdate, params),
    /** Move a card between columns / reorder (drag-and-drop); records an event. */
    move: (params: TaskMoveParams): Promise<Task> => ipcRenderer.invoke(IPC.tasksMove, params),
    delete: (params: TaskDeleteParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.tasksDelete, params),
    /** Work one task now in the background — the worker runs it as its agent (no
     *  chat navigation). Progress shows on the board; review the linked chat after. */
    workNow: (params: TaskWorkNowParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.tasksWorkNow, params),
    events: (params: TaskEventsParams): Promise<TaskEventsResult> =>
      ipcRenderer.invoke(IPC.taskEvents, params),
    /** Recent board transitions across all tasks — feeds the Live Activity pane. */
    activity: (params: TaskActivityParams = {}): Promise<TaskActivityResult> =>
      ipcRenderer.invoke(IPC.tasksActivity, params),
    /**
     * Subscribe to task-changed broadcasts (a card was created/claimed/moved by
     * the worker, a schedule, or any window). Returns an unsubscribe function.
     * Lets the board refresh live instead of going stale until a manual reload.
     */
    onChanged: (callback: (event: TasksChangedEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: TasksChangedEvent): void => callback(payload)
      ipcRenderer.on(IPC.tasksChanged, listener)
      return () => ipcRenderer.removeListener(IPC.tasksChanged, listener)
    },
    /** Delegate a task: a manager agent decomposes it into subtasks + dispatches
     *  them to a worker agent. Fire-and-forget; progress shows on the board. */
    delegate: (params: TaskDelegateParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.tasksDelegate, params),
    /** Re-queue a reviewed task with change-request feedback; the resumed run
     *  sees the critique in its working chat and fixes the result. */
    rework: (params: TaskReworkParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.taskRework, params),
    /** Link a task to a goal (structure layer), or clear it with goalId: null. */
    setGoal: (params: TaskSetGoalParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.taskSetGoal, params),
    /** Both sides of a task's blocker edges (blockers + dependents). */
    dependencies: (params: TaskDependenciesParams): Promise<TaskDependenciesResult> =>
      ipcRenderer.invoke(IPC.taskDependencies, params),
    /** Add a blocker edge: `taskId` is blocked by `dependsOnTaskId`. */
    addDependency: (params: TaskDependencyAddParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.taskDependencyAdd, params),
    /** Remove a blocker edge. */
    removeDependency: (params: TaskDependencyRemoveParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.taskDependencyRemove, params)
  },
  goals: {
    /** Objectives / goals with a direct-task progress rollup (structure layer).
     *  Optionally scoped to a project. */
    list: (params: GoalsListParams = {}): Promise<GoalsListResult> =>
      ipcRenderer.invoke(IPC.goalsList, params),
    /** One goal with its ancestry (root objective → goal) and linked tasks. */
    get: (params: GoalGetParams): Promise<GoalGetResult> => ipcRenderer.invoke(IPC.goalGet, params),
    create: (params: GoalCreateParams): Promise<Goal> =>
      ipcRenderer.invoke(IPC.goalsCreate, params),
    update: (params: GoalUpdateParams): Promise<Goal> =>
      ipcRenderer.invoke(IPC.goalsUpdate, params),
    delete: (params: GoalDeleteParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.goalsDelete, params)
  },
  agents: {
    /** Agent library (spec §7) — presets + user-created configurations. */
    list: (): Promise<AgentsListResult> => ipcRenderer.invoke(IPC.agentsList),
    create: (params: AgentCreateParams): Promise<Agent> =>
      ipcRenderer.invoke(IPC.agentsCreate, params),
    update: (params: AgentUpdateParams): Promise<Agent> =>
      ipcRenderer.invoke(IPC.agentsUpdate, params),
    delete: (params: AgentDeleteParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.agentsDelete, params),
    /** Governance lifecycle (structure layer): pause/resume/terminate. A paused
     *  agent is skipped by the heartbeat. */
    setLifecycle: (params: AgentSetLifecycleParams): Promise<Agent> =>
      ipcRenderer.invoke(IPC.agentsSetLifecycle, params),
    /** The reporting tree + live heartbeat (each agent's current task) for the
     *  Team view (structure layer). */
    orgChart: (): Promise<AgentsOrgChartResult> => ipcRenderer.invoke(IPC.agentsOrgChart)
  },
  approvals: {
    /** Approval gates the autonomous worker raised before a side effect ships
     *  (structure layer, governance). Optionally one status + project scope. */
    list: (params: ApprovalsListParams = {}): Promise<ApprovalsListResult> =>
      ipcRenderer.invoke(IPC.approvalsList, params),
    /** Count of pending gates for the rail badge (cheaper than list). */
    pendingCount: (params: ApprovalsPendingCountParams = {}): Promise<CountResult> =>
      ipcRenderer.invoke(IPC.approvalsPendingCount, params),
    /** Approve or reject a gate. Approving re-queues the parked task so the
     *  agent re-runs and proceeds; rejecting leaves it blocked. */
    decide: (params: ApprovalDecideParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.approvalsDecide, params)
  },
  projects: {
    /** Projects (spec §7) — scope chats/tasks/memory. Active (non-archived) only
     *  unless includeArchived is set. */
    list: (params: ProjectsListParams = {}): Promise<ProjectsListResult> =>
      ipcRenderer.invoke(IPC.projectsList, params),
    create: (params: ProjectCreateParams): Promise<Project> =>
      ipcRenderer.invoke(IPC.projectsCreate, params),
    update: (params: ProjectUpdateParams): Promise<Project> =>
      ipcRenderer.invoke(IPC.projectsUpdate, params),
    delete: (params: ProjectDeleteParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.projectsDelete, params)
  },
  schedules: {
    /** Scheduler (spec §7) — run an agent on a goal at a cadence. */
    list: (): Promise<SchedulesListResult> => ipcRenderer.invoke(IPC.schedulesList),
    create: (params: ScheduleCreateParams): Promise<Schedule> =>
      ipcRenderer.invoke(IPC.schedulesCreate, params),
    update: (params: ScheduleUpdateParams): Promise<Schedule> =>
      ipcRenderer.invoke(IPC.schedulesUpdate, params),
    delete: (params: ScheduleDeleteParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.schedulesDelete, params),
    /** Fire a schedule immediately (creates + works a task now). */
    runNow: (params: ScheduleRunNowParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.schedulesRunNow, params)
  },
  memories: {
    /** Memory browser (spec §5) — list/search, scoped by tier. */
    list: (params: MemoriesListParams = {}): Promise<MemoriesListResult> =>
      ipcRenderer.invoke(IPC.memoriesList, params),
    create: (params: MemoryCreateParams): Promise<Memory> =>
      ipcRenderer.invoke(IPC.memoriesCreate, params),
    update: (params: MemoryUpdateParams): Promise<Memory> =>
      ipcRenderer.invoke(IPC.memoriesUpdate, params),
    delete: (params: MemoryDeleteParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.memoriesDelete, params),
    /** The knowledge graph (entities + relations) for the graph view. */
    graph: (params: MemoryGraphParams = {}): Promise<MemoryGraphResult> =>
      ipcRenderer.invoke(IPC.memoryGraph, params),
    /** One entity with its edges + the observations that mention it. */
    entity: (params: MemoryEntityParams): Promise<MemoryEntityDetail> =>
      ipcRenderer.invoke(IPC.memoryEntity, params),
    /** Auto-memory toggle state + embedding provider availability + counts. */
    status: (): Promise<MemoryStatusResult> => ipcRenderer.invoke(IPC.memoryStatus),
    /** Enable/disable automatic memory capture + recall. */
    setAuto: (params: MemorySetAutoParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.memorySetAuto, params),
    /** Switch the embedding provider/model live; re-embeds in the background and
     *  returns the refreshed memory status. */
    setEmbedding: (params: MemorySetEmbeddingParams): Promise<MemoryStatusResult> =>
      ipcRenderer.invoke(IPC.memorySetEmbedding, params),
    /** Re-embed all memories with the active embedder (backfill). */
    reembed: (): Promise<MemoryReembedResult> => ipcRenderer.invoke(IPC.memoryReembed)
  },
  mcp: {
    /** Configured MCP servers with live connection status (structure layer). */
    list: (): Promise<McpListResult> => ipcRenderer.invoke(IPC.mcpList),
    /** Replace the server list and reconnect; returns the refreshed statuses. */
    save: (params: McpSaveParams): Promise<McpListResult> => ipcRenderer.invoke(IPC.mcpSave, params)
  },
  settings: {
    /** Key/value app settings (spec §10). */
    all: (): Promise<SettingsAllResult> => ipcRenderer.invoke(IPC.settingsAll),
    get: (params: SettingGetParams): Promise<SettingGetResult> =>
      ipcRenderer.invoke(IPC.settingsGet, params),
    set: (params: SettingSetParams): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.settingsSet, params),
    /** Where Sunny stores data (for the Data Location section). */
    dataPaths: (): Promise<DataPathsResult> => ipcRenderer.invoke(IPC.settingsDataPaths)
  },
  costs: {
    /** Month-to-date estimated spend + tokens + the configured budget, for the
     *  Budget settings section and the autonomous worker's pre-run gate. */
    summary: (): Promise<CostsSummaryResult> => ipcRenderer.invoke(IPC.costsSummary)
  }
}

// Sunny always runs with contextIsolation: true (see main webPreferences), so
// we only ever expose through the context bridge — never directly onto window.
try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('sunny', api)
} catch (error) {
  console.error('[sunny] preload bridge failed', error)
}

export type SunnyApi = typeof api
