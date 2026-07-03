import type { Repositories } from '@main/repositories'
import type { ProviderRegistry } from '@main/providers'
import type { SecretStore } from '@main/secrets'
import type { MemoryService } from '@main/memory/service'
import type { Agent, Approval, ApprovalStatus, Task } from '@shared/db/types'
import type { ChatTurn, Provider } from '@main/providers/types'
import type { ConfirmFn } from '@main/tools/types'
import {
  OLLAMA_DEFAULT_BASE_URL,
  ollamaReachable,
  ollamaChatModels,
  OPENCODE_DEFAULT_BASE_URL,
  opencodeReachable
} from '@main/providers'
import { resolveBearer, completeText } from '@main/chat/complete'
import { buildAgentToolset, type McpToolSource } from '@main/tools/registry'
import {
  approvalGateOutcome,
  approvalGateKey,
  outcomeAllows,
  postRunDisposition
} from './approval-policy'
import { MAX_RUN_ATTEMPTS, retryDecision } from './run-policy'
import { estimateCostUsd } from '@main/costs/pricing'
import {
  MAX_AGENT_TURNS,
  STATUS_INSTRUCTIONS,
  VERIFICATION_SYSTEM,
  buildContinuePrompt,
  buildReworkPrompt,
  buildVerificationPrompt,
  capChatHistory,
  parseStatusMarker,
  parseVerdict
} from './loop-policy'

// A minimal single-agent task runtime (spec §7, the autonomous slice). On an
// interval it scans the Kanban board for workable tasks (Backlog/Planned),
// resolves the agent (the card's assignee, else the default agent), runs that
// agent on the task to produce a work product (text), records it in a linked
// agent-scoped chat, and advances the card (→ Done, or → Blocked if it can't
// run). Off by default — it makes real model calls on a timer — and serial, so
// it never double-claims a task or stampedes a provider. When the agent's
// `web_access` is on, it searches the web on its own model — natively if the
// model supports it, otherwise via Sunny's own keyless web tools (no cloud
// handoff). `completeText` handles that routing; the worker just passes the
// `webSearch` flag.
//
// The worker can also run an agent's allowed file/shell tools inside the folder
// configured by the `agent_workspace` setting (built per-run via
// `buildAgentToolset`). Because nobody is watching an autonomous run, its confirm
// gate ALWAYS denies: Read tools still run, an Autopilot agent performs
// non-destructive writes/commands on its own, but Ask/Plan agents and any
// destructive Autopilot action are blocked — the agent reports that in its text.

const ENABLED_SETTING = 'worker_enabled'
const INTERVAL_SETTING = 'worker_interval_minutes'
const DEFAULT_AGENT_SETTING = 'default_agent'
const DEFAULT_INTERVAL_MIN = 10
const MAX_PER_SCAN = 5
// Wall-clock budget for a WHOLE run (all agent turns + verification). Nobody is
// watching an autonomous run, so a wedged provider (or a model that never
// stops) must not pin the worker forever. Raised from the old single-shot
// 5-minute cap since a run is now an iterative loop of up to MAX_AGENT_TURNS
// turns; the 90s stream-idle watchdog still fails HUNG streams fast.
const WORK_TIMEOUT_MS = 15 * 60_000
// Setting that turns the post-completion verification pass off ('off'; default on).
const VERIFICATION_SETTING = 'worker_verification'
// Hard monthly spend cap (USD) for autonomous work; unset/0 = no limit. When
// month-to-date estimated cost reaches it, runs park instead of spending.
const BUDGET_SETTING = 'budget_monthly_usd'

/** First instant of the current month (ISO) — the budget window boundary. */
export function monthStartIso(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}
// Abort a stream that produces nothing for this long — a connected-but-stalled
// stream should fail fast (and retry via the backoff policy) instead of pinning
// the serial worker for the full WORK_TIMEOUT_MS.
const STREAM_IDLE_TIMEOUT_MS = 90_000
// Tool rounds for unattended runs. Interactive chats keep the adapters' default
// (5); autonomous multi-step work (list → read → edit → run → react) needs more
// dependent rounds before the loop withholds tools to force an answer.
const WORKER_MAX_TOOL_ROUNDS = 12

export interface TaskWorkerDeps {
  repos: Repositories
  registry: ProviderRegistry
  secretStore: SecretStore
  memory: MemoryService
  /** App-managed output dir for files agents generate (create_file). */
  generatedDir: string
  /** OS-level notification hook (injected so this module stays electron-free).
   *  Fired on approval-requested, task-blocked, and task-finished — the events
   *  a tray-resident user must hear about or unattended work stalls unnoticed. */
  notify?: (n: { title: string; body: string }) => void
  /** Connected MCP servers' tools (injected; agents opt in via `mcp_tools`). */
  mcp?: McpToolSource
}

export interface TaskWorkerStatus {
  enabled: boolean
  intervalMinutes: number
  running: boolean
  lastScanAt: number | null
}

// Parse an agent's `allowed_tools` JSON (a string[]) defensively: any null,
// non-array, or parse error yields an empty allowlist (→ no agent tools).
function parseAllowedTools(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

// --- multi-agent delegation (spec §7) --------------------------------------

const MAX_SUBTASKS = 6
// Per-child cap when threading a finished subtask's output into the next child's
// prompt — keeps a long result from blowing up the downstream context window.
const CHILD_CONTEXT_CHAR_CAP = 4000

const DECOMPOSE_SYSTEM =
  "You are a project manager. Break the user's goal into a SHORT ORDERED list of concrete " +
  'subtasks that together accomplish it. The subtasks run IN ORDER, and each one is given ' +
  "the RESULTS of the earlier ones as input — so later steps can build on earlier steps' " +
  'output. Order them so prerequisites come first. CRUCIALLY: if a later step needs an input ' +
  "the goal does not itself supply (e.g. it says 'evaluate the names' but no names are given), " +
  'make PRODUCING that input the FIRST subtask (e.g. "Brainstorm 10 candidate names") rather ' +
  'than assuming it exists — do not leave a step depending on data nobody generated. Prefer 2-5 ' +
  'subtasks; never more than 6. If the goal is already atomic, return an empty list. Respond ' +
  'with ONLY a JSON object, no prose.'

interface Subtask {
  title: string
  description?: string
}

/** Tolerantly pull {"subtasks":[{title,description}]} out of a model response. */
function parseSubtasks(raw: string): Subtask[] {
  if (!raw) return []
  const fenced = raw.replace(/```json/gi, '').replace(/```/g, '')
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1)) as { subtasks?: unknown }
    if (!Array.isArray(parsed.subtasks)) return []
    return parsed.subtasks
      .filter((s): s is { title: string; description?: unknown } => {
        return Boolean(s) && typeof (s as { title?: unknown }).title === 'string'
      })
      .map((s) => ({
        title: (s.title as string).trim(),
        description: typeof s.description === 'string' ? s.description : undefined
      }))
      .filter((s) => s.title.length > 0)
      .slice(0, MAX_SUBTASKS)
  } catch {
    return []
  }
}

