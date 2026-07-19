import { app, ipcMain, shell, dialog, clipboard, BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  IPC,
  PingResult,
  DbHealthResult,
  SecretsHealthResult,
  SecretsSelfTestResult,
  ProvidersListResult,
  type ProviderStatus,
  type OAuthStatus,
  SaveKeyParams,
  SaveKeyResult,
  RemoveKeyParams,
  OAuthLoginParams,
  OAuthLoginResult,
  OAuthLogoutParams,
  OkResult,
  ChatsListResult,
  ChatGetParams,
  ChatGetResult,
  ChatCreateParams,
  ChatCreateResult,
  ChatRenameParams,
  ChatSetProjectParams,
  ChatDeleteParams,
  ClipboardWriteParams,
  FileOpenParams,
  FileSaveAsParams,
  ChatSendParams,
  ChatSendResult,
  ChatRetryParams,
  ChatRetryResult,
  ChatCancelParams,
  ChatConfirmRespondParams,
  type ChatStreamEvent,
  TasksListParams,
  TasksListResult,
  TaskCreateParams,
  TaskUpdateParams,
  TaskMoveParams,
  TaskDeleteParams,
  TaskWorkNowParams,
  TaskEventsParams,
  TaskEventsResult,
  TaskActivityParams,
  TaskActivityResult,
  TaskDelegateParams,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  ChatsListParams,
  ProjectsListParams,
  ProjectsListResult,
  ProjectCreateParams,
  ProjectUpdateParams,
  ProjectDeleteParams,
  SchedulesListResult,
  ScheduleCreateParams,
  ScheduleUpdateParams,
  ScheduleDeleteParams,
  ScheduleRunNowParams,
  MemoriesListParams,
  MemoriesListResult,
  MemoryCreateParams,
  MemoryUpdateParams,
  MemoryDeleteParams,
  SettingsAllResult,
  SettingGetParams,
  SettingGetResult,
  SettingSetParams,
  DataPathsResult,
  MemoryGraphParams,
  MemoryGraphResult,
  MemoryEntityParams,
  MemoryEntityDetail,
  MemoryStatusResult,
  MemorySetAutoParams,
  MemorySetEmbeddingParams,
  MemoryReembedResult,
  SetProviderEnabledParams,
  SetModelEnabledParams,
  SetModelsEnabledParams,
  FolderPickResult,
  FilePickResult,
  WorkerStatusResult,
  WorkerSetEnabledParams,
  WorkerSetIntervalParams,
  ActivityListParams,
  ActivityListResult,
  ActivityUnseenCountParams,
  CountResult,
  GoalsListParams,
  GoalsListResult,
  GoalGetParams,
  GoalGetResult,
  GoalCreateParams,
  GoalUpdateParams,
  GoalDeleteParams,
  TaskSetGoalParams,
  TaskDependenciesParams,
  TaskDependenciesResult,
  TaskDependencyAddParams,
  TaskDependencyRemoveParams,
  ApprovalsListParams,
  ApprovalsListResult,
  ApprovalsPendingCountParams,
  ApprovalDecideParams,
  AgentSetLifecycleParams,
  AgentsOrgChartResult,
  McpListResult,
  McpSaveParams,
  CostsSummaryResult,
  TaskReworkParams
} from '@shared/ipc/contract'
import { Goal } from '@shared/db/types'
import { join, resolve, basename } from 'node:path'
import { copyFile } from 'node:fs/promises'
import { readFolderContext } from '@main/folder'
import { readPickedFiles } from '@main/files'
import type { TaskWorker } from '@main/worker/task-worker'
import type { Scheduler } from '@main/scheduler/scheduler'
import type { McpManager } from '@main/mcp/manager'
import { nextRunIso } from '@main/scheduler/cadence'
import { mergeSchedulePayload } from '@shared/scheduler'
import { estimateCostUsd } from '@main/costs/pricing'
import { monthStartIso } from '@main/worker/task-worker'
import { Task, Agent, Memory, Project, Schedule } from '@shared/db/types'
import { getDbHealth, type SunnyDatabase } from '@main/db'
import { getSecretsHealth, type SecretStore } from '@main/secrets'
import type { ProviderRegistry } from '@main/providers'
import {
  ollamaReachable,
  ollamaChatModels,
  OLLAMA_DEFAULT_BASE_URL,
  opencodeReachable,
  opencodeChatModels,
  OPENCODE_DEFAULT_BASE_URL
} from '@main/providers'
import type { ChatTurn, ModelInfo, Provider } from '@main/providers/types'
import { streamTurn } from '@main/chat/complete'
import { resolveEmbedder } from '@main/memory/resolve-embedder'
import { reconcileVectorDimension } from '@main/memory/vector-store'
import { buildAgentToolset } from '@main/tools/registry'
import type { ConfirmFn } from '@main/tools/types'
import type { Repositories } from '@main/repositories'
import type { MemoryService } from '@main/memory/service'
import type { Message, PermissionMode } from '@shared/db/types'
import { loginXai, refreshXai, xaiTokensExpired, type XaiTokens } from '@main/oauth/xai'
import {
  loginCodex,
  logoutCodex,
  codexStatus,
  listCodexModels,
  type CodexStatus
} from '@main/providers/codex'

// Which auth methods each provider kind supports (spec §4d). Anything not listed
// is API-key only.
const AUTH_METHODS: Record<string, Array<'api_key' | 'oauth' | 'local'>> = {
  xai: ['oauth', 'api_key'],
  codex: ['oauth'],
  ollama: ['local'],
  opencode: ['local']
}
const authMethodsFor = (kind: string): Array<'api_key' | 'oauth' | 'local'> =>
  AUTH_METHODS[kind] ?? ['api_key']

// Keys the (untrusted) renderer is allowed to write via settings:set. Internal
// keys (presets_version, embedding dim, etc.) and worker/memory toggles have
// their own typed IPC, so the renderer can't reach them through this generic
// channel — a compromised renderer can't, e.g., repoint ollama_base_url at an
// arbitrary host beyond what the Settings UI itself offers.
const RENDERER_WRITABLE_SETTINGS = new Set<string>([
  'standing_instructions',
  'default_agent',
  'default_provider',
  'default_model',
  'agent_workspace',
  'ollama_base_url',
  'opencode_base_url',
  'opencode_password',
  'active_project',
  // OS notification toggle (Settings → Notifications).
  'notifications_enabled',
  // Memory recall similarity floor (Memory → recall tuning), '0'..'1'.
  'memory_relevance_min',
  // Monthly autonomous-spend cap in USD (Settings → Budget & spend); '' = none.
  'budget_monthly_usd',
  // Web search provider ('ddg' | 'tavily' | 'brave') + its API key. The key is
  // stored in the local settings DB (not the keychain) — low blast radius, and
  // the Settings UI says so.
  'search_provider',
  'search_api_key'
])

const openExternal = (url: string): void => {
  void shell.openExternal(url)
}

/** Brief in-memory cache of live model catalogs (e.g. OpenRouter's 300+) so the
 *  providers list doesn't refetch the whole list on every call. */
const liveModelCache = new Map<string, { at: number; models: ModelInfo[] }>()
const LIVE_MODELS_TTL_MS = 5 * 60_000

/** Parse the per-provider disabled-model list out of the `config` JSON column. */
function parseDisabledModels(config: string | null | undefined): string[] {
  if (!config) return []
  try {
    const parsed = JSON.parse(config) as { disabledModels?: unknown }
    return Array.isArray(parsed.disabledModels)
      ? parsed.disabledModels.filter((m): m is string => typeof m === 'string')
      : []
  } catch {
    return []
  }
}

