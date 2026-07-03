import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Schedule } from '@shared/db/types'

// Repository for `schedules` rows (spec §7 scheduler). A schedule runs an agent
// on a goal at a cadence. `cron` holds a cadence preset keyword (see
// scheduler/cadence.ts); `payload` is JSON (e.g. {prompt}); `next_run_at` is the
// ISO time the runtime should next fire it. agent_id/project_id are ON DELETE
// SET NULL. DB type imported type-only so the native binding never loads here.

export interface ScheduleCreateInput {
  id?: string
  name: string
  cron: string
  agentId?: string | null
  projectId?: string | null
  payload?: string | null
  enabled?: boolean
  nextRunAt?: string | null
}

export interface ScheduleUpdateInput {
  id: string
  name?: string
  cron?: string
  agentId?: string | null
  projectId?: string | null
  payload?: string | null
  enabled?: boolean
  nextRunAt?: string | null
}

export class SchedulesRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly getStmt
  private readonly listStmt
  private readonly dueStmt
  private readonly updateStmt
  private readonly markRunStmt
  private readonly deleteStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.insertStmt = db.prepare(
      `INSERT INTO schedules
         (id, name, cron, agent_id, project_id, payload, enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES
         (@id, @name, @cron, @agent_id, @project_id, @payload, @enabled, @last_run_at, @next_run_at, @created_at, @updated_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM schedules WHERE id = ?`)
    this.listStmt = db.prepare(
      `SELECT * FROM schedules ORDER BY enabled DESC, next_run_at IS NULL, next_run_at ASC, created_at ASC`
    )
    // Enabled schedules whose next_run_at has arrived (ISO strings compare in
    // time order). Null next_run_at never auto-fires (manual "Run now" only).
    this.dueStmt = db.prepare(
      `SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`
    )
    this.updateStmt = db.prepare(
      `UPDATE schedules SET name = @name, cron = @cron, agent_id = @agent_id,
         project_id = @project_id, payload = @payload, enabled = @enabled,
         next_run_at = @next_run_at, updated_at = @updated_at
       WHERE id = @id`
    )
    this.markRunStmt = db.prepare(
      `UPDATE schedules SET last_run_at = @last_run_at, next_run_at = @next_run_at,
         updated_at = @updated_at WHERE id = @id`
    )
    this.deleteStmt = db.prepare(`DELETE FROM schedules WHERE id = ?`)
  }

  list(): Schedule[] {
    return this.listStmt.all() as Schedule[]
  }

  get(id: string): Schedule | null {
    return (this.getStmt.get(id) as Schedule | undefined) ?? null
  }

  due(nowIso: string): Schedule[] {
    return this.dueStmt.all(nowIso) as Schedule[]
  }

  create(input: ScheduleCreateInput): Schedule {
    const now = new Date().toISOString()
    const row: Schedule = {
      id: input.id ?? randomUUID(),
      name: input.name,
      cron: input.cron,
      agent_id: input.agentId ?? null,
      project_id: input.projectId ?? null,
      payload: input.payload ?? null,
      enabled: input.enabled === false ? 0 : 1,
      last_run_at: null,
      next_run_at: input.nextRunAt ?? null,
      consecutive_failures: 0,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  update(input: ScheduleUpdateInput): Schedule {
    const existing = this.getStmt.get(input.id) as Schedule | undefined
    if (!existing) throw new Error(`Schedule not found: ${input.id}`)
    const row: Schedule = {
      ...existing,
      name: input.name ?? existing.name,
      cron: input.cron ?? existing.cron,
      agent_id: input.agentId === undefined ? existing.agent_id : input.agentId,
      project_id: input.projectId === undefined ? existing.project_id : input.projectId,
      payload: input.payload === undefined ? existing.payload : input.payload,
      enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      next_run_at: input.nextRunAt === undefined ? existing.next_run_at : input.nextRunAt,
      updated_at: new Date().toISOString()
    }
    this.updateStmt.run({
      id: row.id,
      name: row.name,
      cron: row.cron,
      agent_id: row.agent_id,
      project_id: row.project_id,
      payload: row.payload,
      enabled: row.enabled,
      next_run_at: row.next_run_at,
      updated_at: row.updated_at
    })
    return row
  }

  markRun(id: string, lastRunAt: string, nextRunAt: string | null): void {
    this.markRunStmt.run({
      id,
      last_run_at: lastRunAt,
      next_run_at: nextRunAt,
      updated_at: new Date().toISOString()
    })
  }

  // Record a firing's outcome for the circuit breaker: a failure extends the
  // streak, a success resets it. Returns the new streak length.
  recordOutcome(id: string, failed: boolean): number {
    if (failed) {
      this.db
        .prepare(
          `UPDATE schedules SET consecutive_failures = consecutive_failures + 1, updated_at = @now
           WHERE id = @id`
        )
        .run({ id, now: new Date().toISOString() })
    } else {
      this.db
        .prepare(
          `UPDATE schedules SET consecutive_failures = 0, updated_at = @now WHERE id = @id`
        )
        .run({ id, now: new Date().toISOString() })
    }
    return (this.getStmt.get(id) as Schedule | undefined)?.consecutive_failures ?? 0
  }

  delete(id: string): void {
    this.deleteStmt.run(id)
  }
}
