import { create } from 'zustand'
import type { ProviderStatus } from '@shared/ipc/contract'
import type { Project } from '@shared/db/types'
import { firstUsableModel, isUsableModel, isUsableProvider } from '@renderer/lib/providers'

/**
 * Persisted setting key for the active project scope (spec §7). The value is the
 * project id, or '' for "All Projects". Renderer-writable.
 */
const ACTIVE_PROJECT_KEY = 'active_project'

/**
 * Persisted setting keys for the user's default chat model — the provider + model
 * a freshly opened chat starts on. Renderer-writable. Empty string = no default
 * (fall back to the first usable provider/model).
 */
const DEFAULT_PROVIDER_KEY = 'default_provider'
const DEFAULT_MODEL_KEY = 'default_model'

/** Permission modes from the spec (§7) — gates side-effecting agent actions. */
export type PermissionMode = 'Ask' | 'Plan' | 'Autopilot'

// --- Model-selection helpers (shared by setProviders + the default loader) ---
// The usable-provider/model predicates now live in @renderer/lib/providers so
// every picker (ModelSelector, DefaultModelSection, ScheduleForm) agrees.

/** True when `provider`/`model` still names a connected, enabled, on model. */
function selectionIsValid(
  providers: ProviderStatus[],
  provider: string | null,
  model: string | null
): boolean {
  if (!provider || !model) return false
  const p = providers.find((x) => x.kind === provider)
  return (
    p !== undefined &&
    isUsableProvider(p) &&
    p.models.some((m) => m.id === model) &&
    isUsableModel(p, model)
  )
}

/**
 * Resolve which provider/model a chat should use, in priority order:
 *   1. the current selection, if it's still usable (so an in-session switch sticks);
 *   2. the user's configured default, if it's usable (the Settings → Default model);
 *   3. the first usable provider's preferred model (last-resort fallback).
 * This is why a saved default now wins over the alphabetical "first provider".
 */
function resolveSelection(
  providers: ProviderStatus[],
  defaultProvider: string | null,
  defaultModel: string | null,
  currentProvider: string | null,
  currentModel: string | null
): { provider: string | null; model: string | null } {
  if (selectionIsValid(providers, currentProvider, currentModel)) {
    return { provider: currentProvider, model: currentModel }
  }
  if (selectionIsValid(providers, defaultProvider, defaultModel)) {
    return { provider: defaultProvider, model: defaultModel }
  }
  const firstUsable = providers.find((p) => isUsableProvider(p) && firstUsableModel(p) !== null)
  return firstUsable
    ? { provider: firstUsable.kind, model: firstUsableModel(firstUsable) }
    : { provider: null, model: null }
}

/** Health of the IPC pipe to the main process. */
export type CoreStatus = 'connecting' | 'connected' | 'offline'

