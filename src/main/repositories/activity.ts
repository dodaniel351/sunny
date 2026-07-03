import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { ActivityEvent } from '@shared/db/types'

// Repository for `activity_events` (migration 006) — the durable, generalized
// audit log behind the Activity view. It generalizes `task_events`: every
// mutating action, run state change, cost event, and approval decision lands
// here so an operator can replay what happened and why. DB type is imported
// type-only so the native binding is never loaded here.
//
// The `payload` column is a JSON blob; by convention it carries a denormalized
// `summary` string so the feed renders a row without joining back to
// tasks/agents/runs for their names.

/** A record to append to the activity log. `payload` is JSON-serialized. */
export interface ActivityInput {
  kind: string
  actor?: string | null
  agentId?: string | null
  taskId?: string | null
  goalId?: string | null
  runId?: string | null
  projectId?: string | null
  // Free-form detail; include a human `summary` so the feed needs no joins.
  payload?: Record<string, unknown> | null
}

/**
 * A write-side hook the mutating repos call after a successful write so the
 * action is logged inside the same transaction. Injected via
 * `createRepositories` to avoid threading ActivityRepo into every repo.
 */
export type ActivitySink = (event: ActivityInput) => void

export interface ActivityListOptions {
  limit?: number
  /** Restrict to these `kind`s (any-of). Omitted = all kinds. */
  kinds?: string[]
  /** Restrict to one project (its events + global events with no project). */
  projectId?: string
}

export class ActivityRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.insertStmt = db.prepare(
      `INSERT INTO activity_events
         (id, kind, actor, agent_id, task_id, goal_id, run_id, project_id, payload, created_at)
       VALUES
         (@id, @kind, @actor, @agent_id, @task_id, @goal_id, @run_id, @project_id, @payload, @created_at)`
    )
  }

  record(input: ActivityInput): ActivityEvent {
    const row: ActivityEvent = {
      id: randomUUID(),
      kind: input.kind,
      actor: input.actor ?? null,
      agent_id: input.agentId ?? null,
      task_id: input.taskId ?? null,
      goal_id: input.goalId ?? null,
      run_id: input.runId ?? null,
      project_id: input.projectId ?? null,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      created_at: new Date().toISOString()
    }
    this.insertStmt.run(row)
    return row
  }

  // Most recent events, newest first, with optional kind/project filters. The
  // query is built per call because the kind filter is variable-length;
  // better-sqlite3 caches prepared statements by SQL text, so this stays cheap.
  recent(options: ActivityListOptions = {}): ActivityEvent[] {
    const limit = options.limit ?? 50
    const clauses: string[] = []
    const params: Record<string, unknown> = {}

    if (options.projectId) {
      // Include the project's own events plus global (project-less) events.
      clauses.push(`(project_id = @projectId OR project_id IS NULL)`)
      params.projectId = options.projectId
    }
    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map((_, i) => `@kind${i}`)
      options.kinds.forEach((k, i) => {
        params[`kind${i}`] = k
      })
      clauses.push(`kind IN (${placeholders.join(', ')})`)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    params.limit = limit
    return this.db
      .prepare(
        `SELECT * FROM activity_events ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`
      )
      .all(params) as ActivityEvent[]
  }

  // Count of events newer than a seen watermark (ISO string; '' = none seen yet),
  // with the same optional kind/project filters as `recent`. Powers the rail's
  // "new activity" badge WITHOUT shipping the rows or capping at a page size.
  unseenCount(seenAt: string, options: { kinds?: string[]; projectId?: string } = {}): number {
    const clauses: string[] = ['created_at > @seenAt']
    const params: Record<string, unknown> = { seenAt: seenAt || '' }

    if (options.projectId) {
      clauses.push(`(project_id = @projectId OR project_id IS NULL)`)
      params.projectId = options.projectId
    }
    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map((_, i) => `@kind${i}`)
      options.kinds.forEach((k, i) => {
        params[`kind${i}`] = k
      })
      clauses.push(`kind IN (${placeholders.join(', ')})`)
    }

    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM activity_events WHERE ${clauses.join(' AND ')}`)
      .get(params) as { n: number }
    return n
  }
}
