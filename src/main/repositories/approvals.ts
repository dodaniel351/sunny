import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Approval, ApprovalStatus } from '@shared/db/types'

// Repository for `approvals` (migration 006) — governance gates the autonomous
// worker raises before a side-effecting action ships (structure layer, Phase 4).
// When a tool's permission gate would block an unattended action, the worker
// records a PENDING approval here and parks the task; the /approvals inbox lets
// the user approve (the task re-queues and the agent proceeds) or reject. DB type
// is imported type-only so the native binding is never loaded here.

export interface ApprovalRequestInput {
  taskId?: string | null
  runId?: string | null
  agentId?: string | null
  // The gate key, e.g. 'tool:write_file' — approving it lets that tool run for
  // this task on the next heartbeat.
  gate: string
  title: string
  detail?: string | null
}

// An approval joined to its task title + agent name + project (for the inbox,
// the rail badge's project scoping, and a goal/board breadcrumb). Mirrors the
// `ApprovalView` Zod schema in the IPC contract.
export interface ApprovalView extends Approval {
  task_title: string | null
  agent_name: string | null
  project_id: string | null
}

export interface ApprovalListOptions {
  /** Restrict to one status (the inbox passes 'pending'). Omitted = all. */
  status?: ApprovalStatus
  /** One project's approvals plus global (task-less) ones. */
  projectId?: string
  limit?: number
}

export class ApprovalsRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly getStmt
  private readonly latestForGateStmt
  private readonly hasPendingStmt
  private readonly decideStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.insertStmt = db.prepare(
      `INSERT INTO approvals
         (id, task_id, run_id, agent_id, gate, title, detail, status, decided_by, decided_at, created_at)
       VALUES
         (@id, @task_id, @run_id, @agent_id, @gate, @title, @detail, 'pending', NULL, NULL, @created_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM approvals WHERE id = ?`)
    this.latestForGateStmt = db.prepare(
      `SELECT * FROM approvals WHERE task_id = @taskId AND gate = @gate
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    this.hasPendingStmt = db.prepare(
      `SELECT 1 FROM approvals WHERE task_id = ? AND status = 'pending' LIMIT 1`
    )
    this.decideStmt = db.prepare(
      `UPDATE approvals SET status = @status, decided_by = @decided_by, decided_at = @decided_at
       WHERE id = @id`
    )
  }

  get(id: string): Approval | null {
    return (this.getStmt.get(id) as Approval | undefined) ?? null
  }

  // Raise a new pending approval gate.
  request(input: ApprovalRequestInput): Approval {
    const now = new Date().toISOString()
    const row: Approval = {
      id: randomUUID(),
      task_id: input.taskId ?? null,
      run_id: input.runId ?? null,
      agent_id: input.agentId ?? null,
      gate: input.gate,
      title: input.title,
      detail: input.detail ?? null,
      status: 'pending',
      decided_by: null,
      decided_at: null,
      created_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  // The most recent approval for a (task, gate), or null — the worker's gate
  // consults this to decide allow / wait / request / deny.
  latestForGate(taskId: string, gate: string): Approval | null {
    return (this.latestForGateStmt.get({ taskId, gate }) as Approval | undefined) ?? null
  }

  // Whether a task has any still-pending approval (the worker parks such a task).
  hasPending(taskId: string): boolean {
    return this.hasPendingStmt.get(taskId) !== undefined
  }

  // Mark an approval consumed on use: an approved gate is single-use, so once its
  // action has run we flip it to 'expired' (which the policy treats as "ask
  // again"). This is what stops one approved action from becoming a permanent
  // blanket allow for that (task, gate).
  markExpired(id: string): void {
    this.db
      .prepare(`UPDATE approvals SET status = 'expired' WHERE id = @id`)
      .run({ id })
  }

  // Record a decision (approved | rejected | expired). Stamps who/when.
  decide(id: string, input: { status: ApprovalStatus; decidedBy?: string | null }): Approval | null {
    this.decideStmt.run({
      id,
      status: input.status,
      decided_by: input.decidedBy ?? 'user',
      decided_at: new Date().toISOString()
    })
    return this.get(id)
  }

  // Inbox query: approvals (optionally one status / one project) with the task
  // title + agent name + project for display, newest first.
  list(options: ApprovalListOptions = {}): ApprovalView[] {
    const clauses: string[] = []
    const params: Record<string, unknown> = {}
    if (options.status) {
      clauses.push(`a.status = @status`)
      params.status = options.status
    }
    if (options.projectId) {
      // The project's own approvals plus global (task-less / project-less) ones.
      clauses.push(`(t.project_id = @projectId OR t.project_id IS NULL)`)
      params.projectId = options.projectId
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    params.limit = options.limit ?? 100
    return this.db
      .prepare(
        `SELECT a.*, t.title AS task_title, ag.name AS agent_name, t.project_id AS project_id
         FROM approvals a
         LEFT JOIN tasks t ON t.id = a.task_id
         LEFT JOIN agents ag ON ag.id = a.agent_id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT @limit`
      )
      .all(params) as ApprovalView[]
  }

  // Count of pending approvals (optionally for one project) — the rail badge.
  pendingCount(projectId?: string): number {
    if (projectId) {
      const { n } = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM approvals a
           LEFT JOIN tasks t ON t.id = a.task_id
           WHERE a.status = 'pending' AND (t.project_id = @projectId OR t.project_id IS NULL)`
        )
        .get({ projectId }) as { n: number }
      return n
    }
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)
      .get() as { n: number }
    return n
  }
}