interface UiState {
  /** Current agent permission mode shown on the shield chip. */
  permissionMode: PermissionMode
  /** IPC health, set by the core-ping hook. */
  coreStatus: CoreStatus
  /** Main-process version string reported by `window.sunny.ping()`. */
  coreVersion: string | null
  /** Provider statuses (with reachable models), loaded via providers.list(). */
  providers: ProviderStatus[]
  /** Whether providers have been fetched at least once this session. */
  providersLoaded: boolean
  /**
   * The provider kind selected in the composer / chat view, paired with
   * `selectedModel`. Null until a provider is connected and a default resolves.
   */
  selectedProvider: string | null
  /**
   * The model id selected in the composer / chat view. Null until a provider is
   * connected and a default is resolved. Shared by the dashboard + chat view.
   */
  selectedModel: string | null
  /**
   * The user's configured DEFAULT chat provider (Settings → Default model), or
   * null for "none set". A new/refreshed selection prefers this over the
   * first-usable fallback. Persisted to the `default_provider` setting.
   */
  defaultProvider: string | null
  /** The configured default model id (pairs with `defaultProvider`). */
  defaultModel: string | null
  /**
   * A starter prompt staged by a dashboard quick-action chip. The composer
   * consumes this once (applies it to its textarea, then clears it) so it never
   * clobbers later typing. Null when nothing is pending.
   */
  composerDraft: string | null
  /**
   * A search term staged by the dashboard SearchBar before navigating to the
   * Memory view. Memory consumes this once on mount to seed its search box,
   * then clears it. Null when nothing is pending.
   */
  pendingMemoryQuery: string | null
  /**
   * The active project scope (spec §7). `null` = "All Projects" — lists show
   * everything and new chats/tasks are created unattached. A string scopes the
   * UI to that project. IMPORTANT: when calling list/create APIs, map this to
   * `projectId: activeProjectId ?? undefined` (null → undefined = all/unattached);
   * never pass `null` to the IPC layer.
   */
  activeProjectId: string | null
  /** The loaded active (non-archived) projects, for the switcher + dialogs. */
  projects: Project[]
  /**
   * Count of activity events the user hasn't seen yet — drives the rail badge on
   * the Activity item. Set to 0 when the Activity view is opened. (Live tracking
   * of "unseen" lands with the Approvals inbox in a later phase; for now this is
   * the wiring the rail reads.)
   */
  unseenActivityCount: number
  /**
   * Count of pending approval gates — drives the rail badge on Approvals. Kept
   * live by a light global poll (useApprovalsBadge) and refreshed on decide.
   */
  pendingApprovalsCount: number
  setPermissionMode: (mode: PermissionMode) => void
  setCore: (status: CoreStatus, version?: string | null) => void
  setProviders: (providers: ProviderStatus[]) => void
  /** Set the active provider + model atomically (a model belongs to a provider). */
  setSelectedModel: (provider: string, model: string) => void
  /**
   * Set (or clear, with nulls) the user's default chat model. Persists both
   * `default_provider`/`default_model` settings and, when set, switches the live
   * selection to it. Pass nulls to clear the default (selection is left as-is).
   */
  setDefaultModel: (provider: string | null, model: string | null) => void
  /**
   * Startup load: read the persisted default provider/model and seed it. If
   * providers are already loaded, re-resolve the live selection toward the
   * default (at startup the existing selection is only an auto-fallback);
   * otherwise `setProviders` applies it when the list arrives.
   */
  loadDefaultModel: () => Promise<void>
  /** Stage (or clear, with null) a starter prompt for the dashboard composer. */
  setComposerDraft: (draft: string | null) => void
  /** Stage (or clear, with null) a search term for the Memory view. */
  setPendingMemoryQuery: (query: string | null) => void
  /** Replace the loaded project list (used after CRUD in the manage dialog). */
  setProjects: (projects: Project[]) => void
  /** Set the unseen-activity badge count (0 clears the rail badge). */
  setUnseenActivityCount: (count: number) => void
  /** Set the pending-approvals badge count (0 clears the rail badge). */
  setPendingApprovalsCount: (count: number) => void
  /**
   * Switch the active project scope and persist it to the `active_project`
   * setting. Pass `null` for "All Projects" (persisted as '').
   */
  setActiveProject: (id: string | null) => void
  /**
   * Startup load: fetch active projects + read the persisted `active_project`
   * setting, validate the saved id still exists (and isn't archived), then seed
   * state. Falls back to "All Projects" (null) when the saved id is gone.
   */
  loadProjects: () => Promise<void>
}

/**
 * Light, non-persisted UI store. Holds presentation state plus the loaded
 * provider list and the chosen model so the dashboard composer and the chat
 * view stay in sync. Per-chat streaming buffers live in `chatStore`.
 */
