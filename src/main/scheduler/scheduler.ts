import type { Repositories } from '@main/repositories'
import type { TaskWorker } from '@main/worker/task-worker'
import type { Schedule } from '@shared/db/types'
import { nextRunIso } from './cadence'

// The scheduler (spec §7). A lightweight tick loop checks for ENABLED schedules
// whose next_run_at has arrived and fires each one: it creates a board task
// (scoped to the schedule's project, assigned to its agent) and runs it
// immediately through the TaskWorker — so a scheduled run produces a visible card
// + linked chat and works even when the periodic auto-scan worker is disabled.
//
// Unlike the worker there's no global on/off: the tick always runs (it's a cheap
// indexed query), and each schedule's own `enabled` flag gates whether it fires.
// next_run_at is advanced BEFORE the (awaited) run so a long run can't double-fire
// on the next tick.

const TICK_MS = 60_000
// Circuit breaker: after this many CONSECUTIVE firings whose task ended Blocked,
// the schedule is auto-disabled — a broken recurring schedule must not silently
// spawn a new failing card every interval forever. A Done firing resets the
// streak; re-enabling the schedule in the UI is the manual reset.
const MAX_CONSECUTIVE_FAILURES = 3

interface SchedulePayload {
  prompt?: string
  /** Optional model override (provider kind + model id) for this schedule's runs. */
  provider?: string | null
  model?: string | null
}

function parsePayload(json: string | null): SchedulePayload {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as SchedulePayload) : {}
  } catch {
    return {}
  }
}

export interface SchedulerDeps {
  repos: Repositories
  worker: TaskWorker
  /** OS-level notification hook (injected; keeps this module electron-free). */
  notify?: (n: { title: string; body: string }) => void
}

export class Scheduler {
  readonly #deps: SchedulerDeps
  #timer: ReturnType<typeof setInterval> | null = null
  #ticking = false

  constructor(deps: SchedulerDeps) {
    this.#deps = deps
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    // A short initial delay so a just-due schedule fires soon after boot.
    setTimeout(() => void this.tick(), 5000)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  // Fire every due+enabled schedule. Serial + guarded so ticks never overlap.
  async tick(): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const due = this.#deps.repos.schedules.due(new Date().toISOString())
      for (const schedule of due) {
        try {
          await this.#fire(schedule)
        } catch (err) {
          console.error('[sunny] scheduler: failed to fire schedule', schedule.id, err)
        }
      }
    } finally {
      this.#ticking = false
    }
  }

  // Run a schedule now regardless of next_run_at (the UI "Run now" button), even
  // if it's disabled. Throws if the id is unknown so the IPC caller can surface it.
  async runNow(id: string): Promise<void> {
    const schedule = this.#deps.repos.schedules.get(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    await this.#fire(schedule)
  }

  async #fire(schedule: Schedule): Promise<void> {
    const { repos, worker } = this.#deps
    const agent = schedule.agent_id ? repos.agents.get(schedule.agent_id) : null
    const { prompt, provider, model } = parsePayload(schedule.payload)
    // An explicit model override (set on the schedule) wins over the agent's
    // pinned/fallback model — so a scheduled run uses exactly what you chose.
    const override = provider && model ? { provider, model } : undefined

    // Create the task FIRST, then advance the schedule's clock, then work it. The
    // clock advance happens before the awaited run so the next tick won't re-fire.
    const task = repos.tasks.create({
      title: schedule.name,
      description: prompt && prompt.trim() ? prompt.trim() : undefined,
      status: 'Planned',
      projectId: schedule.project_id ?? undefined,
      assignee: agent?.name ?? undefined
    })

    const now = Date.now()
    repos.schedules.markRun(
      schedule.id,
      new Date(now).toISOString(),
      schedule.cron ? nextRunIso(schedule.cron, now) : null
    )

    await worker.workTaskById(task.id, override)

    // Circuit breaker: judge this firing by where the task landed. Blocked =
    // failed; Done = success (streak resets); anything else (Planned = the
    // worker scheduled a transient-failure retry, In Progress = still running)
    // is neutral — no counter change. After MAX_CONSECUTIVE_FAILURES failures
    // in a row the schedule auto-disables instead of spawning failing cards
    // every interval forever.
    try {
      const landed = repos.tasks.get(task.id)
      if (landed?.status === 'Blocked') {
        const streak = repos.schedules.recordOutcome(schedule.id, true)
        if (streak >= MAX_CONSECUTIVE_FAILURES) {
          repos.schedules.update({ id: schedule.id, enabled: false })
          repos.activity.record({
            kind: 'schedule.disabled',
            actor: 'scheduler',
            taskId: task.id,
            projectId: schedule.project_id,
            payload: {
              summary: `Schedule “${schedule.name}” disabled after ${streak} consecutive failures — fix it and re-enable in Schedules.`
            }
          })
          this.#deps.notify?.({
            title: 'Sunny — schedule disabled',
            body: `“${schedule.name}” failed ${streak} times in a row and was turned off. Fix it and re-enable in Schedules.`
          })
        }
      } else if (landed?.status === 'Done') {
        repos.schedules.recordOutcome(schedule.id, false)
      }
    } catch (err) {
      console.error('[sunny] scheduler: outcome bookkeeping failed', schedule.id, err)
    }
  }
}