/** Parse an agent's `allowed_tools` JSON column into a flat tool-id list. */
function parseAllowedTools(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function codexAccountLabel(status: CodexStatus): string | null {
  const a = status.account
  if (!a) return null
  return a.email ?? a.planType ?? a.type ?? 'ChatGPT account'
}

// Central registration for all typed IPC handlers. Invoke handlers validate
// their response against the shared Zod schema with `.parse` before returning,
// so the renderer can trust the shape (spec §11). Streaming replies flow the
// other way as `chatStream` events (see runStream).

export interface IpcDeps {
  db: SunnyDatabase
  secretStore: SecretStore
  registry: ProviderRegistry
  repos: Repositories
  memory: MemoryService
  worker: TaskWorker
  scheduler: Scheduler
  mcp: McpManager
}

/** Accumulate a provider's streamed text into a single string (for memory
 *  extraction — a non-streaming completion built on the streaming interface). */
async function accumulateStream(
  provider: Provider,
  params: { apiKey: string; model: string; messages: ChatTurn[] }
): Promise<string> {
  let out = ''
  for await (const chunk of provider.streamChat(params)) {
    if (chunk.type === 'delta') out += chunk.text
    else if (chunk.type === 'status' || chunk.type === 'thinking' || chunk.type === 'usage')
      continue
    else break
  }
  return out
}

const SELF_TEST_VALUE = 'sunny-keychain-selftest-marker'

/** Only system/user/assistant turns are sent to a provider in Phase 2. */
function toChatTurns(messages: Message[]): ChatTurn[] {
  return messages
    .filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const turn: ChatTurn = { role: m.role as ChatTurn['role'], content: m.content }
      // Persisted image attachments → image parts so vision models see them on
      // every turn, not just the one they were attached to.
      if (m.attachments) {
        try {
          const imgs = JSON.parse(m.attachments) as Array<{ mediaType?: string; dataUrl?: string }>
          const images = imgs
            .filter(
              (i): i is { mediaType: string; dataUrl: string } =>
                typeof i?.mediaType === 'string' && typeof i?.dataUrl === 'string'
            )
            .map((i) => ({ mediaType: i.mediaType, dataUrl: i.dataUrl }))
          if (images.length > 0) turn.images = images
        } catch {
          // Malformed attachments JSON — skip images for this turn.
        }
      }
      return turn
    })
}

/** First-message-derived chat title for the history list. */
function deriveTitle(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return 'Untitled chat'
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed
}

