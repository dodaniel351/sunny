import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Goal, GoalStatus } from '@shared/db/types'

// Repository for `goals` (structure layer, migration 006) — the objective→goal
// ancestry above the board. `parent_goal_id` chains a top-level objective down
// to its goals; tasks link up to a goal via `tasks.goal_id`, so every task can
// trace its "why". DB type is imported type-only so the native binding is never
// loaded here.

export interface GoalCreateInput {
  id?: string
  title: string
  description?: string | null
  parentGoalId?: string | null
  projectId?: string | null
  ownerAgentId?: string | null
  status?: GoalStatus
}

export interface GoalUpdateInput {
  id: string
  title?: string
  description?: string | null
  parentGoalId?: string | null
  ownerAgentId?: string | null
  status?: GoalStatus
}

// A goal plus a direct-task progress rollup (tasks linked straight to it). The
// Objectives view aggregates children on top of these per-goal counts.
export interface GoalNode extends Goal {
  task_total: number
  task_done: number
}

// Walking parent links can't loop in normal use, but guard anyway so a bad row
// (e.g. a goal pointed at itself) can never hang the ancestry walk.
const MAX_ANCESTRY_DEPTH = 32

export class GoalsRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly getStmt
  private readonly deleteStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.insertStmt = db.prepare(
      `INSERT INTO goals
         (id, parent_goal_id, project_id, title, description, status, owner_agent_id, budget_id, created_at, updated_at)
       VALUES
         (@id, @parent_goal_id, @project_id, @title, @description, @status, @owner_agent_id, @budget_id, @created_at, @updated_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM goals WHERE id = ?`)
    this.deleteStmt = db.prepare(`DELETE FROM goals WHERE id = ?`)
  }

  get(id: string): Goal | null {
    return (this.getStmt.get(id) as Goal | undefined) ?? null
  }

  // All goals, or scoped to a project (string) / unattached (null) like tasks.
  list(projectId?: string | null): Goal[] {
    if (projectId === undefined) {
      return this.db.prepare(`SELECT * FROM goals ORDER BY created_at`).all() as Goal[]
    }
    if (projectId === null) {
      return this.db
        .prepare(`SELECT * FROM goals WHERE project_id IS NULL ORDER BY created_at`)
        .all() as Goal[]
    }
    return this.db
      .prepare(`SELECT * FROM goals WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as Goal[]
  }

  // Goals with a direct-task progress rollup, in one aggregate query.
  listNodes(projectId?: string | null): GoalNode[] {
    const where =
      projectId === undefined ? '' : projectId === null ? `WHERE g.project_id IS NULL` : `WHERE g.project_id = @projectId`
    const rows = this.db
      .prepare(
        `SELECT g.*, COALESCE(c.total, 0) AS task_total, COALESCE(c.done, 0) AS task_done
         FROM goals g
         LEFT JOIN (
           SELECT goal_id, COUNT(*) AS total,
                  SUM(CASE WHEN status = 'Done' THEN 1 ELSE 0 END) AS done
           FROM tasks WHERE goal_id IS NOT NULL GROUP BY goal_id
         ) c ON c.goal_id = g.id
         ${where}
         ORDER BY g.created_at`
      )
      .all(projectId && projectId !== null ? { projectId } : {}) as GoalNode[]
    return rows
  }

  // The chain from the root objective down to (and including) this goal. Useful
  // as the "why" injected into an agent's prompt and for breadcrumbs.
  ancestry(id: string): Goal[] {
    const chain: Goal[] = []
    let current = this.get(id)
    let depth = 0
    while (current && depth < MAX_ANCESTRY_DEPTH) {
      chain.push(current)
      if (!current.parent_goal_id) break
      current = this.get(current.parent_goal_id)
      depth += 1
    }
    return chain.reverse()
  }

  create(input: GoalCreateInput): Goal {
    const now = new Date().toISOString()
    const row: Goal = {
      id: input.id ?? randomUUID(),
      parent_goal_id: input.parentGoalId ?? null,
      project_id: input.projectId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'active',
      owner_agent_id: input.ownerAgentId ?? null,
      budget_id: null,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  update(input: GoalUpdateInput): Goal {
    const existing = this.getStmt.get(input.id) as Goal | undefined
    if (!existing) {
      throw new Error(`Goal not found: ${input.id}`)
    }
    const row: Goal = {
      ...existing,
      title: input.title ?? existing.title,
      description: input.description === undefined ? existing.description : input.description,
      parent_goal_id:
        input.parentGoalId === undefined ? existing.parent_goal_id : input.parentGoalId,
      owner_agent_id:
        input.ownerAgentId === undefined ? existing.owner_agent_id : input.ownerAgentId,
      status: input.status ?? existing.status,
      updated_at: new Date().toISOString()
    }
    this.db
      .prepare(
        `UPDATE goals SET
           title = @title, description = @description, parent_goal_id = @parent_goal_id,
           owner_agent_id = @owner_agent_id, status = @status, updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: row.id,
        title: row.title,
        description: row.description,
        parent_goal_id: row.parent_goal_id,
        owner_agent_id: row.owner_agent_id,
        status: row.status,
        updated_at: row.updated_at
      })
    return row
  }

  // Child goals' parent_goal_id and tasks' goal_id are cleared by the ON DELETE
  // SET NULL foreign keys, so deleting a goal never orphans-cascade its work.
  delete(id: string): void {
    this.deleteStmt.run(id)
  }
}