export class TaskWorker {
  readonly #deps: TaskWorkerDeps
  #timer: ReturnType<typeof setInterval> | null = null
  #running = false
  #lastScanAt: number | null = null
  // One AbortController per in-flight run (timeout, stop(), or disable). A set,
  // not a single field, because workTaskById (Work-now, scheduler, mid-run
  // re-queue) can overlap a scan run of a DIFFERENT task — a single controller
  // would let a later run clobber an earlier one's, so stop()/disable could not
  // cancel it and status() would misreport. Empty when idle.
  #aborts = new Set<AbortController>()
  // Pending transient-failure retry timers, cleared on stop() so a quitting app
  // doesn't fire retries (wake_at persists in the DB as the durable fallback).
  #retryTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(deps: TaskWorkerDeps) {
    this.#deps = deps
  }

  // --- config ---------------------------------------------------------------
  #enabled(): boolean {
    return this.#deps.repos.settings.get(ENABLED_SETTING) === 'on'
  }

  #intervalMinutes(): number {
    const raw = Number(
      this.#deps.repos.settings.get(INTERVAL_SETTING) ?? String(DEFAULT_INTERVAL_MIN)
    )
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_INTERVAL_MIN
  }

  status(): TaskWorkerStatus {
    return {
      enabled: this.#enabled(),
      intervalMinutes: this.#intervalMinutes(),
      // A run is in flight if a scan is mid-loop OR any run (incl. Work-now /
      // scheduler) still holds an abort controller.
      running: this.#running || this.#aborts.size > 0,
      lastScanAt: this.#lastScanAt
    }
  }

  setEnabled(enabled: boolean): void {
    this.#deps.repos.settings.set(ENABLED_SETTING, enabled ? 'on' : 'off')
    this.reschedule()
    if (enabled) {
      void this.scan() // act immediately on enable
    } else {
      for (const c of this.#aborts) c.abort() // disabling halts any running task
    }
  }

  setIntervalMinutes(minutes: number): void {
    const m = Number.isFinite(minutes) && minutes >= 1 ? Math.floor(minutes) : DEFAULT_INTERVAL_MIN
    this.#deps.repos.settings.set(INTERVAL_SETTING, String(m))
    this.reschedule()
  }

  // --- lifecycle ------------------------------------------------------------
  start(): void {
    // Any run still 'running' at boot is stale (single-process worker; the app
    // quit mid-run). Fail them so the org chart's live-run join doesn't show a
    // dead run as an agent still working. Must precede #recoverOrphans, which
    // reclaims the tasks those runs held.
    try {
      const recovered = this.#deps.repos.runs.failAllRunning(
        'Recovered at startup — the app quit while this run was in progress.'
      )
      if (recovered > 0) console.warn(`[sunny] task worker: recovered ${recovered} stale run(s)`)
    } catch (err) {
      console.error('[sunny] task worker: failed to recover stale runs', err)
    }
    this.#recoverOrphans()
    this.reschedule()
    if (this.#enabled()) setTimeout(() => void this.scan(), 4000) // initial pass after boot
  }

  // A task left in 'In Progress' at boot was claimed by a worker process that
  // died mid-run — reset it to 'Planned' so it gets retried, and release any
  // stale execution lock. Since the worker is serial and single-process, at boot
  // ANY in-progress task is orphaned: we reclaim a card that still holds a lock
  // (`locked_by`), or — for cards claimed before the lock columns existed — one
  // that has a worker-linked chat (`chat_id`). A card a USER dragged into In
  // Progress has neither, so we leave it alone. Per-row try/catch keeps one bad
  // row from crashing startup.
  //
  // (When the worker is eventually allowed to run concurrently, this should
  // reclaim by `locked_at` lease age instead of "any in-progress at boot".)
  #recoverOrphans(): void {
    let orphans: Task[]
    try {
      orphans = this.#deps.repos.tasks
        .list()
        .filter((t) => t.status === 'In Progress' && (t.locked_by != null || t.chat_id != null))
    } catch (err) {
      console.error('[sunny] task worker: orphan sweep failed to list tasks', err)
      return
    }
    for (const task of orphans) {
      try {
        this.#deps.repos.tasks.releaseLock(task.id)
        this.#deps.repos.tasks.move({ id: task.id, status: 'Planned', actor: 'worker' })
      } catch (err) {
        console.error('[sunny] task worker: failed to reset orphaned task', task.id, err)
      }
    }
  }

  reschedule(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (this.#enabled()) {
      this.#timer = setInterval(() => void this.scan(), this.#intervalMinutes() * 60_000)
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    // Cancel every task currently mid-run, not just the next scheduled scan.
    for (const c of this.#aborts) c.abort()
    for (const t of this.#retryTimers) clearTimeout(t)
    this.#retryTimers.clear()
  }

  // Schedule a heartbeat-independent retry of one task (transient failure). The
  // task's wake_at is already set, so if the app quits first the periodic scan
  // still retries it later; this timer just makes the retry prompt.
  #scheduleRetry(taskId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#retryTimers.delete(timer)
      void this.workTaskById(taskId).catch((err) =>
        console.error('[sunny] task worker: retry failed', taskId, err)
      )
    }, delayMs)
    this.#retryTimers.add(timer)
  }

  runNow(): void {
    // The user's explicit "Run scan now" click must actually scan — force past
    // the enabled gate (which exists to stop the TIMER from running while off).
    void this.scan(true)
  }

  // Run ONE specific task immediately through the same agent execution path as the
  // scan — used by the scheduler when a schedule fires (so a scheduled run works
  // even when the periodic auto-scan is disabled). No-op if the task is gone.
  async workTaskById(
    taskId: string,
    modelOverride?: { provider: string; model: string },
    opts?: { priorContext?: string }
  ): Promise<void> {
    const task = this.#deps.repos.tasks.get(taskId)
    // explicit: this is a direct invocation (Work-now, scheduler, approval
    // re-queue, delegation), so an unresolvable agent gets written feedback
    // rather than a silent skip (that silence is only right for the scan
    // sweeping unassigned backlog). priorContext threads earlier delegation
    // steps' output into this one.
    if (task) await this.#work(task, modelOverride, { explicit: true, priorContext: opts?.priorContext })
  }

  // --- multi-agent delegation (spec §7) -------------------------------------

  // A MANAGER agent decomposes a goal task into subtasks, dispatches each to a
  // WORKER agent (as child tasks on the board, run through the normal execution
  // path), then synthesizes the children's results back onto the parent. Reuses
  // the board (parent_task_id lineage) + the worker. Long-running, so the IPC
  // layer fires this and returns immediately; progress shows on the board /
  // Live Activity. Children run SEQUENTIALLY (the worker shares one abort
  // controller). If the goal can't be split, it's just worked directly.
  async delegate(
    taskId: string,
    opts: { managerAgentId?: string; workerAgentId?: string }
  ): Promise<void> {
    const { repos, registry, secretStore } = this.#deps
    const task = repos.tasks.get(taskId)
    if (!task) return

    const manager = opts.managerAgentId
      ? repos.agents.get(opts.managerAgentId)
      : this.#resolveAgent(task)
    if (!manager) {
      await this.#moveBlocked(task)
      return
    }
    const resolved = await this.#resolveModel(manager)
    if (!resolved) {
      await this.#moveBlocked(task)
      return
    }
    const provider = registry.get(resolved.kind)
    if (!provider) {
      await this.#moveBlocked(task)
      return
    }
    const bearer = await resolveBearer(resolved.kind, { providers: repos.providers, secretStore })
    if ('error' in bearer) {
      await this.#moveBlocked(task)
      return
    }
    const exec = { provider, model: resolved.model, apiKey: bearer.apiKey, kind: resolved.kind }

    let subtasks: Subtask[] = []
    try {
      subtasks = await this.#decompose(task, exec)
    } catch (err) {
      console.error('[sunny] delegate: decomposition failed', task.id, err)
    }

    // Already atomic (or decomposition produced nothing) → just work it directly.
    if (subtasks.length === 0) {
      await this.#work(task)
      return
    }

    // Claim the parent and spawn child subtasks across the worker pool: an
    // explicit worker if given, else the manager's ACTIVE reports — its team
    // (structure layer, Phase 5) — else the manager itself. Subtasks round-robin
    // across the pool so a lead spreads work over the agents reporting to it.
    repos.tasks.move({ id: task.id, status: 'In Progress', actor: manager.name })
    const explicitWorker = opts.workerAgentId ? repos.agents.get(opts.workerAgentId) : null
    const pool = explicitWorker
      ? [explicitWorker]
      : repos.agents.reports(manager.id).filter((a) => a.lifecycle_state === 'active')
    const workers: Agent[] = pool.length > 0 ? pool : [manager]
    const childIds: string[] = []
    subtasks.forEach((sub, i) => {
      const workerAgent = workers[i % workers.length]
      const child = repos.tasks.create({
        title: sub.title,
        description: sub.description,
        status: 'Planned',
        projectId: task.project_id ?? undefined,
        parentTaskId: task.id,
        assignee: workerAgent.name
      })
      childIds.push(child.id)
    })

    // Work the children one at a time, IN ORDER, threading each finished child's
    // output into the next as context — so a step that produces something (e.g.
    // "brainstorm 10 names") feeds the steps that consume it (e.g. "evaluate the
    // names"). Without this, siblings run blind and a consumer step blocks with
    // "no input provided". The accumulated context also mirrors what synthesis sees.
    const priorResults: string[] = []
    for (const id of childIds) {
      try {
        const context = priorResults.length > 0 ? priorResults.join('\n\n') : undefined
        await this.workTaskById(id, undefined, { priorContext: context })
        // Capture this child's result so later steps (and the accumulator) see it.
        const child = repos.tasks.get(id)
        if (child?.chat_id) {
          const last = [...repos.messages.listByChat(child.chat_id)]
            .reverse()
            .find((m) => m.role === 'assistant')
          if (last?.content) {
            const trimmed =
              last.content.length > CHILD_CONTEXT_CHAR_CAP
                ? last.content.slice(0, CHILD_CONTEXT_CHAR_CAP) + '…'
                : last.content
            priorResults.push(`### ${child.title}\n${trimmed}`)
          }
        }
      } catch (err) {
        console.error('[sunny] delegate: child task failed', id, err)
      }
    }

    // Roll the children's results up into a synthesized answer on the parent.
    try {
      await this.#synthesize(task, manager, childIds, exec)
    } catch (err) {
      console.error('[sunny] delegate: synthesis failed', task.id, err)
      await this.#moveBlocked(task)
    }
  }

  async #decompose(
    task: Task,
    exec: { provider: Provider; model: string; apiKey: string }
  ): Promise<Subtask[]> {
    const messages: ChatTurn[] = [
      { role: 'system', content: DECOMPOSE_SYSTEM },
      {
        role: 'user',
        content:
          `Goal: ${task.title}` +
          (task.description ? `\n\nDetails: ${task.description}` : '') +
          `\n\nReturn JSON exactly: {"subtasks":[{"title":"...","description":"..."}]} ` +
          `with 2-5 subtasks, or {"subtasks":[]} if the goal is already a single atomic task.`
      }
    ]
    const raw = await completeText(exec.provider, {
      apiKey: exec.apiKey,
      model: exec.model,
      messages
    })
    return parseSubtasks(raw)
  }

  async #synthesize(
    task: Task,
    manager: Agent,
    childIds: string[],
    exec: { provider: Provider; model: string; apiKey: string; kind: string }
  ): Promise<void> {
    const { repos } = this.#deps
    const parts: string[] = []
    for (const id of childIds) {
      const child = repos.tasks.get(id)
      if (!child) continue
      let output = '(no result)'
      if (child.chat_id) {
        const last = [...repos.messages.listByChat(child.chat_id)]
          .reverse()
          .find((m) => m.role === 'assistant')
        if (last?.content) output = last.content
      }
      parts.push(`### ${child.title} [${child.status}]\n${output}`)
    }

    const systemParts = [manager.system_prompt?.trim()].filter((s): s is string => Boolean(s))
    systemParts.push(
      'You are the manager synthesizing the results of delegated subtasks into one cohesive, ' +
        'final result for the original goal. Note anything still blocked or incomplete.'
    )
    const messages: ChatTurn[] = [
      { role: 'system', content: systemParts.join('\n\n') },
      {
        role: 'user',
        content:
          `Original goal: ${task.title}` +
          (task.description ? `\n${task.description}` : '') +
          `\n\nSubtask results:\n\n${parts.join('\n\n')}\n\nWrite the final, cohesive result for the goal.`
      }
    ]
    const output = await completeText(exec.provider, {
      apiKey: exec.apiKey,
      model: exec.model,
      messages
    })

    const chat = repos.chats.create({
      title: task.title,
      provider: exec.kind,
      model: exec.model,
      agentId: manager.id,
      projectId: task.project_id ?? undefined
    })
    repos.messages.create({
      chatId: chat.id,
      role: 'user',
      content: `Delegated goal: ${task.title}`
    })
    repos.messages.create({
      chatId: chat.id,
      role: 'assistant',
      content: output || '(no synthesis)',
      provider: exec.kind,
      model: exec.model
    })
    repos.chats.touch(chat.id)
    repos.tasks.setChat(task.id, chat.id)
    repos.tasks.move({ id: task.id, status: 'Done', actor: manager.name })
  }

  // --- the scan loop --------------------------------------------------------
  // `force` bypasses the enabled gate for an explicit user "Run now" click;
  // timer-driven scans never pass it.
  async scan(force = false): Promise<void> {
    if ((!force && !this.#enabled()) || this.#running) return
    this.#running = true
    try {
      // Source from the DB-backed wakeup queue: workable column, not locked by
      // another run, and not parked in the future. This replaces the in-memory
      // status filter so the execution lock (not just the serial #running flag)
      // governs what can be picked up.
      const workable = this.#deps.repos.tasks
        .workableNow(new Date().toISOString())
        .slice(0, MAX_PER_SCAN)
      for (const task of workable) {
        try {
          await this.#work(task)
        } catch (err) {
          console.error('[sunny] task worker: failed on task', task.id, err)
        }
      }
    } finally {
      this.#running = false
      this.#lastScanAt = Date.now()
    }
  }

  // Resolve the agent for a task: its assignee (by name), else the default agent.
  // A paused/terminated agent (governance lifecycle, Phase 4) is skipped — its
  // tasks wait rather than falling back to the default, since the user paused it
  // deliberately; a paused default agent likewise yields no runnable agent.
  #resolveAgent(task: Task): Agent | null {
    const active = (a: Agent | null): Agent | null =>
      a && a.lifecycle_state === 'active' ? a : null
    if (task.assignee) {
      const byName = this.#deps.repos.agents.list().find((a) => a.name === task.assignee)
      if (byName) return active(byName)
    }
    const defaultId = this.#deps.repos.settings.get(DEFAULT_AGENT_SETTING)
    return active(defaultId ? this.#deps.repos.agents.get(defaultId) : null)
  }

  // Explain WHY #resolveAgent returned null, for the feedback an explicit
  // invocation (Work-now / scheduler / re-queue) writes to a Blocked card. The
  // common miss is a paused/terminated assignee (deliberately not falling back
  // to the default); otherwise there's no assignee and no usable default.
  #unresolvedAgentReason(task: Task): string {
    if (task.assignee) {
      const byName = this.#deps.repos.agents.list().find((a) => a.name === task.assignee)
      if (byName && byName.lifecycle_state !== 'active') {
        const state = byName.lifecycle_state === 'paused' ? 'paused' : 'terminated'
        return `Agent '${byName.name}' is ${state} — resume it in Team or reassign the task.`
      }
      if (!byName) return `No agent named '${task.assignee}' — reassign the task.`
    }
    const defaultId = this.#deps.repos.settings.get(DEFAULT_AGENT_SETTING)
    const def = defaultId ? this.#deps.repos.agents.get(defaultId) : null
    if (def && def.lifecycle_state !== 'active') {
      return `The default agent '${def.name}' is paused — resume it in Team or set another default.`
    }
    return 'No agent assigned and no default agent set.'
  }

  // Pick the provider+model: the agent's pinned pair, else the first usable
  // provider (a connected+enabled key provider, then a reachable local Ollama).
  async #resolveModel(agent: Agent): Promise<{ kind: string; model: string } | null> {
    // Honor an agent's pinned provider+model only when that provider is actually
    // usable for an unattended run; otherwise fall back to a working one so a pin
    // to a disconnected provider (e.g. Codex with no stored credential) doesn't
    // hang the run until the timeout.
    if (agent.provider && agent.model && (await this.#providerUsable(agent.provider))) {
      return { kind: agent.provider, model: agent.model }
    }

    // Fallback: first usable key provider, then local Ollama. The pinned model
    // (if any) belongs to the unusable provider, so the fallback uses the chosen
    // provider's own default model, not agent.model.
    for (const provider of this.#deps.registry.list()) {
      if (provider.kind === 'ollama' || provider.kind === 'codex' || provider.kind === 'fake')
        continue
      const row = this.#deps.repos.providers.getByKind(provider.kind)
      const enabled = row ? row.enabled === 1 : true
      if (enabled && row?.secret_ref) {
        return { kind: provider.kind, model: provider.defaultModel }
      }
    }

    // Local Ollama fallback (keyless) — important for fully-local setups.
    const ollamaRow = this.#deps.repos.providers.getByKind('ollama')
    if (!ollamaRow || ollamaRow.enabled === 1) {
      const base = this.#deps.repos.settings.get('ollama_base_url') ?? OLLAMA_DEFAULT_BASE_URL
      if (await ollamaReachable(base)) {
        const models = await ollamaChatModels(base)
        if (models.length > 0) return { kind: 'ollama', model: models[0].id }
      }
    }
    return null
  }

  /**
   * Whether a provider is dependable for an UNATTENDED run: local Ollama when
   * reachable, otherwise a provider Sunny can resolve a stored credential for
   * (enabled + secret_ref). Codex stores no secret in Sunny — its OAuth lives in
   * the Codex CLI and can hang a headless turn — so a Codex-pinned agent falls
   * back here rather than risk wedging until the timeout. (Interactive "Work this
   * task" runs in a chat and is unaffected — only the worker uses this.)
   */
  async #providerUsable(kind: string): Promise<boolean> {
    if (kind === 'fake') return true
    if (kind === 'ollama') {
      const base = this.#deps.repos.settings.get('ollama_base_url') ?? OLLAMA_DEFAULT_BASE_URL
      return ollamaReachable(base)
    }
    if (kind === 'opencode') {
      // Local opencode server: usable unattended when reachable (it owns its own
      // auth, so this is how a ChatGPT subscription becomes headless-usable).
      const base = this.#deps.repos.settings.get('opencode_base_url') ?? OPENCODE_DEFAULT_BASE_URL
      const password = this.#deps.repos.settings.get('opencode_password') ?? ''
      return opencodeReachable(base, password)
    }
    const row = this.#deps.repos.providers.getByKind(kind)
    return Boolean(row && row.enabled === 1 && row.secret_ref)
  }

  async #moveBlocked(task: Task, note?: string): Promise<void> {
    if (task.status !== 'Blocked') {
      this.#deps.repos.tasks.move({ id: task.id, status: 'Blocked', actor: 'worker', note })
    }
  }

  async #work(
    task: Task,
    modelOverride?: { provider: string; model: string },
    opts?: { explicit?: boolean; priorContext?: string }
  ): Promise<void> {
    const { repos, registry, secretStore, memory } = this.#deps

    const agent = this.#resolveAgent(task)
    if (!agent) {
      // A scan sweeps unassigned backlog and must skip silently. An EXPLICIT
      // invocation (Work-now / scheduler / re-queue) came from a user action, so
      // write feedback naming the cause instead of a mystery no-op.
      if (opts?.explicit) {
        const reason = this.#unresolvedAgentReason(task)
        await this.#moveBlocked(task, reason)
        repos.activity.record({
          kind: 'run.failed',
          actor: 'worker',
          taskId: task.id,
          goalId: task.goal_id,
          projectId: task.project_id,
          payload: { summary: `Can't work “${task.title}”: ${reason}` }
        })
        this.#deps.notify?.({ title: 'Sunny — task blocked', body: `“${task.title}”: ${reason}` })
      }
      return // no assignee + no default → leave in backlog for the user
    }

    // BUDGET GATE (pre-run, before any provider call): when a monthly cap is
    // set and month-to-date estimated spend has reached it, park instead of
    // spending. The task un-parks by raising the cap (or next month) and
    // re-queuing — autonomy must have an economic ceiling.
    const budgetRaw = Number(repos.settings.get(BUDGET_SETTING))
    if (Number.isFinite(budgetRaw) && budgetRaw > 0) {
      const spend = repos.runs.monthSpend(monthStartIso())
      if (spend.usd >= budgetRaw) {
        const reason = `Monthly budget reached ($${spend.usd.toFixed(2)} of $${budgetRaw.toFixed(2)}) — raise it in Settings → Budget & spend to resume autonomous work.`
        await this.#moveBlocked(task, reason)
        repos.activity.record({
          kind: 'run.failed',
          actor: 'worker',
          taskId: task.id,
          goalId: task.goal_id,
          projectId: task.project_id,
          payload: { summary: `Budget gate parked “${task.title}”: ${reason}` }
        })
        this.#deps.notify?.({ title: 'Sunny — budget reached', body: reason })
        return
      }
    }

    // An explicit model override (from a schedule) is authoritative: use it
    // directly with no fallback, so a missing key surfaces as a clear blocked
    // reason naming that provider rather than silently swapping to another.
    const resolved = modelOverride
      ? { kind: modelOverride.provider, model: modelOverride.model }
      : await this.#resolveModel(agent)
    if (!resolved) {
      await this.#moveBlocked(
        task,
        'No usable provider/model — connect a provider with an API key, sign in to one, or start Ollama.'
      )
      return
    }
    const provider = registry.get(resolved.kind)
    if (!provider) {
      await this.#moveBlocked(task, `Provider "${resolved.kind}" is not available.`)
      return
    }
    const bearer = await resolveBearer(resolved.kind, { providers: repos.providers, secretStore })
    if ('error' in bearer) {
      await this.#moveBlocked(task, `${resolved.kind}: ${bearer.error}`)
      return
    }

    // When the agent's `web_access` is on, it searches the web on its own model.
    const webSearch = agent.web_access === 1

    const exec = {
      kind: resolved.kind,
      model: resolved.model,
      provider,
      apiKey: bearer.apiKey
    }

    // Open an execution record, then atomically claim the task WITH that run's
    // id. checkout only succeeds when the task is unlocked, so a re-entrant scan
    // or an overlapping delegate() can never double-work it — the loser gets
    // null here and we cancel its just-opened run. (The run row is also the cost
    // anchor and what `tasks.locked_by` points at.)
    const run = repos.runs.create({
      agentId: agent.id,
      taskId: task.id,
      projectId: task.project_id,
      goalId: task.goal_id,
      provider: exec.kind,
      model: exec.model,
      input: task.title
    })
    const claimed = repos.tasks.checkout(task.id, run.id, agent.name)
    if (!claimed) {
      repos.runs.finish(run.id, { status: 'cancelled', error: 'Task already claimed.' })
      return
    }
    // A claimed task's pending wake (retry backoff) is consumed by this run.
    repos.tasks.setWake(task.id, null)
    repos.activity.record({
      kind: 'run.started',
      actor: agent.name,
      agentId: agent.id,
      taskId: task.id,
      goalId: task.goal_id,
      projectId: task.project_id,
      runId: run.id,
      payload: { summary: `${agent.name} started “${task.title}” · ${exec.kind}/${exec.model}` }
    })

    // Build the agent's fs/shell toolset for this unattended run. The workspace
    // comes from the `agent_workspace` setting (unset → registry drops fs/shell
    // tools). With no human present, a GATED action — an Ask agent's side effects,
    // or an Autopilot agent's DESTRUCTIVE ones — becomes an APPROVAL: the gate
    // records a pending approval and denies the action this run; once the user
    // approves it in /approvals the task re-queues and the agent proceeds. A gate
    // already approved returns true so the action runs; rejected stays denied.
    // (Plan-mode side effects are still refused outright by the registry.)
    const allowed = new Set(parseAllowedTools(agent.allowed_tools))
    // Gates this run asked for but was denied (request/wait). At end-of-run we
    // re-read their status to decide park vs re-queue vs stay-blocked, so a
    // mid-run approval is applied instead of the task being marked Done.
    const deniedGates = new Set<string>()
    const approvalConfirm: ConfirmFn = async (req) => {
      // Scope the gate to the SPECIFIC action (tool + detail digest) so approving
      // one command never blanket-allows a different one (see approval-policy).
      const gate = approvalGateKey(req.tool, req.detail)
      const latest = repos.approvals.latestForGate(task.id, gate)
      const outcome = approvalGateOutcome(latest)
      if (outcome === 'request') {
        repos.approvals.request({
          taskId: task.id,
          runId: run.id,
          agentId: agent.id,
          gate,
          title: req.title,
          detail: req.detail
        })
        repos.activity.record({
          kind: 'approval.requested',
          actor: agent.name,
          agentId: agent.id,
          taskId: task.id,
          goalId: task.goal_id,
          projectId: task.project_id,
          runId: run.id,
          payload: {
            summary: `${agent.name} needs approval to ${req.detail} for “${task.title}”`,
            gate
          }
        })
        this.#deps.notify?.({
          title: 'Sunny — approval needed',
          body: `${agent.name} wants to ${req.detail} for “${task.title}”. Review it in Approvals.`
        })
      }
      if (outcome === 'request' || outcome === 'wait') deniedGates.add(gate)
      // Consume an approval on use: a single-use grant, so the NEXT time this
      // exact action comes up it re-asks (and a different command was never
      // covered by this approval in the first place).
      if (outcome === 'allow' && latest) repos.approvals.markExpired(latest.id)
      return outcomeAllows(outcome)
    }
    const agentTools =
      allowed.size > 0
        ? buildAgentToolset({
            workspace: repos.settings.get('agent_workspace') ?? undefined,
            mode: agent.permission_mode,
            allowed,
            confirm: approvalConfirm,
            generatedDir: this.#deps.generatedDir,
            // Board tools (create/inspect/update tasks) — lets a manager agent
            // run its own work queue, through the same permission gate.
            board: { tasks: repos.tasks, dependencies: repos.taskDependencies },
            actorName: agent.name,
            // External MCP tools (agent opts in via the mcp_tools sentinel).
            mcp: this.#deps.mcp
          })
        : undefined

    // Working chat: RESUME the prior run's conversation when the task has one
    // (context_ref) — a retry, approval re-queue, or reopened card continues
    // where it left off instead of re-deriving everything from scratch. First
    // run creates the chat and pins it as the task's durable working context.
    const priorChat = task.context_ref ? repos.chats.get(task.context_ref) : null
    const resuming = priorChat != null
    const chat =
      priorChat ??
      repos.chats.create({
        title: task.title,
        provider: exec.kind,
        model: exec.model,
        agentId: agent.id
      })
    if (!resuming) {
      repos.tasks.setChat(task.id, chat.id)
      repos.tasks.setContextRef(task.id, chat.id)
    }

    // System context: agent persona + standing instructions + goal ancestry
    // (the "why") + relevant memory.
    const systemParts: string[] = []
    if (agent.system_prompt?.trim()) systemParts.push(agent.system_prompt.trim())
    const standing = repos.settings.get('standing_instructions')
    if (standing?.trim()) systemParts.push(standing.trim())
    // Providers without function calling (codex/opencode) silently drop agent
    // tools and non-native web in streamTurn — tell the model so it explains
    // what it WOULD do instead of pretending it acted, and the transcript shows
    // the user why nothing executed (mirrors the interactive chat path's note).
    if (!provider.streamWithTools && (allowed.size > 0 || (webSearch && !provider.supportsWebSearch))) {
      systemParts.push(
        `Note: your file/command tools${webSearch ? ' and web access' : ''} are NOT available ` +
          `on the current provider/model (${exec.kind}). Describe the steps you would take ` +
          'instead of claiming to perform them, or note that a tool-capable model is needed.'
      )
    }
    // The iterative loop's contract: the agent self-reports done/continue/blocked.
    systemParts.push(STATUS_INSTRUCTIONS)
    if (resuming) {
      systemParts.push(
        'You are RESUMING this task — your prior work is in the conversation above. Build on ' +
          'it; do not start over. If an action previously required approval, a decision has ' +
          'been made since: retry the action now rather than asking again.'
      )
    }
    // Inject the goal chain so the agent knows not just WHAT to do but WHY.
    if (task.goal_id) {
      try {
        const chain = repos.goals.ancestry(task.goal_id)
        if (chain.length > 0) {
          const why = chain
            .map((g, i) => `${'  '.repeat(i)}- ${g.title}${g.description ? `: ${g.description}` : ''}`)
            .join('\n')
          systemParts.push(
            `This task serves the following goal (top-level objective first):\n${why}\n\n` +
              'Keep your work aligned with the most specific goal above.'
          )
        }
      } catch {
        // goal ancestry is best-effort context
      }
    }
    try {
      const { text } = await memory.retrieveContext({
        query: `${task.title} ${task.description ?? ''}`,
        projectId: task.project_id ?? undefined
      })
      if (text) {
        systemParts.push(
          'Background memory (context only, from past conversations — use only if relevant ' +
            'to the task below):\n' +
            text
        )
      }
    } catch {
      // memory recall is optional
    }

    const prompt = resuming
      ? `Resume the task "${task.title}" and finish it.` +
        (task.description ? `\n\nTask details: ${task.description}` : '') +
        `\n\nYour prior work is above — continue from where it left off.`
      : `Work this task and produce the result directly.\n\nTitle: ${task.title}` +
        (task.description ? `\n\nDetails: ${task.description}` : '') +
        (opts?.priorContext
          ? `\n\nResults from earlier steps of this plan — use these as your inputs ` +
            `(do NOT ask for what is already provided here):\n\n${opts.priorContext}`
          : '') +
        `\n\nComplete it as far as you can right now. If you are blocked or need tools, files, ` +
        `or input you don't have access to, say exactly what is blocking you.`

    // A resumed run replays the prior conversation (newest-first char cap) so
    // the model builds on its earlier work instead of re-deriving it.
    const history: ChatTurn[] = resuming
      ? capChatHistory(
          repos.messages
            .listByChat(chat.id)
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        )
      : []

    const messages: ChatTurn[] = []
    if (systemParts.length > 0) messages.push({ role: 'system', content: systemParts.join('\n\n') })
    messages.push(...history)
    messages.push({ role: 'user', content: prompt })

    repos.messages.create({ chatId: chat.id, role: 'user', content: prompt })

    // Fresh AbortController per run so stop()/disable can cancel this task, plus
    // a wall-clock timeout that aborts a run that overruns WORK_TIMEOUT_MS. When
    // the signal fires, the completeText stream throws and the catch below moves
    // the card to Blocked with a clear reason.
    const controller = new AbortController()
    this.#aborts.add(controller)
    let timedOut = false
    let stalled = false
    // Token usage reported by the provider (null until it arrives) — written
    // onto the run row so cost accounting has real numbers. Read through the
    // closures below (TS can't see the onUsage assignment from this scope).
    let usage: { promptTokens: number; completionTokens: number } | null = null
    const usageInfo = (): { promptTokens: number; completionTokens: number } | null => usage
    const tokens = (): {
      promptTokens?: number
      completionTokens?: number
      costUsd?: number
    } => {
      const u = usageInfo()
      if (!u) return {}
      const costUsd = estimateCostUsd(exec.kind, exec.model, u.promptTokens, u.completionTokens)
      return {
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        ...(costUsd !== null ? { costUsd } : {})
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, WORK_TIMEOUT_MS)

    try {
      // THE ITERATIVE AGENT LOOP (0.5.0). A run is no longer one LLM call: the
      // agent works in up to MAX_AGENT_TURNS turns, self-reporting via a STATUS
      // marker; a DONE claim gets a verification pass whose critique feeds a
      // rework turn. `completeText` routes web search + agent tools per turn
      // exactly as before (native web vs Sunny's tools; fs/shell gated by the
      // permission mode + approval gates).
      const runTurn = (turnMessages: ChatTurn[]): Promise<string> =>
        completeText(exec.provider, {
          apiKey: exec.apiKey,
          model: exec.model,
          messages: turnMessages,
          signal: controller.signal,
          webSearch,
          agentTools,
          maxToolRounds: WORKER_MAX_TOOL_ROUNDS,
          // Fail a silent stream fast — the retry policy treats a stall as
          // transient, so the task re-queues with backoff instead of burning
          // the whole run budget and parking.
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
          onIdleTimeout: () => {
            stalled = true
            controller.abort()
          },
          // Accumulate across turns (each turn reports its own usage).
          onUsage: (u) => {
            usage = usage
              ? {
                  promptTokens: usage.promptTokens + u.promptTokens,
                  completionTokens: usage.completionTokens + u.completionTokens
                }
              : u
          },
          // Durable audit trail: every tool execution lands in the activity
          // log so an unattended run's actions are reviewable after the fact.
          onToolEvent: (e) => {
            try {
              repos.activity.record({
                kind: 'tool.executed',
                actor: agent.name,
                agentId: agent.id,
                taskId: task.id,
                goalId: task.goal_id,
                projectId: task.project_id,
                runId: run.id,
                payload: {
                  summary: `${agent.name} ran ${e.name} (${e.ok ? 'ok' : 'FAILED'}, ${e.durationMs} ms)`,
                  tool: e.name,
                  args: e.args,
                  result: e.resultPreview,
                  ok: e.ok,
                  durationMs: e.durationMs
                }
              })
            } catch (err) {
              console.error('[sunny] tool audit record failed', err)
            }
          }
        })

      const verificationEnabled = repos.settings.get(VERIFICATION_SETTING) !== 'off'
      let output = ''
      let agentBlockedReason: string | null = null
      let verificationNote: string | null = null
      let turnsUsed = 0
      // The final turn's reply is persisted AFTER the loop (with artifacts);
      // intermediate turns persist as they complete so the chat reads naturally.
      let pendingAssistant = ''

      for (let turn = 1; turn <= MAX_AGENT_TURNS; turn++) {
        turnsUsed = turn
        const raw = await runTurn(messages)
        const parsed = parseStatusMarker(raw)
        output = parsed.cleaned || '(no output)'
        pendingAssistant = output
        messages.push({ role: 'assistant', content: raw })

        // A denied approval gate means the agent cannot act further this run —
        // stop looping; the post-loop disposition parks/re-queues it.
        if (deniedGates.size > 0) break

        if (parsed.status === 'blocked') {
          agentBlockedReason = parsed.reason || 'The agent reported it is blocked.'
          break
        }

        if (parsed.status === 'continue') {
          if (turn === MAX_AGENT_TURNS) break // out of turns — keep what we have
          const nudge = buildContinuePrompt()
          repos.messages.create({
            chatId: chat.id,
            role: 'assistant',
            content: output,
            provider: exec.kind,
            model: exec.model
          })
          repos.messages.create({ chatId: chat.id, role: 'user', content: nudge })
          messages.push({ role: 'user', content: nudge })
          pendingAssistant = ''
          continue
        }

        // status === 'done' → verification pass (one cheap extra call): a
        // strict reviewer judges whether the result actually accomplishes the
        // task; a FAIL critique feeds a rework turn. Best-effort — reviewer
        // errors and missing verdicts count as PASS so a weak model can never
        // trap a finished task in a rework loop.
        if (!verificationEnabled) break
        let verdict = { pass: true, critique: '' }
        try {
          const review = await completeText(exec.provider, {
            apiKey: exec.apiKey,
            model: exec.model,
            messages: [
              { role: 'system', content: VERIFICATION_SYSTEM },
              {
                role: 'user',
                content: buildVerificationPrompt(task.title, task.description, output)
              }
            ],
            signal: controller.signal,
            idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
            onIdleTimeout: () => {
              stalled = true
              controller.abort()
            },
            // Verification calls spend tokens too — count them.
            onUsage: (u) => {
              usage = usage
                ? {
                    promptTokens: usage.promptTokens + u.promptTokens,
                    completionTokens: usage.completionTokens + u.completionTokens
                  }
                : u
            }
          })
          verdict = parseVerdict(review)
        } catch (err) {
          // Aborts must still propagate to the outer catch (timeout/stop).
          if (controller.signal.aborted) throw err
        }
        if (verdict.pass) break
        if (turn === MAX_AGENT_TURNS) {
          verificationNote = verdict.critique || 'Reviewer flagged the result as incomplete.'
          break
        }
        const rework = buildReworkPrompt(verdict.critique)
        repos.messages.create({
          chatId: chat.id,
          role: 'assistant',
          content: output,
          provider: exec.kind,
          model: exec.model
        })
        repos.messages.create({ chatId: chat.id, role: 'user', content: rework })
        messages.push({ role: 'user', content: rework })
        pendingAssistant = ''
      }

      // Persist the final turn's reply, carrying any files the agent generated
      // across the whole run.
      const artifacts = agentTools?.artifacts ?? []
      repos.messages.create({
        chatId: chat.id,
        role: 'assistant',
        content: pendingAssistant || output || '(no output)',
        provider: exec.kind,
        model: exec.model,
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
      repos.chats.touch(chat.id)

      // This run may have hit approval gates. Decide the task's fate from the
      // CURRENT status of each gate it was denied on — the user may have decided
      // one MID-RUN (the run keeps executing for up to 5 min after recording a
      // gate), so we must not blindly mark Done:
      //   park     → still pending: wait in Blocked for the decision.
      //   requeue  → approved mid-run: re-run to apply it (the re-run's gate
      //              consumes the single-use approval).
      //   rejected → decided against: stay Blocked with the rejection note.
      //   done     → no gate was denied: the normal success path.
      const deniedApprovals = [...deniedGates]
        .map((g) => repos.approvals.latestForGate(task.id, g))
        .filter((a): a is Approval => Boolean(a))
      const disposition = postRunDisposition(
        deniedApprovals.map((a) => a.status as ApprovalStatus)
      )

      if (disposition === 'park') {
        repos.runs.finish(run.id, { status: 'blocked', output: output || '(no output)', ...tokens() })
        repos.tasks.releaseLock(task.id, run.id)
        await this.#moveBlocked(
          task,
          '⏳ Waiting for your approval to proceed — review it in Approvals.'
        )
        repos.activity.record({
          kind: 'task.awaiting_approval',
          actor: agent.name,
          agentId: agent.id,
          taskId: task.id,
          goalId: task.goal_id,
          projectId: task.project_id,
          runId: run.id,
          payload: { summary: `${agent.name} is waiting for approval on “${task.title}”` }
        })
        return
      }

      if (disposition === 'requeue') {
        // The user approved a gate while this run was still executing (so its own
        // denied action never happened). Finish this run and re-queue the task;
        // the re-run consumes the approval and applies the action.
        repos.runs.finish(run.id, { status: 'blocked', output: output || '(no output)', ...tokens() })
        repos.tasks.releaseLock(task.id, run.id)
        repos.tasks.move({
          id: task.id,
          status: 'Planned',
          actor: agent.name,
          note: 'Approved mid-run — re-running to apply it.'
        })
        void this.workTaskById(task.id)
        return
      }

      if (disposition === 'rejected') {
        const rejected = deniedApprovals.find((a) => a.status === 'rejected')
        const note = rejected ? `Approval rejected: ${rejected.title}` : 'Approval rejected.'
        repos.runs.finish(run.id, { status: 'blocked', output: output || '(no output)', ...tokens() })
        repos.tasks.releaseLock(task.id, run.id)
        await this.#moveBlocked(task, note)
        return
      }

      // The agent itself reported STATUS: BLOCKED — park with its reason so the
      // card says exactly what it needs (previously a "blocked" reply was
      // silently marked Done).
      if (agentBlockedReason) {
        const note = `Agent reports blocked: ${agentBlockedReason}`
        repos.runs.finish(run.id, { status: 'blocked', output: output || '(no output)', ...tokens() })
        repos.tasks.releaseLock(task.id, run.id)
        await this.#moveBlocked(task, note)
        repos.activity.record({
          kind: 'run.failed',
          actor: agent.name,
          agentId: agent.id,
          taskId: task.id,
          goalId: task.goal_id,
          projectId: task.project_id,
          runId: run.id,
          payload: {
            summary: `${agent.name} blocked on “${task.title}”: ${agentBlockedReason}`,
            chatId: chat.id
          }
        })
        this.#deps.notify?.({
          title: 'Sunny — task blocked',
          body: `“${task.title}”: ${agentBlockedReason}`
        })
        return
      }

      // Close the run, release the lock, and advance the card. The user reviews
      // the linked chat and can reopen the card if the agent reported a block.
      repos.runs.finish(run.id, { status: 'succeeded', output: output || '(no output)', ...tokens() })
      repos.tasks.releaseLock(task.id, run.id)
      repos.tasks.move({ id: task.id, status: 'Done', actor: agent.name })
      repos.activity.record({
        kind: 'run.finished',
        actor: agent.name,
        agentId: agent.id,
        taskId: task.id,
        goalId: task.goal_id,
        projectId: task.project_id,
        runId: run.id,
        // chatId lets the review feed open the agent's output for this task.
        payload: {
          summary:
            `${agent.name} finished “${task.title}”` +
            (turnsUsed > 1 ? ` · ${turnsUsed} turns` : '') +
            (usageInfo()
              ? ` · ${usageInfo()!.promptTokens.toLocaleString()} in / ${usageInfo()!.completionTokens.toLocaleString()} out tokens`
              : '') +
            (verificationNote ? ` · reviewer note: ${verificationNote}` : ''),
          chatId: chat.id
        }
      })
      this.#deps.notify?.({
        title: 'Sunny — task finished',
        body: `${agent.name} finished “${task.title}”. Review the result on the board.`
      })

      // Close the learning loop: autonomous runs contribute to memory like
      // interactive chats do (fire-and-forget; capture never throws). Without
      // this, only human chats grow the memory graph and unattended work
      // teaches the system nothing.
      if (memory.autoEnabled() && output) {
        void memory.capture({
          chatId: chat.id,
          userText: prompt,
          assistantText: output,
          projectId: task.project_id ?? undefined,
          generate: (msgs) =>
            completeText(exec.provider, { apiKey: exec.apiKey, model: exec.model, messages: msgs })
        })
      }
    } catch (err) {
      // Name the provider/model so a blocked card is self-explanatory instead of
      // a mystery (the cause is almost always a slow/unavailable provider here).
      const where = `${exec.kind}/${exec.model}`
      const reason = stalled
        ? `Stream stalled — no output for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s on ${where}; the provider connection likely hung.`
        : timedOut
          ? `Timed out after ${Math.round(WORK_TIMEOUT_MS / 60_000)} minutes on ${where} — the provider/model may be unavailable, rate-limited, or too slow for an unattended run.`
          : `Run failed on ${where}: ${err instanceof Error ? err.message : 'Agent run failed'}`
      repos.messages.create({
        chatId: chat.id,
        role: 'assistant',
        content: `⚠️ ${reason}`,
        provider: exec.kind,
        model: exec.model
      })
      repos.chats.touch(chat.id)
      repos.runs.finish(run.id, { status: 'failed', error: reason, ...tokens() })
      repos.tasks.releaseLock(task.id, run.id)

      // Retry policy: a TRANSIENT provider failure (timeout, network, 429, 5xx)
      // under the attempt cap re-queues the task with a backoff wake instead of
      // permanently parking it — one flaky API moment must not require a human.
      // Permanent failures (auth, bad model, user abort) and exhausted streaks
      // park Blocked exactly as before. The failure streak is counted from run
      // rows (this run's 'failed' row is already written, so it's included).
      const failures = repos.runs.consecutiveFailures(task.id)
      // A stall is the worker's own abort, same as the wall-clock timeout —
      // both mean "provider hung", which is transient by definition.
      const decision = retryDecision(reason, timedOut || stalled, failures)
      if (decision.retry) {
        const wakeAt = new Date(Date.now() + decision.delayMs).toISOString()
        repos.tasks.setWake(task.id, wakeAt)
        repos.tasks.move({
          id: task.id,
          status: 'Planned',
          actor: 'worker',
          note: `Transient failure — retrying in ~${Math.round(decision.delayMs / 60_000)} min (attempt ${failures}/${MAX_RUN_ATTEMPTS}). ${reason}`
        })
        // Fire the retry directly (like Work-now) so it happens even when the
        // heartbeat is off; wake_at stays as the durable fallback if the app
        // quits first. A concurrent scan pickup is harmless — checkout is atomic.
        this.#scheduleRetry(task.id, decision.delayMs)
      } else {
        const parked =
          failures >= MAX_RUN_ATTEMPTS && decision.kind === 'transient'
            ? `${reason} (gave up after ${failures} attempts)`
            : reason
        await this.#moveBlocked(task, parked)
        this.#deps.notify?.({
          title: 'Sunny — task blocked',
          body: `“${task.title}”: ${parked}`
        })
      }
      repos.activity.record({
        kind: 'run.failed',
        actor: agent.name,
        agentId: agent.id,
        taskId: task.id,
        goalId: task.goal_id,
        projectId: task.project_id,
        runId: run.id,
        payload: {
          summary: decision.retry
            ? `${agent.name} hit a transient failure on “${task.title}” — retry ${failures}/${MAX_RUN_ATTEMPTS} scheduled: ${reason}`
            : `${agent.name} blocked on “${task.title}”: ${reason}`,
          chatId: chat.id
        }
      })
    } finally {
      clearTimeout(timer)
      this.#aborts.delete(controller)
    }
  }
}
