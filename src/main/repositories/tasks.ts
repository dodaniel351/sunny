import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Task, TaskEvent, TaskStatus } from '@shared/db/types'
import type { ActivitySink } from './activity'

// Repository for `tasks` and their `task_events` audit trail (spec §6/§10). The
// board is a view over these rows; agents read and write them directly. Every
// status transition records a task_events row so the Live Activity pane can
// replay claimed/working/blocked/finished. DB type is imported type-only so the
// native binding is never loaded here.

export interface TaskCreateInput {
  id?: string
  title: string
  description?: string
  status?: TaskStatus
  projectId?: string
  assignee?: string
  chatId?: string
  // Parent task for agent-decomposed subtasks (multi-agent delegation, spec §7).
  parentTaskId?: string
  // The goal this task traces back to (structure layer, migration 006).
  goalId?: string
}

export interface TaskUpdateInput {
  id: string
  title?: string
  description?: string | null
  status?: TaskStatus
  assignee?: string | null
  sortOrder?: number
}

export interface TaskMoveInput {
  id: string
  status: TaskStatus
  sortOrder?: number
  actor?: string
  /** Optional reason recorded on the transition (e.g. why a task was blocked). */
  note?: string
}

// One recent board transition for the Live Activity pane: a task_events row
// joined to its task's title + chat link.
export interface TaskActivityRow {
  id: string
  task_id: string
  task_title: string
  chat_id: string | null
  from_status: TaskStatus | null
  to_status: TaskStatus
  actor: string | null
  note: string | null
  created_at: string
  // The task's CURRENT status — lets the rail animate only genuinely-live work
  // (a past 'In Progress' event whose task has since finished must not spin).
  task_status: TaskStatus
}

export class TasksRepo {
  // Board annotations appended to list queries (see constructor comment).
  private static readonly BOARD_ANNOTATIONS = `
    CASE WHEN tasks.status = 'Blocked' THEN (
      SELECT e.note FROM task_events e
      WHERE e.task_id = tasks.id AND e.to_status = 'Blocked' AND e.note IS NOT NULL
      ORDER BY e.created_at DESC, e.id DESC LIMIT 1
    ) END AS blocked_reason,
    EXISTS(
      SELECT 1 FROM approvals a WHERE a.task_id = tasks.id AND a.status = 'pending'
    ) AS awaiting_approval`

  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly getStmt
  private readonly listAllStmt
  private readonly listByProjectStmt
  private readonly maxSortStmt
  private readonly insertEventStmt
  private readonly eventsStmt
  private readonly recentActivityStmt
  private readonly deleteStmt
  // Optional write-side audit hook (structure layer). Called INSIDE the same
  // transaction as the mutation so the activity entry commits atomically.
  private readonly onActivity?: ActivitySink