export const useUiStore = create<UiState>((set) => ({
  // Ask, not Autopilot — a new user's first tool-using turn should confirm each
  // side effect rather than run it unattended. They can switch to Autopilot when
  // they trust a flow.
  permissionMode: 'Ask',
  coreStatus: 'connecting',
  coreVersion: null,
  providers: [],
  providersLoaded: false,
  selectedProvider: null,
  selectedModel: null,
  defaultProvider: null,
  defaultModel: null,
  composerDraft: null,
  pendingMemoryQuery: null,
  activeProjectId: null,
  projects: [],
  unseenActivityCount: 0,
  pendingApprovalsCount: 0,
  setPermissionMode: (permissionMode) => set({ permissionMode }),
  setCore: (coreStatus, coreVersion = null) => set({ coreStatus, coreVersion }),
  setProviders: (providers) =>
    set((state) => {
      // Resolve the active provider + model against the new list: keep a still-
      // usable current selection, else the user's configured default, else the
      // first usable provider/model. (See resolveSelection above.)
      const { provider, model } = resolveSelection(
        providers,
        state.defaultProvider,
        state.defaultModel,
        state.selectedProvider,
        state.selectedModel
      )
      return {
        providers,
        providersLoaded: true,
        selectedProvider: provider,
        selectedModel: model
      }
    }),
  setSelectedModel: (selectedProvider, selectedModel) => set({ selectedProvider, selectedModel }),
  setDefaultModel: (provider, model) => {
    set((state) => {
      // Setting a default also switches the live selection to it; clearing
      // (nulls) just drops the default and leaves the current selection alone.
      if (provider && model) {
        return {
          defaultProvider: provider,
          defaultModel: model,
          selectedProvider: provider,
          selectedModel: model
        }
      }
      return { defaultProvider: null, defaultModel: null, selectedProvider: state.selectedProvider }
    })
    // Persist both keys (empty string = cleared). Fire-and-forget.
    void window.sunny.settings.set({ key: DEFAULT_PROVIDER_KEY, value: provider ?? '' })
    void window.sunny.settings.set({ key: DEFAULT_MODEL_KEY, value: model ?? '' })
  },
  loadDefaultModel: async () => {
    try {
      const [provRes, modelRes] = await Promise.all([
        window.sunny.settings.get({ key: DEFAULT_PROVIDER_KEY }),
        window.sunny.settings.get({ key: DEFAULT_MODEL_KEY })
      ])
      const defaultProvider = provRes.value ? provRes.value : null
      const defaultModel = modelRes.value ? modelRes.value : null
      set((state) => {
        // If the provider list is already loaded, re-resolve the selection now so
        // it lands on the saved default (the only existing selection at startup is
        // an auto-fallback). Force past "keep current" by passing nulls for it.
        if (state.providersLoaded) {
          const { provider, model } = resolveSelection(
            state.providers,
            defaultProvider,
            defaultModel,
            null,
            null
          )
          return { defaultProvider, defaultModel, selectedProvider: provider, selectedModel: model }
        }
        return { defaultProvider, defaultModel }
      })
    } catch {
      // Degrade gracefully: no default → first-usable fallback stays in effect.
    }
  },
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  setPendingMemoryQuery: (pendingMemoryQuery) => set({ pendingMemoryQuery }),
  setProjects: (projects) => set({ projects }),
  setUnseenActivityCount: (unseenActivityCount) => set({ unseenActivityCount }),
  setPendingApprovalsCount: (pendingApprovalsCount) => set({ pendingApprovalsCount }),
  setActiveProject: (activeProjectId) => {
    set({ activeProjectId })
    // Persist the scope: the id, or '' for "All Projects". Fire-and-forget —
    // the in-memory switch must never block on the write.
    void window.sunny.settings.set({ key: ACTIVE_PROJECT_KEY, value: activeProjectId ?? '' })
  },
  loadProjects: async () => {
    try {
      const [projects, saved] = await Promise.all([
        window.sunny.projects.list(),
        window.sunny.settings.get({ key: ACTIVE_PROJECT_KEY })
      ])
      // Validate the persisted id still maps to a live (active, non-archived)
      // project; `projects.list()` already excludes archived, so membership is
      // enough. Anything else falls back to "All Projects".
      const savedId = saved.value ?? ''
      const activeProjectId =
        savedId !== '' && projects.some((p) => p.id === savedId) ? savedId : null
      set({ projects, activeProjectId })
    } catch {
      // Degrade gracefully: stay on "All Projects" with no projects loaded.
      set({ projects: [], activeProjectId: null })
    }
  }
}))