export function registerIpcHandlers({
  db,
  secretStore,
  registry,
  repos,
  memory,
  worker,
  scheduler,
  mcp
}: IpcDeps): void {
  // --- diagnostics (Phase 1) ------------------------------------------------
  ipcMain.handle(IPC.ping, () =>
    PingResult.parse({ ok: true as const, ts: Date.now(), version: app.getVersion() })
  )
  ipcMain.handle(IPC.dbHealth, () => DbHealthResult.parse(getDbHealth(db)))
  ipcMain.handle(IPC.secretsHealth, () => SecretsHealthResult.parse(getSecretsHealth()))
  ipcMain.handle(IPC.secretsSelfTest, async () => {
    const { backend } = getSecretsHealth()
    try {
      const id = await secretStore.set(SELF_TEST_VALUE)
      const got = await secretStore.get(id)
      await secretStore.delete(id)
      return SecretsSelfTestResult.parse({ ok: true, roundTrip: got === SELF_TEST_VALUE, backend })
    } catch {
      return SecretsSelfTestResult.parse({ ok: false, roundTrip: false, backend })
    }
  })

  // --- providers (spec §4) --------------------------------------------------
  // Fetch a provider's LIVE model catalog (cached ~5 min), serving the last good
  // list on a transient failure and null when there's nothing live — in which
  // case the caller keeps the provider's static list.
  async function liveModelsFor(provider: Provider, secretRef: string): Promise<ModelInfo[] | null> {
    if (typeof provider.fetchModels !== 'function') return null
    const cached = liveModelCache.get(provider.kind)
    if (cached && Date.now() - cached.at < LIVE_MODELS_TTL_MS) return cached.models
    try {
      const key = (await secretStore.get(secretRef)) ?? ''
      const models = await provider.fetchModels(key)
      if (models.length > 0) {
        liveModelCache.set(provider.kind, { at: Date.now(), models })
        return models
      }
      return cached?.models ?? null
    } catch {
      return cached?.models ?? null
    }
  }

  // The synchronous, always-cheap part of a provider's status (row lookup +
  // static model list). Split out so the parallel builder and the degraded
  // fallback both use it.
  function providerStatusBase(provider: Provider): {
    row: ReturnType<typeof repos.providers.getByKind>
    base: {
      kind: string
      label: string
      enabled: boolean
      disabledModels: string[]
      webCapable: boolean
      webMode: 'native' | 'tool' | null
      authMethods: ReturnType<typeof authMethodsFor>
      defaultModel: string
      models: ModelInfo[]
    }
  } {
    const kind = provider.kind
    const row = repos.providers.getByKind(kind)
    // User on/off state lives on the row independent of credentials.
    const enabled = row ? row.enabled === 1 : true
    const disabledModels = parseDisabledModels(row?.config)
    // Web capability: 'native' = the provider searches itself; 'tool' = Sunny
    // runs its own web tools for it (function-calling providers); null = none.
    const webMode: 'native' | 'tool' | null = provider.supportsWebSearch
      ? 'native'
      : typeof provider.streamWithTools === 'function'
        ? 'tool'
        : null
    return {
      row,
      base: {
        kind,
        label: provider.label,
        enabled,
        disabledModels,
        webCapable: webMode !== null,
        webMode,
        authMethods: authMethodsFor(kind),
        defaultModel: provider.defaultModel,
        models: provider.listModels()
      }
    }
  }

  async function buildProviderStatus(provider: Provider): Promise<ProviderStatus> {
    const kind = provider.kind
    const { row, base } = providerStatusBase(provider)

    // Providers with a live catalog (e.g. OpenRouter's 300+) replace the static
    // list once connected; codex/ollama have their own live logic below.
    if (typeof provider.fetchModels === 'function' && row?.secret_ref) {
      const live = await liveModelsFor(provider, row.secret_ref)
      if (live && live.length > 0) base.models = live
    }

    {
      if (kind === 'codex') {
        // Codex auth lives in the Codex CLI/App Server, not our keychain.
        const status = await codexStatus()
        const oauth: OAuthStatus = {
          connected: status.signedIn,
          available: status.cliAvailable,
          account: codexAccountLabel(status),
          expiresAt: null,
          requiresCli: true
        }
        // When signed in, show the account's ACTUAL models from the App Server's
        // model/list — what's available is plan-dependent and the static fallback
        // can drift (e.g. a default model the account can't use). Falls back to
        // the static list if the live call fails.
        const models = status.signedIn ? await listCodexModels() : provider.listModels()
        // Keep the provider's safe default (gpt-5.4-mini) when the account has it;
        // otherwise fall back to the first available model.
        const defaultModel = models.some((m) => m.id === base.defaultModel)
          ? base.defaultModel
          : (models[0]?.id ?? base.defaultModel)
        return {
          ...base,
          models,
          defaultModel,
          connected: status.signedIn,
          activeAuth: status.signedIn ? 'oauth' : null,
          oauth
        }
      }

      if (kind === 'ollama') {
        // Keyless local daemon: connected = reachable; models are live.
        const baseUrl = repos.settings.get('ollama_base_url') ?? OLLAMA_DEFAULT_BASE_URL
        const reachable = await ollamaReachable(baseUrl)
        const models = reachable ? await ollamaChatModels(baseUrl) : []
        return {
          ...base,
          defaultModel: models[0]?.id ?? '',
          models,
          connected: reachable,
          activeAuth: reachable ? 'local' : null,
          local: { reachable, baseUrl }
        }
      }

      if (kind === 'opencode') {
        // Local opencode server: connected = reachable; models are live from its
        // /provider catalog (the providers it has authed, e.g. ChatGPT).
        const baseUrl = repos.settings.get('opencode_base_url') ?? OPENCODE_DEFAULT_BASE_URL
        const password = repos.settings.get('opencode_password') ?? ''
        const reachable = await opencodeReachable(baseUrl, password)
        const models = reachable ? await opencodeChatModels(baseUrl, password) : []
        return {
          ...base,
          defaultModel: models[0]?.id ?? '',
          models,
          connected: reachable,
          activeAuth: reachable ? 'local' : null,
          local: { reachable, baseUrl }
        }
      }

      if (authMethodsFor(kind).includes('oauth')) {
        // xAI: subscription OAuth (token bundle in keychain) OR API key.
        const isOauth = row?.auth_method === 'oauth' && Boolean(row?.secret_ref)
        const isKey = row?.auth_method === 'api_key' && Boolean(row?.secret_ref)
        let expiresAt: number | null = null
        if (isOauth && row?.secret_ref) {
          try {
            const stored = await secretStore.get(row.secret_ref)
            if (stored) expiresAt = (JSON.parse(stored) as XaiTokens).expiresAt ?? null
          } catch {
            expiresAt = null
          }
        }
        const connected = isOauth || isKey
        const oauth: OAuthStatus = {
          connected: isOauth,
          available: true,
          account: null,
          expiresAt,
          requiresCli: false
        }
        return {
          ...base,
          connected,
          activeAuth: connected && row ? (row.auth_method as 'api_key' | 'oauth') : null,
          oauth
        }
      }

      // API-key-only providers.
      const connected = Boolean(row?.secret_ref)
      return { ...base, connected, activeAuth: connected ? 'api_key' : null }
    }
  }

  ipcMain.handle(IPC.providersList, async () => {
    // Build every provider's status IN PARALLEL — codex/ollama/opencode each do
    // their own network probe, and running them serially made the whole list
    // wait on their sum on every mount. Each builder is wrapped so one provider's
    // failure degrades to "disconnected" rather than throwing the entire list;
    // order is preserved by mapping over registry.list().
    const statuses = await Promise.all(
      registry.list().map(async (provider): Promise<ProviderStatus> => {
        try {
          return await buildProviderStatus(provider)
        } catch (err) {
          console.error(`[sunny] providersList: ${provider.kind} status failed`, err)
          const { base } = providerStatusBase(provider)
          return { ...base, connected: false, activeAuth: null }
        }
      })
    )
    return ProvidersListResult.parse(statuses)
  })

  ipcMain.handle(IPC.providersSaveKey, async (_event, raw) => {
    const { kind, apiKey } = SaveKeyParams.parse(raw)
    const provider = registry.get(kind)
    if (!provider) return SaveKeyResult.parse({ ok: false, error: `Unknown provider: ${kind}` })

    // Cheap validation call before we persist anything (spec §4a).
    const result = await provider.validateKey(apiKey)
    if (!result.ok) {
      return SaveKeyResult.parse({ ok: false, error: result.error ?? 'Key validation failed' })
    }

    // Replace any prior secret for this provider, then store + enable.
    const existing = repos.providers.getByKind(kind)
    if (existing?.secret_ref) await secretStore.delete(existing.secret_ref)
    const secretRef = await secretStore.set(apiKey)
    repos.providers.upsertByKind({
      kind,
      label: provider.label,
      authMethod: 'api_key',
      secretRef,
      enabled: true
    })
    return SaveKeyResult.parse({ ok: true })
  })

  ipcMain.handle(IPC.providersRemoveKey, async (_event, raw) => {
    const { kind } = RemoveKeyParams.parse(raw)
    const existing = repos.providers.getByKind(kind)
    if (existing?.secret_ref) await secretStore.delete(existing.secret_ref)
    repos.providers.deleteByKind(kind)
    return OkResult.parse({ ok: true })
  })

  ipcMain.handle(IPC.providersOauthLogin, async (_event, raw) => {
    const { kind } = OAuthLoginParams.parse(raw)
    const label = registry.get(kind)?.label ?? kind
    try {
      if (kind === 'xai') {
        // Subscription OAuth: open the browser, capture the loopback callback,
        // then persist the token bundle to the keychain (replacing any prior).
        const tokens = await loginXai({ openUrl: openExternal })
        const existing = repos.providers.getByKind('xai')
        if (existing?.secret_ref) await secretStore.delete(existing.secret_ref)
        const secretRef = await secretStore.set(JSON.stringify(tokens))
        repos.providers.upsertByKind({ kind, label, authMethod: 'oauth', secretRef, enabled: true })
        return OAuthLoginResult.parse({ ok: true, account: null })
      }
      if (kind === 'codex') {
        // The Codex App Server owns token persistence/refresh; we just record
        // that this provider is configured for OAuth.
        const status = await loginCodex({ type: 'chatgpt', openUrl: openExternal })
        repos.providers.upsertByKind({
          kind,
          label,
          authMethod: 'oauth',
          secretRef: null,
          enabled: status.signedIn
        })
        return OAuthLoginResult.parse({
          ok: status.signedIn,
          account: codexAccountLabel(status),
          error: status.signedIn ? undefined : 'Login did not complete'
        })
      }
      return OAuthLoginResult.parse({
        ok: false,
        error: `Provider does not support OAuth: ${kind}`
      })
    } catch (err) {
      return OAuthLoginResult.parse({
        ok: false,
        error: err instanceof Error ? err.message : 'OAuth login failed'
      })
    }
  })

  ipcMain.handle(IPC.providersOauthLogout, async (_event, raw) => {
    const { kind } = OAuthLogoutParams.parse(raw)
    if (kind === 'codex') {
      try {
        await logoutCodex()
      } catch {
        // best-effort; clear our record regardless
      }
      repos.providers.deleteByKind(kind)
      return OkResult.parse({ ok: true })
    }
    const existing = repos.providers.getByKind(kind)
    if (existing?.secret_ref) await secretStore.delete(existing.secret_ref)
    repos.providers.deleteByKind(kind)
    return OkResult.parse({ ok: true })
  })

  // Ensure a (possibly credential-less) row exists so on/off + model toggles can
  // persist even for keyless providers like Ollama.
  const ensureProviderRow = (kind: string): void => {
    if (repos.providers.getByKind(kind)) return
    repos.providers.upsertByKind({
      kind,
      label: registry.get(kind)?.label ?? kind,
      authMethod: authMethodsFor(kind)[0],
      secretRef: null,
      enabled: true
    })
  }

  // Toggle a provider on/off WITHOUT touching its key/OAuth (spec §4d).
  ipcMain.handle(IPC.providersSetEnabled, (_event, raw) => {
    const { kind, enabled } = SetProviderEnabledParams.parse(raw)
    ensureProviderRow(kind)
    repos.providers.setEnabled(kind, enabled)
    return OkResult.parse({ ok: true })
  })

  // Toggle a single model on/off under a provider (persisted in config JSON).
  ipcMain.handle(IPC.providersSetModelEnabled, (_event, raw) => {
    const { kind, model, enabled } = SetModelEnabledParams.parse(raw)
    ensureProviderRow(kind)
    const row = repos.providers.getByKind(kind)
    const disabled = new Set(parseDisabledModels(row?.config))
    if (enabled) disabled.delete(model)
    else disabled.add(model)
    repos.providers.setConfig(kind, JSON.stringify({ disabledModels: [...disabled] }))
    return OkResult.parse({ ok: true })
  })

  // Bulk toggle: enable/disable many models at once (e.g. "enable/disable all",
  // or every model currently shown by a search filter) in one write.
  ipcMain.handle(IPC.providersSetModelsEnabled, (_event, raw) => {
    const { kind, models, enabled } = SetModelsEnabledParams.parse(raw)
    ensureProviderRow(kind)
    const row = repos.providers.getByKind(kind)
    const disabled = new Set(parseDisabledModels(row?.config))
    for (const model of models) {
      if (enabled) disabled.delete(model)
      else disabled.add(model)
    }
    repos.providers.setConfig(kind, JSON.stringify({ disabledModels: [...disabled] }))
    return OkResult.parse({ ok: true })
  })

  // "Chat in Folder" (spec §9): native folder picker → filtered file tree.
  ipcMain.handle(IPC.dialogPickFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) {
      return FolderPickResult.parse({
        path: null,
        name: null,
        fileCount: 0,
        tree: '',
        truncated: false
      })
    }
    return FolderPickResult.parse(readFolderContext(result.filePaths[0]))
  })

  // "Attach files" (spec §9): native multi-file picker → capped UTF-8 text the
  // renderer folds into the message (binary/oversized files are skipped).
  ipcMain.handle(IPC.dialogPickFiles, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled || result.filePaths.length === 0) {
      return FilePickResult.parse({ files: [], skipped: [] })
    }
    return FilePickResult.parse(await readPickedFiles(result.filePaths))
  })

  // --- history (spec §8) ----------------------------------------------------
  ipcMain.handle(IPC.chatsList, (_event, raw) => {
    const { projectId } = ChatsListParams.parse(raw ?? {})
    return ChatsListResult.parse(repos.chats.list(projectId))
  })

  ipcMain.handle(IPC.chatsGet, (_event, raw) => {
    const { chatId } = ChatGetParams.parse(raw)
    const chat = repos.chats.get(chatId)
    if (!chat) throw new Error(`Chat not found: ${chatId}`)
    return ChatGetResult.parse({ chat, messages: repos.messages.listByChat(chatId) })
  })

  ipcMain.handle(IPC.chatsCreate, (_event, raw) => {
    const params = ChatCreateParams.parse(raw)
    return ChatCreateResult.parse(repos.chats.create(params))
  })

  ipcMain.handle(IPC.chatsRename, (_event, raw) => {
    const { chatId, title } = ChatRenameParams.parse(raw)
    repos.chats.rename(chatId, title)
    return OkResult.parse({ ok: true })
  })

  ipcMain.handle(IPC.clipboardWrite, (_event, raw) => {
    const { text } = ClipboardWriteParams.parse(raw)
    clipboard.writeText(text)
    return OkResult.parse({ ok: true })
  })

  // Generated files (create_file output). Both handlers refuse any path outside
  // Sunny's generated-files dir, so the renderer can only reach files Sunny made.
  const generatedRoot = (): string => resolve(join(app.getPath('userData'), 'generated'))
  const insideGenerated = (p: string): boolean => {
    const root = generatedRoot()
    const abs = resolve(p)
    return abs === root || abs.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))
  }
  ipcMain.handle(IPC.filesOpen, async (_event, raw) => {
    const { path } = FileOpenParams.parse(raw)
    if (!insideGenerated(path)) throw new Error('Refused: file is outside the generated folder.')
    const err = await shell.openPath(path)
    if (err) throw new Error(err)
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.filesSaveAs, async (_event, raw) => {
    const { path, name } = FileSaveAsParams.parse(raw)
    if (!insideGenerated(path)) throw new Error('Refused: file is outside the generated folder.')
    const result = await dialog.showSaveDialog({ defaultPath: basename(name || path) })
    if (result.canceled || !result.filePath) return OkResult.parse({ ok: false })
    await copyFile(path, result.filePath)
    return OkResult.parse({ ok: true })
  })

  ipcMain.handle(IPC.chatsSetProject, (_event, raw) => {
    const { chatId, projectId } = ChatSetProjectParams.parse(raw)
    repos.chats.setProject(chatId, projectId)
    return OkResult.parse({ ok: true })
  })

  ipcMain.handle(IPC.chatsDelete, (_event, raw) => {
    const { chatId } = ChatDeleteParams.parse(raw)
    repos.chats.delete(chatId)
    return OkResult.parse({ ok: true })
  })

  // --- streaming chat (spec §4 / Phase 2) -----------------------------------
  // Tracks in-flight streams so chat:cancel can abort the underlying request.
  const activeStreams = new Map<string, AbortController>()
  // Pending agent-tool approvals (Ask mode / destructive autopilot actions),
  // keyed by requestId; resolved by the chat:confirmRespond handler. A timeout
  // auto-denies so a closed window or ignored prompt never wedges the tool loop.
  const pendingConfirms = new Map<string, (allow: boolean) => void>()

  async function runStream(
    sender: WebContents,
    args: {
      kind: string
      chatId: string
      model: string
      streamId: string
      turns: ChatTurn[]
      folderPath?: string
      agentId?: string
      webSearch?: boolean
      permissionMode?: PermissionMode
      projectId?: string
    }
  ): Promise<void> {
    const { kind, chatId, model, streamId, turns, folderPath, agentId, webSearch, projectId } = args
    // The user's live composer choice governs an interactive turn's tool actions,
    // overriding the agent's stored default; falls back to it when unset.
    const permissionMode = args.permissionMode
    const send = (event: ChatStreamEvent): void => {
      if (!sender.isDestroyed()) sender.send(IPC.chatStream, event)
    }
    const controller = new AbortController()
    activeStreams.set(streamId, controller)
    let acc = ''
    // Reasoning accumulated from `thinking` chunks — persisted on the saved
    // message (separately from the answer) so the collapsible section survives
    // a reload.
    let thinkingAcc = ''
    // Assigned once the run row exists (mid-try); hoisted so the catch can
    // close the run on failure/cancel. No-op until then (pre-run errors like
    // a missing key never opened a run).
    let finishChatRun: (status: 'succeeded' | 'failed' | 'cancelled', error?: string) => void =
      () => {}
    try {
      const provider = registry.get(kind)
      if (!provider) {
        send({ streamId, type: 'error', message: `Unknown provider: ${kind}` })
        return
      }
      // Resolve the bearer for this turn based on the provider's auth method.
      let apiKey = ''
      if (kind === 'codex' || kind === 'ollama' || kind === 'opencode') {
        // Codex self-manages auth via the App Server; Ollama + opencode are
        // keyless local servers (opencode owns its own auth).
        apiKey = ''
      } else {
        const row = repos.providers.getByKind(kind)
        if (row?.auth_method === 'oauth') {
          // Subscription OAuth (xAI): load the token bundle, refresh if expiring.
          const stored = row.secret_ref ? await secretStore.get(row.secret_ref) : null
          if (!stored) {
            send({
              streamId,
              type: 'error',
              message: 'Not connected. Sign in for this provider in Settings.'
            })
            return
          }
          let tokens = JSON.parse(stored) as XaiTokens
          if (xaiTokensExpired(tokens)) {
            try {
              tokens = await refreshXai(tokens)
              if (row.secret_ref)
                await secretStore.setWithId(row.secret_ref, JSON.stringify(tokens))
            } catch {
              send({
                streamId,
                type: 'error',
                message: 'Session expired — reconnect this provider in Settings.'
              })
              return
            }
          }
          apiKey = tokens.accessToken
        } else {
          const key = row?.secret_ref ? await secretStore.get(row.secret_ref) : null
          if (!key) {
            send({
              streamId,
              type: 'error',
              message: 'No API key configured. Add one in Settings.'
            })
            return
          }
          apiKey = key
        }
      }

      // Inject standing instructions (spec §9) + retrieved long-term memory
      // (spec §5) as a leading system turn. Best-effort — never blocks the chat.
      const systemParts: string[] = []
      // The chat's agent persona leads the system context (spec §7).
      const agent = agentId ? repos.agents.get(agentId) : null
      if (agent?.system_prompt && agent.system_prompt.trim()) {
        systemParts.push(agent.system_prompt.trim())
      }
      const standing = repos.settings.get('standing_instructions')
      if (standing && standing.trim()) systemParts.push(standing.trim())
      // "Chat in Folder": give the model the project's structure (+ root README)
      // as context.
      if (folderPath) {
        try {
          const folder = readFolderContext(folderPath)
          let folderContext =
            `You are assisting with the project in the folder \`${folder.path}\` ` +
            `(${folder.fileCount} items${folder.truncated ? '+, truncated' : ''}). ` +
            `Project structure:\n${folder.tree}`
          if (folder.readme) {
            folderContext += `\n\nProject README:\n${folder.readme}`
          }
          folderContext +=
            `\n\nUse this for context. You have the folder layout` +
            (folder.readme ? ' and its README' : '') +
            `; for other file contents, use your read-file tool if enabled, or ask the user to paste the file.`
          systemParts.push(folderContext)
        } catch {
          // Folder unreadable (moved/permissions) — proceed without it.
        }
      }
      if (memory.autoEnabled()) {
        const lastUser = [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''
        if (lastUser) {
          try {
            const { text } = await memory.retrieveContext({ query: lastUser, projectId })
            if (text) {
              systemParts.push(
                'Background memory (context only — do NOT respond to these notes or raise them ' +
                  "unprompted; use them only if they're relevant to the user's message below). " +
                  'These are things Sunny remembers about the user from PAST, separate conversations:\n' +
                  text
              )
            }
          } catch {
            // Memory recall is non-critical; proceed without it.
          }
        }
      }
      // Agent tools (spec §7): file + shell tools rooted to the chat's workspace
      // folder (the "Chat in Folder" pick), gated by the agent's permission mode +
      // allowed_tools. Only an agent-scoped chat that has BOTH an allowlist and a
      // workspace gets tools; otherwise the model runs chat/web only.
      let agentTools: ReturnType<typeof buildAgentToolset> | undefined
      if (agent) {
        const allowed = new Set(parseAllowedTools(agent.allowed_tools))
        if (allowed.size > 0) {
          // Ask-mode approval: round-trip a request to the renderer modal and wait.
          const confirm: ConfirmFn = (req) =>
            new Promise<boolean>((resolve) => {
              const requestId = randomUUID()
              pendingConfirms.set(requestId, resolve)
              if (!sender.isDestroyed()) {
                sender.send(IPC.chatConfirm, {
                  streamId,
                  requestId,
                  tool: req.tool,
                  title: req.title,
                  detail: req.detail
                })
              }
              setTimeout(() => {
                if (pendingConfirms.delete(requestId)) resolve(false)
              }, 120_000)
            })
          agentTools = buildAgentToolset({
            workspace: folderPath,
            mode: permissionMode ?? agent.permission_mode,
            allowed,
            signal: controller.signal,
            confirm,
            generatedDir: join(app.getPath('userData'), 'generated'),
            // Board tools + external MCP tools, gated by the same allowlist +
            // permission mode as fs/shell (see registry).
            board: { tasks: repos.tasks, dependencies: repos.taskDependencies },
            actorName: agent.name,
            mcp
          })
          // Tools exist but this provider can't run them — tell the model so it
          // explains instead of silently pretending it acted.
          if (agentTools.tools.length > 0 && !provider.streamWithTools) {
            systemParts.push(
              'Note: file/command tools are not available on the current provider/model. ' +
                'Describe the steps to take instead of performing them, or switch to a local ' +
                '(Ollama) or Grok/OpenRouter/Groq model to actually run them.'
            )
          }
        }
      }

      const finalTurns: ChatTurn[] =
        systemParts.length > 0
          ? [{ role: 'system', content: systemParts.join('\n\n') }, ...turns]
          : turns

      // Run accounting for interactive chats (0.5.1): every send is a run row
      // with usage + estimated cost, so Activity / the budget's month spend see
      // chat work too — previously only worker runs were counted.
      const chatRun = repos.runs.create({
        agentId: agent?.id ?? null,
        chatId,
        projectId: projectId ?? null,
        provider: kind,
        model,
        input: [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''
      })
      let chatUsage: { promptTokens: number; completionTokens: number } | null = null
      let chatRunFinished = false
      finishChatRun = (status, error) => {
        if (chatRunFinished) return
        chatRunFinished = true
        const cost = chatUsage
          ? estimateCostUsd(kind, model, chatUsage.promptTokens, chatUsage.completionTokens)
          : null
        repos.runs.finish(chatRun.id, {
          status,
          error: error ?? null,
          ...(chatUsage
            ? { promptTokens: chatUsage.promptTokens, completionTokens: chatUsage.completionTokens }
            : {}),
          ...(cost !== null ? { costUsd: cost } : {})
        })
      }

      let aborted = false
      // streamTurn routes to native web search, Sunny's web/agent tools, or a
      // plain stream depending on the web toggle, agent tools, and provider.
      for await (const chunk of streamTurn(provider, {
        apiKey,
        model,
        messages: finalTurns,
        signal: controller.signal,
        webSearch,
        agentTools,
        // Durable audit trail: interactive tool executions land in the activity
        // log too (the worker path records its own with run/task ids).
        onToolEvent: (e) => {
          try {
            repos.activity.record({
              kind: 'tool.executed',
              actor: agent?.name ?? 'chat',
              agentId: agent?.id ?? null,
              projectId: projectId ?? null,
              payload: {
                summary: `${agent?.name ?? 'Chat'} ran ${e.name} (${e.ok ? 'ok' : 'FAILED'}, ${e.durationMs} ms)`,
                tool: e.name,
                args: e.args,
                result: e.resultPreview,
                ok: e.ok,
                durationMs: e.durationMs,
                chatId
              }
            })
          } catch (err) {
            console.error('[sunny] tool audit record failed', err)
          }
        }
      })) {
        if (chunk.type === 'delta') {
          acc += chunk.text
          send({ streamId, type: 'delta', text: chunk.text })
        } else if (chunk.type === 'thinking') {
          // The model's reasoning — streamed live to the collapsible section
          // and accumulated for persistence (separately from the answer).
          thinkingAcc += chunk.text
          send({ streamId, type: 'thinking', text: chunk.text })
        } else if (chunk.type === 'status') {
          // Transient tool-activity line ("🔎 Searching…") — show live, don't save.
          send({ streamId, type: 'status', text: chunk.text })
        } else if (chunk.type === 'usage') {
          // Token accounting (not part of the transcript) — lands on the run row.
          chatUsage = chatUsage
            ? {
                promptTokens: chatUsage.promptTokens + chunk.promptTokens,
                completionTokens: chatUsage.completionTokens + chunk.completionTokens
              }
            : { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens }
        } else if (chunk.type === 'error') {
          if (controller.signal.aborted) {
            aborted = true
            break
          }
          finishChatRun('failed', chunk.message)
          send({ streamId, type: 'error', message: chunk.message })
          return
        } else {
          break // 'done'
        }
      }

      // A cancel before any text produced no assistant turn worth keeping.
      if (aborted && acc.length === 0) {
        finishChatRun('cancelled')
        send({ streamId, type: 'error', message: 'Cancelled' })
        return
      }

      // Persist the assistant turn (full or partial-on-cancel) and finish. Any
      // files the agent produced this turn (create_file) ride along as 'file'
      // attachments so the bubble can offer Open / Save.
      const artifacts = agentTools?.artifacts ?? []
      const saved = repos.messages.create({
        chatId,
        role: 'assistant',
        content: acc,
        provider: kind,
        model,
        ...(thinkingAcc !== '' ? { thinking: thinkingAcc } : {}),
        attachments:
          artifacts.length > 0
            ? JSON.stringify(
                artifacts.map((a) => ({
                  kind: 'file',
                  name: a.name,
                  path: a.path,
                  format: a.format,
                  mediaType: a.mediaType,
                  bytes: a.bytes
                }))
              )
            : undefined
      })
      repos.chats.touch(chatId)
      finishChatRun(aborted ? 'cancelled' : 'succeeded')
      send({ streamId, type: 'done', message: saved })

      // Capture durable memory from this completed exchange (async, fire-and-
      // forget — extraction runs an extra cheap model call but never blocks).
      if (memory.autoEnabled() && acc.trim().length > 0) {
        const userText = [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''
        void memory.capture({
          chatId,
          userText,
          assistantText: acc,
          projectId,
          generate: (messages) => accumulateStream(provider, { apiKey, model, messages })
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stream failed'
      if (controller.signal.aborted && acc.length > 0) {
        const saved = repos.messages.create({
          chatId,
          role: 'assistant',
          content: acc,
          provider: kind,
          model,
          ...(thinkingAcc !== '' ? { thinking: thinkingAcc } : {})
        })
        repos.chats.touch(chatId)
        finishChatRun('cancelled')
        send({ streamId, type: 'done', message: saved })
      } else {
        finishChatRun('failed', message)
        send({ streamId, type: 'error', message })
      }
    } finally {
      activeStreams.delete(streamId)
    }
  }

  ipcMain.handle(IPC.chatSend, (event, raw) => {
    const { chatId, content, model, provider, folderPath, webSearch, permissionMode, images } =
      ChatSendParams.parse(raw)
    const chat = repos.chats.get(chatId)
    if (!chat) throw new Error(`Chat not found: ${chatId}`)
    // Per-turn provider selection enables mid-conversation switching.
    const kind = provider ?? chat.provider ?? 'openai'

    // Persist the user turn; title the chat from its first message.
    const isFirstMessage = repos.messages.listByChat(chatId).length === 0
    const userMessage = repos.messages.create({
      chatId,
      role: 'user',
      content,
      attachments: images && images.length > 0 ? JSON.stringify(images) : undefined
    })
    repos.chats.touch(chatId)
    let derivedTitle: string | undefined
    if (isFirstMessage && (!chat.title || chat.title.trim() === '')) {
      derivedTitle = deriveTitle(content)
      repos.chats.rename(chatId, derivedTitle)
    }

    const streamId = randomUUID()
    const turns = toChatTurns(repos.messages.listByChat(chatId))

    // Stream asynchronously; deltas arrive over the chatStream channel.
    void runStream(event.sender, {
      kind,
      chatId,
      model,
      streamId,
      turns,
      folderPath,
      agentId: chat.agent_id ?? undefined,
      webSearch,
      permissionMode,
      projectId: chat.project_id ?? undefined
    })

    return ChatSendResult.parse({ streamId, userMessage, title: derivedTitle })
  })

  // Retry a failed turn: re-stream the assistant reply for the chat's EXISTING
  // trailing user message. Unlike chat:send it persists NO new user turn — so a
  // retry never duplicates the prompt or loses its images (both live on the
  // already-persisted turn that the failed send created).
  ipcMain.handle(IPC.chatRetry, (event, raw) => {
    const { chatId, model, provider, folderPath, webSearch, permissionMode } =
      ChatRetryParams.parse(raw)
    const chat = repos.chats.get(chatId)
    if (!chat) throw new Error(`Chat not found: ${chatId}`)
    const history = repos.messages.listByChat(chatId)
    const last = history[history.length - 1]
    if (!last || last.role !== 'user') {
      throw new Error('Nothing to retry — the last turn is not a pending message.')
    }
    const kind = provider ?? chat.provider ?? 'openai'
    const streamId = randomUUID()
    void runStream(event.sender, {
      kind,
      chatId,
      model,
      streamId,
      turns: toChatTurns(history),
      folderPath,
      agentId: chat.agent_id ?? undefined,
      webSearch,
      permissionMode,
      projectId: chat.project_id ?? undefined
    })
    return ChatRetryResult.parse({ streamId })
  })

  ipcMain.handle(IPC.chatCancel, (_event, raw) => {
    const { streamId } = ChatCancelParams.parse(raw)
    activeStreams.get(streamId)?.abort()
    return OkResult.parse({ ok: true })
  })

  // The renderer's answer to a tool-approval request (Ask mode). Resolves the
  // pending confirm promise the tool loop is awaiting (matched by requestId).
  ipcMain.handle(IPC.chatConfirmRespond, (_event, raw) => {
    const { requestId, allow } = ChatConfirmRespondParams.parse(raw)
    const resolve = pendingConfirms.get(requestId)
    if (resolve) {
      pendingConfirms.delete(requestId)
      resolve(allow)
    }
    return OkResult.parse({ ok: true })
  })

  // --- tasks / kanban board (spec §6) --------------------------------------
  ipcMain.handle(IPC.tasksList, (_event, raw) => {
    const { projectId } = TasksListParams.parse(raw)
    return TasksListResult.parse(repos.tasks.list(projectId))
  })
  ipcMain.handle(IPC.tasksCreate, (_event, raw) =>
    Task.parse(repos.tasks.create(TaskCreateParams.parse(raw)))
  )
  ipcMain.handle(IPC.tasksUpdate, (_event, raw) =>
    Task.parse(repos.tasks.update(TaskUpdateParams.parse(raw)))
  )
  ipcMain.handle(IPC.tasksMove, (_event, raw) =>
    Task.parse(repos.tasks.move(TaskMoveParams.parse(raw)))
  )
  ipcMain.handle(IPC.tasksDelete, (_event, raw) => {
    const { id } = TaskDeleteParams.parse(raw)
    repos.tasks.delete(id)
    return OkResult.parse({ ok: true })
  })
  // Work one task now in the background: the worker claims it (→ In Progress) and
  // runs it as its agent, then advances the card. Fire-and-forget — failures land
  // on the card (→ Blocked with a reason). No chat navigation; the user can open
  // the linked chat afterward to review what the agent did.
  ipcMain.handle(IPC.tasksWorkNow, (_event, raw) => {
    const { id } = TaskWorkNowParams.parse(raw)
    void worker.workTaskById(id).catch((err) => console.error('[sunny] workNow failed', id, err))
    return OkResult.parse({ ok: true })
  })
  // Rework-with-feedback (0.5.1): the user reviewed a result and wants changes.
  // The critique lands as a user turn in the task's WORKING chat (context_ref),
  // so the resumed run sees exactly what to fix instead of restarting blind.
  ipcMain.handle(IPC.taskRework, (_event, raw) => {
    const { id, feedback } = TaskReworkParams.parse(raw)
    const task = repos.tasks.get(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    if (task.locked_by != null) {
      throw new Error('This task is currently running — wait for it to finish, then request changes.')
    }
    const chatId = task.context_ref ?? task.chat_id
    if (chatId && repos.chats.get(chatId)) {
      repos.messages.create({
        chatId,
        role: 'user',
        content: `The user reviewed your result and requests changes: ${feedback}\n\nAddress this and produce the corrected, complete result.`
      })
      repos.chats.touch(chatId)
      // Runs resume from context_ref — make sure it points at this chat.
      repos.tasks.setContextRef(task.id, chatId)
    }
    repos.tasks.setWake(task.id, null)
    repos.tasks.move({
      id: task.id,
      status: 'Planned',
      actor: 'user',
      note: `Changes requested: ${feedback.length > 120 ? feedback.slice(0, 120) + '…' : feedback}`
    })
    void worker.workTaskById(task.id).catch((err) => console.error('[sunny] rework failed', id, err))
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.taskEvents, (_event, raw) => {
    const { taskId } = TaskEventsParams.parse(raw)
    return TaskEventsResult.parse(repos.tasks.events(taskId))
  })
  ipcMain.handle(IPC.tasksActivity, (_event, raw) => {
    const { limit } = TaskActivityParams.parse(raw ?? {})
    return TaskActivityResult.parse(repos.tasks.recentActivity(limit ?? 20))
  })
  // Multi-agent delegation: kick off the manager→worker orchestration and return
  // immediately — it decomposes + works subtasks + synthesizes over time, with
  // progress visible on the board (children appear, then complete).
  ipcMain.handle(IPC.tasksDelegate, (_event, raw) => {
    const { taskId, managerAgentId, workerAgentId } = TaskDelegateParams.parse(raw)
    void worker
      .delegate(taskId, { managerAgentId, workerAgentId })
      .catch((err) => console.error('[sunny] delegate failed', taskId, err))
    return OkResult.parse({ ok: true })
  })

  // --- agents library (spec §7) --------------------------------------------
  ipcMain.handle(IPC.agentsList, () => AgentsListResult.parse(repos.agents.list()))
  ipcMain.handle(IPC.agentsCreate, (_event, raw) =>
    Agent.parse(repos.agents.create(AgentCreateParams.parse(raw)))
  )
  ipcMain.handle(IPC.agentsUpdate, (_event, raw) =>
    Agent.parse(repos.agents.update(AgentUpdateParams.parse(raw)))
  )
  ipcMain.handle(IPC.agentsDelete, (_event, raw) => {
    const { id } = AgentDeleteParams.parse(raw)
    repos.agents.delete(id)
    // If this WAS the default agent, clear the dangling setting — otherwise the
    // worker keeps resolving a deleted id and silently stops working unassigned
    // tasks. (manager_id / goal owner / schedule agent are FK ON DELETE SET NULL;
    // board tasks reference by name and block with a clear "reassign" reason.)
    if (repos.settings.get('default_agent') === id) {
      repos.settings.set('default_agent', '')
    }
    return OkResult.parse({ ok: true })
  })
  // Governance lifecycle (structure layer): pause/resume/terminate. A paused
  // agent is skipped by the heartbeat; its tasks wait until it's resumed.
  ipcMain.handle(IPC.agentsSetLifecycle, (_event, raw) => {
    const { id, state } = AgentSetLifecycleParams.parse(raw)
    const updated = repos.agents.setLifecycle(id, state)
    if (!updated) throw new Error(`Agent not found: ${id}`)
    repos.activity.record({
      kind: 'agent.lifecycle',
      actor: 'user',
      agentId: id,
      payload: { summary: `${updated.name} ${state === 'active' ? 'resumed' : state}`, state }
    })
    return Agent.parse(updated)
  })
  // Team (structure layer): the agent reporting tree + live heartbeat (each
  // agent's currently-claimed task). The renderer builds the tree from manager_id.
  ipcMain.handle(IPC.agentsOrgChart, () => AgentsOrgChartResult.parse(repos.agents.orgChart()))

  // --- projects (spec §7) ---------------------------------------------------
  ipcMain.handle(IPC.projectsList, (_event, raw) => {
    const { includeArchived } = ProjectsListParams.parse(raw ?? {})
    return ProjectsListResult.parse(repos.projects.list(includeArchived ?? false))
  })
  ipcMain.handle(IPC.projectsCreate, (_event, raw) =>
    Project.parse(repos.projects.create(ProjectCreateParams.parse(raw)))
  )
  ipcMain.handle(IPC.projectsUpdate, (_event, raw) =>
    Project.parse(repos.projects.update(ProjectUpdateParams.parse(raw)))
  )
  ipcMain.handle(IPC.projectsDelete, (_event, raw) => {
    const { id } = ProjectDeleteParams.parse(raw)
    repos.projects.delete(id)
    return OkResult.parse({ ok: true })
  })

  // --- scheduler (spec §7) --------------------------------------------------
  ipcMain.handle(IPC.schedulesList, () => SchedulesListResult.parse(repos.schedules.list()))
  ipcMain.handle(IPC.schedulesCreate, (_event, raw) => {
    const p = ScheduleCreateParams.parse(raw)
    const created = repos.schedules.create({
      name: p.name,
      cron: p.cadence,
      agentId: p.agentId ?? null,
      projectId: p.projectId ?? null,
      payload: JSON.stringify({
        prompt: p.prompt ?? '',
        provider: p.provider ?? null,
        model: p.model ?? null
      }),
      enabled: p.enabled ?? true,
      nextRunAt: nextRunIso(p.cadence, Date.now())
    })
    return Schedule.parse(created)
  })
  ipcMain.handle(IPC.schedulesUpdate, (_event, raw) => {
    const p = ScheduleUpdateParams.parse(raw)
    // Only re-base the next fire time when the cadence actually CHANGES — editing
    // the prompt/model/agent must not silently reset the schedule's clock.
    const existing = repos.schedules.get(p.id)
    const cadenceChanged = p.cadence !== undefined && p.cadence !== existing?.cron
    const updated = repos.schedules.update({
      id: p.id,
      name: p.name,
      cron: p.cadence,
      agentId: p.agentId,
      projectId: p.projectId,
      // Re-pack payload when any payload-held field (prompt / model override)
      // changed, MERGING onto the stored payload so an update carrying only some
      // fields doesn't wipe the omitted ones.
      payload:
        p.prompt === undefined && p.provider === undefined && p.model === undefined
          ? undefined
          : mergeSchedulePayload(existing?.payload ?? null, {
              prompt: p.prompt,
              provider: p.provider,
              model: p.model
            }),
      enabled: p.enabled,
      // Re-base the next fire time only when the cadence changed (see above).
      nextRunAt: cadenceChanged && p.cadence ? nextRunIso(p.cadence, Date.now()) : undefined
    })
    return Schedule.parse(updated)
  })
  ipcMain.handle(IPC.schedulesDelete, (_event, raw) => {
    const { id } = ScheduleDeleteParams.parse(raw)
    repos.schedules.delete(id)
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.schedulesRunNow, async (_event, raw) => {
    const { id } = ScheduleRunNowParams.parse(raw)
    await scheduler.runNow(id)
    return OkResult.parse({ ok: true })
  })

  // --- memory browser (spec §5) --------------------------------------------
  ipcMain.handle(IPC.memoriesList, (_event, raw) =>
    MemoriesListResult.parse(repos.memories.list(MemoriesListParams.parse(raw)))
  )
  ipcMain.handle(IPC.memoriesCreate, (_event, raw) =>
    Memory.parse(repos.memories.create(MemoryCreateParams.parse(raw)))
  )
  ipcMain.handle(IPC.memoriesUpdate, (_event, raw) =>
    Memory.parse(repos.memories.update(MemoryUpdateParams.parse(raw)))
  )
  ipcMain.handle(IPC.memoriesDelete, (_event, raw) => {
    const { id } = MemoryDeleteParams.parse(raw)
    repos.memories.delete(id)
    return OkResult.parse({ ok: true })
  })

  // Knowledge-graph memory (spec §5)
  ipcMain.handle(IPC.memoryGraph, (_event, raw) =>
    MemoryGraphResult.parse(memory.getGraph(MemoryGraphParams.parse(raw)))
  )
  ipcMain.handle(IPC.memoryEntity, (_event, raw) => {
    const { id } = MemoryEntityParams.parse(raw)
    return MemoryEntityDetail.parse(memory.getEntityDetail(id))
  })
  ipcMain.handle(IPC.memoryStatus, () => MemoryStatusResult.parse(memory.status()))
  ipcMain.handle(IPC.memorySetAuto, (_event, raw) => {
    const { enabled } = MemorySetAutoParams.parse(raw)
    memory.setAuto(enabled)
    return OkResult.parse({ ok: true })
  })
  // Switch the embedding provider/model live: persist the choice, re-resolve the
  // embedder, re-size the vector table to its dimension, swap it into the memory
  // service, and re-embed existing memories in the background.
  ipcMain.handle(IPC.memorySetEmbedding, async (_event, raw) => {
    const { provider, model } = MemorySetEmbeddingParams.parse(raw)
    repos.settings.set('embedding_provider', provider)
    repos.settings.set('embedding_model', model)
    const ollamaBaseUrl = repos.settings.get('ollama_base_url') ?? OLLAMA_DEFAULT_BASE_URL
    const resolved = await resolveEmbedder({
      settings: repos.settings,
      providers: repos.providers,
      secretStore,
      ollamaBaseUrl
    })
    if (resolved.available) reconcileVectorDimension(db, repos.settings, resolved.dim)
    memory.configure(resolved.embedder, resolved.available)
    if (resolved.available) {
      void memory.reembedAll().catch((err) => console.error('[sunny] reembed failed', err))
    }
    return MemoryStatusResult.parse(memory.status())
  })
  // Re-embed all memories with the active embedder (manual backfill button).
  ipcMain.handle(IPC.memoryReembed, async () => {
    return MemoryReembedResult.parse(await memory.reembedAll())
  })

  // --- MCP servers (structure layer) ---------------------------------------
  ipcMain.handle(IPC.mcpList, () => McpListResult.parse(mcp.status()))
  ipcMain.handle(IPC.mcpSave, async (_event, raw) => {
    const { servers } = McpSaveParams.parse(raw)
    await mcp.saveServers(servers)
    return McpListResult.parse(mcp.status())
  })

  // --- settings / app config (spec §10) ------------------------------------
  ipcMain.handle(IPC.settingsAll, () => SettingsAllResult.parse(repos.settings.all()))
  ipcMain.handle(IPC.settingsGet, (_event, raw) => {
    const { key } = SettingGetParams.parse(raw)
    return SettingGetResult.parse({ key, value: repos.settings.get(key) })
  })
  ipcMain.handle(IPC.settingsSet, (_event, raw) => {
    const { key, value } = SettingSetParams.parse(raw)
    if (!RENDERER_WRITABLE_SETTINGS.has(key)) {
      console.warn(`[sunny] settings:set refused for non-allowlisted key "${key}"`)
      return OkResult.parse({ ok: false })
    }
    repos.settings.set(key, value)
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.settingsDataPaths, () => {
    const userDataDir = app.getPath('userData')
    return DataPathsResult.parse({
      userDataDir,
      dbPath: join(userDataDir, 'sunny.sqlite'),
      secretsBackend: getSecretsHealth().backend
    })
  })

  // --- autonomous task worker (spec §7) ------------------------------------
  ipcMain.handle(IPC.workerStatus, () => WorkerStatusResult.parse(worker.status()))
  ipcMain.handle(IPC.workerSetEnabled, (_event, raw) => {
    const { enabled } = WorkerSetEnabledParams.parse(raw)
    worker.setEnabled(enabled)
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.workerSetInterval, (_event, raw) => {
    const { minutes } = WorkerSetIntervalParams.parse(raw)
    worker.setIntervalMinutes(minutes)
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.workerRunNow, () => {
    worker.runNow()
    return OkResult.parse({ ok: true })
  })

  // --- activity log (structure layer) --------------------------------------
  ipcMain.handle(IPC.activityList, (_event, raw) => {
    const { limit, kinds, projectId } = ActivityListParams.parse(raw ?? {})
    return ActivityListResult.parse(repos.activity.recent({ limit, kinds, projectId }))
  })
  // Count of review-worthy events newer than the seen watermark — the rail
  // badge. Cheaper than activityList (a COUNT(*), no row payloads, no 100-cap).
  ipcMain.handle(IPC.activityUnseenCount, (_event, raw) => {
    const { kinds, projectId } = ActivityUnseenCountParams.parse(raw ?? {})
    const seenAt = repos.settings.get('activity_seen_at') ?? ''
    return CountResult.parse({ count: repos.activity.unseenCount(seenAt, { kinds, projectId }) })
  })
  // Mark everything up to now as seen — the rail's "new" badge counts review
  // events newer than this watermark, so this clears it.
  ipcMain.handle(IPC.activityMarkSeen, () => {
    repos.settings.set('activity_seen_at', new Date().toISOString())
    return OkResult.parse({ ok: true })
  })

  // --- costs & budget (0.5.1) -----------------------------------------------
  // Month-to-date estimated spend across ALL runs (worker + chat) + the cap.
  ipcMain.handle(IPC.costsSummary, () => {
    const start = monthStartIso()
    const spend = repos.runs.monthSpend(start)
    const budgetRaw = Number(repos.settings.get('budget_monthly_usd'))
    return CostsSummaryResult.parse({
      monthUsd: spend.usd,
      monthTokensIn: spend.tokensIn,
      monthTokensOut: spend.tokensOut,
      budgetUsd: Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : null,
      monthStart: start
    })
  })

  // --- approvals (structure layer, governance) -----------------------------
  ipcMain.handle(IPC.approvalsList, (_event, raw) => {
    const { status, projectId } = ApprovalsListParams.parse(raw ?? {})
    return ApprovalsListResult.parse(repos.approvals.list({ status, projectId }))
  })
  // Count of pending approvals for the rail badge (cheaper than approvalsList).
  ipcMain.handle(IPC.approvalsPendingCount, (_event, raw) => {
    const { projectId } = ApprovalsPendingCountParams.parse(raw ?? {})
    return CountResult.parse({ count: repos.approvals.pendingCount(projectId) })
  })
  ipcMain.handle(IPC.approvalsDecide, (_event, raw) => {
    const { id, decision, decidedBy } = ApprovalDecideParams.parse(raw)
    const approval = repos.approvals.decide(id, { status: decision, decidedBy })
    if (!approval) throw new Error(`Approval not found: ${id}`)
    const task = approval.task_id ? repos.tasks.get(approval.task_id) : null
    repos.activity.record({
      kind: decision === 'approved' ? 'approval.approved' : 'approval.rejected',
      actor: decidedBy ?? 'user',
      agentId: approval.agent_id,
      taskId: approval.task_id,
      runId: approval.run_id,
      projectId: task?.project_id ?? null,
      payload: {
        summary: `${decidedBy ?? 'You'} ${decision === 'approved' ? 'approved' : 'rejected'}: ${approval.title}`,
        gate: approval.gate
      }
    })
    if (task) {
      // Only touch the task when it is NOT mid-run. A run keeps executing for up
      // to 5 min after recording a gate, so if it's still locked we must not
      // release the lock / move the card out from under it — the worker's
      // end-of-run logic reads this decision and re-queues or parks accordingly.
      const midRun = task.locked_by != null
      if (decision === 'approved') {
        if (!midRun) {
          // Re-queue the parked task and kick THIS task directly — workTaskById
          // targets it and (like Work-now and the scheduler) does NOT require the
          // worker heartbeat to be enabled, so parking with the worker off resumes.
          repos.tasks.setWake(task.id, null)
          repos.tasks.move({
            id: task.id,
            status: 'Planned',
            actor: 'user',
            note: `Approved: ${approval.title}`
          })
          void worker.workTaskById(task.id)
        }
        // midRun: record only; the worker picks up the approval at end-of-run.
      } else if (!midRun) {
        repos.tasks.move({
          id: task.id,
          status: 'Blocked',
          actor: 'user',
          note: `Approval rejected: ${approval.title}`
        })
      }
      // Rejected + midRun: record only; the worker parks it at end-of-run.
    }
    return OkResult.parse({ ok: true })
  })

  // --- objectives / goals (structure layer) --------------------------------
  ipcMain.handle(IPC.goalsList, (_event, raw) => {
    const { projectId } = GoalsListParams.parse(raw ?? {})
    return GoalsListResult.parse(repos.goals.listNodes(projectId))
  })
  ipcMain.handle(IPC.goalGet, (_event, raw) => {
    const { id } = GoalGetParams.parse(raw)
    const goal = repos.goals.get(id)
    if (!goal) throw new Error(`Goal not found: ${id}`)
    const tasks = repos.tasks.listByGoal(id)
    return GoalGetResult.parse({ goal, ancestry: repos.goals.ancestry(id), tasks })
  })
  ipcMain.handle(IPC.goalsCreate, (_event, raw) => {
    const params = GoalCreateParams.parse(raw)
    return Goal.parse(repos.goals.create(params))
  })
  ipcMain.handle(IPC.goalsUpdate, (_event, raw) => {
    const params = GoalUpdateParams.parse(raw)
    return Goal.parse(repos.goals.update(params))
  })
  ipcMain.handle(IPC.goalsDelete, (_event, raw) => {
    const { id } = GoalDeleteParams.parse(raw)
    repos.goals.delete(id)
    return OkResult.parse({ ok: true })
  })

  // --- task ↔ goal link + blocker dependencies (structure layer) -----------
  ipcMain.handle(IPC.taskSetGoal, (_event, raw) => {
    const { taskId, goalId } = TaskSetGoalParams.parse(raw)
    repos.tasks.setGoal(taskId, goalId)
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.taskDependencies, (_event, raw) => {
    const { taskId } = TaskDependenciesParams.parse(raw)
    return TaskDependenciesResult.parse(repos.taskDependencies.forTask(taskId))
  })
  ipcMain.handle(IPC.taskDependencyAdd, (_event, raw) => {
    const { taskId, dependsOnTaskId, kind } = TaskDependencyAddParams.parse(raw)
    repos.taskDependencies.add(taskId, dependsOnTaskId, kind)
    return OkResult.parse({ ok: true })
  })
  ipcMain.handle(IPC.taskDependencyRemove, (_event, raw) => {
    const { taskId, dependsOnTaskId } = TaskDependencyRemoveParams.parse(raw)
    repos.taskDependencies.remove(taskId, dependsOnTaskId)
    return OkResult.parse({ ok: true })
  })
}