  constructor(db: SunnyDatabase, onActivity?: ActivitySink) {
    this.db = db
    this.onActivity = onActivity
    this.insertStmt = db.prepare(
      `INSERT INTO tasks
         (id, project_id, title, description, status, assignee, parent_task_id, sort_order, run_id, chat_id,
          goal_id, locked_by, locked_at, wake_at, context_ref, created_at, updated_at)
       VALUES
         (@id, @project_id, @title, @description, @status, @assignee, @parent_task_id, @sort_order, @run_id, @chat_id,
          @goal_id, @locked_by, @locked_at, @wake_at, @context_ref, @created_at, @updated_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`)
    // Order by column (status), then manual order within the column, then age.
    // The two board annotations ride along so a card can say WHY it's stuck
    // without per-task follow-up queries:
    //   blocked_reason    — the note on the latest transition INTO Blocked
    //                       (only for currently-Blocked tasks);
    //   awaiting_approval — 1 when a pending approval gate exists for the task.
    this.listAllStmt = db.prepare(
      `SELECT tasks.*, ${TasksRepo.BOARD_ANNOTATIONS} FROM tasks
       ORDER BY status, sort_order, created_at`
    )
    this.listByProjectStmt = db.prepare(
      `SELECT tasks.*, ${TasksRepo.BOARD_ANNOTATIONS} FROM tasks
       WHERE project_id = ? ORDER BY status, sort_order, created_at`
    )
    // Highest sort_order currently in a (project, status) column; null when empty.
    this.maxSortStmt = db.prepare(
      `SELECT MAX(sort_order) AS maxSort FROM tasks
       WHERE status = @status AND (project_id IS @project_id)`
    )
    this.insertEventStmt = db.prepare(
      `INSERT INTO task_events (id, task_id, from_status, to_status, actor, note, created_at)
       VALUES (@id, @task_id, @from_status, @to_status, @actor, @note, @created_at)`
    )
    this.eventsStmt = db.prepare(
      `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC`
    )
    // The LATEST transition per task, newest first, with the task's title +
    // chat link + current status — the source for the Live Activity pane. We
    // collapse to one row per task (not every micro-transition) so the rail
    // reflects current state, not a replay of a finished task's whole history.
    this.recentActivityStmt = db.prepare(
      `SELECT e.id AS id, e.task_id AS task_id, t.title AS task_title, t.chat_id AS chat_id,
              e.from_status AS from_status, e.to_status AS to_status, e.actor AS actor,
              e.note AS note, e.created_at AS created_at, t.status AS task_status
       FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.id = (
         SELECT e2.id FROM task_events e2
         WHERE e2.task_id = e.task_id
         ORDER BY e2.created_at DESC, e2.id DESC
         LIMIT 1
       )
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`
    )
    this.deleteStmt = db.prepare(`DELETE FROM tasks WHERE id = ?`)
  }

  get(id: string): Task | null {
    return (this.getStmt.get(id) as Task | undefined) ?? null
  }

  list(projectId?: string | null): Task[] {
    if (projectId === undefined) {
      return this.listAllStmt.all() as Task[]
    }
    if (projectId === null) {
      // Tasks not attached to any project.
      return this.db
        .prepare(
          `SELECT tasks.*, ${TasksRepo.BOARD_ANNOTATIONS} FROM tasks
           WHERE project_id IS NULL ORDER BY status, sort_order, created_at`
        )
        .all() as Task[]
    }
    return this.listByProjectStmt.all(projectId) as Task[]
  }

  // Tasks tracing back to one goal, ordered like the board. A prepared query so
  // the goal detail view doesn't scan+filter the whole tasks table.
  listByGoal(goalId: string): Task[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE goal_id = ? ORDER BY status, sort_order, created_at`)
      .all(goalId) as Task[]
  }

  create(input: TaskCreateInput): Task {
    const now = new Date().toISOString()
    const status: TaskStatus = input.status ?? 'Backlog'
    const projectId = input.projectId ?? null
    const sortOrder = this.nextSortOrder(status, projectId)

    const row: Task = {
      id: input.id ?? randomUUID(),
      project_id: projectId,
      title: input.title,
      description: input.description ?? null,
      status,
      assignee: input.assignee ?? null,
      parent_task_id: input.parentTaskId ?? null,
      sort_order: sortOrder,
      run_id: null,
      chat_id: input.chatId ?? null,
      goal_id: input.goalId ?? null,
      locked_by: null,
      locked_at: null,
      wake_at: null,
      context_ref: null,
      created_at: now,
      updated_at: now
    }

    const tx = this.db.transaction(() => {
      this.insertStmt.run(row)
      this.insertEventStmt.run({
        id: randomUUID(),
        task_id: row.id,
        from_status: null,
        to_status: status,
        actor: 'user',
        note: null,
        created_at: now
      })
      this.onActivity?.({
        kind: 'task.created',
        actor: 'user',
        taskId: row.id,
        goalId: row.goal_id,
        projectId: row.project_id,
        payload: { summary: `Task created: “${row.title}”`, title: row.title, status }
      })
    })
    tx()
    return row
  }

  update(input: TaskUpdateInput): Task {
    const existing = this.getStmt.get(input.id) as Task | undefined
    if (!existing) {
      throw new Error(`Task not found: ${input.id}`)
    }

    const now = new Date().toISOString()
    const statusChanged = input.status !== undefined && input.status !== existing.status

    const row: Task = {
      ...existing,
      title: input.title ?? existing.title,
      description: input.description === undefined ? existing.description : input.description,
      status: input.status ?? existing.status,
      assignee: input.assignee === undefined ? existing.assignee : input.assignee,
      sort_order: input.sortOrder ?? existing.sort_order,
      updated_at: now
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET
             title = @title,
             description = @description,
             status = @status,
             assignee = @assignee,
             sort_order = @sort_order,
             updated_at = @updated_at
           WHERE id = @id`
        )
        .run({
          id: row.id,
          title: row.title,
          description: row.description,
          status: row.status,
          assignee: row.assignee,
          sort_order: row.sort_order,
          updated_at: now
        })
      if (statusChanged) {
        this.insertEventStmt.run({
          id: randomUUID(),
          task_id: row.id,
          from_status: existing.status,
          to_status: row.status,
          actor: 'user',
          note: null,
          created_at: now
        })
      }
    })
    tx()
    return row
  }

  // Set status (and sort_order — given, else appended to the target column),
  // record the transition, and bump updated_at. The read-old + update + event
  // insert run atomically so a concurrent reader never sees a half-applied move.
  move(input: TaskMoveInput): Task {
    const tx = this.db.transaction((): Task => {
      const existing = this.getStmt.get(input.id) as Task | undefined
      if (!existing) {
        throw new Error(`Task not found: ${input.id}`)
      }

      const now = new Date().toISOString()
      const sortOrder = input.sortOrder ?? this.nextSortOrder(input.status, existing.project_id)

      this.db
        .prepare(
          `UPDATE tasks SET status = @status, sort_order = @sort_order, updated_at = @updated_at WHERE id = @id`
        )
        .run({ id: input.id, status: input.status, sort_order: sortOrder, updated_at: now })

      this.insertEventStmt.run({
        id: randomUUID(),
        task_id: input.id,
        from_status: existing.status,
        to_status: input.status,
        actor: input.actor ?? 'user',
        note: input.note ?? null,
        created_at: now
      })

      const actor = input.actor ?? 'user'
      this.onActivity?.({
        kind: 'task.moved',
        actor,
        taskId: input.id,
        goalId: existing.goal_id,
        projectId: existing.project_id,
        runId: existing.run_id,
        payload: {
          summary: `${actor} moved “${existing.title}” → ${input.status}` +
            (input.note ? ` — ${input.note}` : ''),
          title: existing.title,
          from: existing.status,
          to: input.status,
          note: input.note ?? null
        }
      })

      return {
        ...existing,
        status: input.status,
        sort_order: sortOrder,
        updated_at: now
      }
    })
    return tx()
  }

  // --- structure layer: execution lock + wakeup queue (migration 006) ------

  // Atomically claim a task for a run: only succeeds when the task exists and
  // is currently unlocked. Sets the lock, links the run, moves the card to
  // 'In Progress', records the transition + a `task.claimed` activity entry —
  // all in one transaction. Returns the updated Task, or null when the task is
  // gone or already claimed (the caller treats null as "someone else has it").
  // This makes double-claiming impossible even if the worker ever runs
  // concurrently; today it stays serial, so the lock is also crash-safety.
  checkout(taskId: string, runId: string, actor: string): Task | null {
    const tx = this.db.transaction((): Task | null => {
      const existing = this.getStmt.get(taskId) as Task | undefined
      if (!existing || existing.locked_by != null) return null

      const now = new Date().toISOString()
      const result = this.db
        .prepare(
          `UPDATE tasks SET status = 'In Progress', locked_by = @runId, locked_at = @now,
             run_id = @runId, updated_at = @now
           WHERE id = @id AND locked_by IS NULL`
        )
        .run({ id: taskId, runId, now })
      // Guard against a race the SELECT couldn't see (defensive; the transaction
      // already serializes writes on this connection).
      if (result.changes === 0) return null

      this.insertEventStmt.run({
        id: randomUUID(),
        task_id: taskId,
        from_status: existing.status,
        to_status: 'In Progress',
        actor,
        note: null,
        created_at: now
      })
      this.onActivity?.({
        kind: 'task.claimed',
        actor,
        taskId,
        goalId: existing.goal_id,
        projectId: existing.project_id,
        runId,
        payload: { summary: `${actor} claimed “${existing.title}”`, title: existing.title }
      })

      return {
        ...existing,
        status: 'In Progress',
        locked_by: runId,
        locked_at: now,
        run_id: runId,
        updated_at: now
      }
    })
    return tx()
  }

  // Release a task's execution lock (on finish, block, or stale-lock recovery).
  // Leaves status/run_id untouched — the caller decides the new column. When
  // `runId` is given, the release is OWNERSHIP-CHECKED: it only clears the lock
  // if this run still holds it, so a finishing run can never strip a lock a
  // newer run has since acquired. Passing no runId is a deliberate steal (the
  // decide handler / orphan recovery, reachable only when the task is unlocked).
  releaseLock(id: string, runId?: string): void {
    this.db
      .prepare(
        `UPDATE tasks SET locked_by = NULL, locked_at = NULL, updated_at = @now
         WHERE id = @id AND (@runId IS NULL OR locked_by = @runId)`
      )
      .run({ id, runId: runId ?? null, now: new Date().toISOString() })
  }

  // Set (or clear, with null) when the heartbeat should next consider a task —
  // the DB-backed wakeup queue used for backoff / context resumption.
  setWake(id: string, wakeAt: string | null): void {
    this.db
      .prepare(`UPDATE tasks SET wake_at = @wake_at, updated_at = @now WHERE id = @id`)
      .run({ id, wake_at: wakeAt, now: new Date().toISOString() })
  }

  // Tasks the heartbeat may work right now: in a workable column, not locked,
  // not parked in the future by wake_at, and not blocked by an unfinished
  // dependency (a `blocks` edge whose blocker isn't Done). Ordered like the
  // board so the top of a column goes first.
  workableNow(nowIso: string): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('Backlog', 'Planned')
           AND locked_by IS NULL
           AND (wake_at IS NULL OR wake_at <= @now)
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies d
             JOIN tasks blocker ON blocker.id = d.depends_on_task_id
             WHERE d.task_id = tasks.id AND d.kind = 'blocks' AND blocker.status != 'Done'
           )
         ORDER BY status, sort_order, created_at`
      )
      .all({ now: nowIso }) as Task[]
  }

  // task_events are removed by the ON DELETE CASCADE foreign key.
  delete(id: string): void {
    this.deleteStmt.run(id)
  }

  events(taskId: string): TaskEvent[] {
    return this.eventsStmt.all(taskId) as TaskEvent[]
  }

  // Most recent board transitions across all tasks (for the Live Activity pane).
  recentActivity(limit = 20): TaskActivityRow[] {
    return this.recentActivityStmt.all(limit) as TaskActivityRow[]
  }

  // Persist the chat a run should RESUME from (the iterative worker's working
  // context) — survives retries, approval re-queues, and app restarts.
  setContextRef(id: string, ref: string | null): void {
    this.db
      .prepare(`UPDATE tasks SET context_ref = @ref, updated_at = @now WHERE id = @id`)
      .run({ id, ref, now: new Date().toISOString() })
  }

  // Link a task to the chat/run that worked it (set by the task worker).
  setChat(id: string, chatId: string): void {
    this.db
      .prepare(`UPDATE tasks SET chat_id = @chat_id, updated_at = @updated_at WHERE id = @id`)
      .run({ id, chat_id: chatId, updated_at: new Date().toISOString() })
  }

  // Link a task to a goal (the "why"), or clear it with null. Structure layer.
  setGoal(id: string, goalId: string | null): void {
    this.db
      .prepare(`UPDATE tasks SET goal_id = @goal_id, updated_at = @updated_at WHERE id = @id`)
      .run({ id, goal_id: goalId, updated_at: new Date().toISOString() })
  }

  // Next sort_order for a (project, status) column: max + 1, or 0 when empty.
  // `IS` (not `=`) matches NULL project_id for unattached tasks.
  private nextSortOrder(status: TaskStatus, projectId: string | null): number {
    const { maxSort } = this.maxSortStmt.get({ status, project_id: projectId }) as {
      maxSort: number | null
    }
    return maxSort === null ? 0 : maxSort + 1
  }
}
