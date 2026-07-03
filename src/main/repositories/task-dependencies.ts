import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { DependencyKind, Task, TaskDependency } from '@shared/db/types'

// Repository for `task_dependencies` (structure layer, migration 006) — the
// first-class blocker edges between tasks. A row says `task_id` is blocked by
// `depends_on_task_id`. The heartbeat's `workableNow` enforces blocking in SQL;
// this repo manages the edges and answers the board UI's "what blocks this /
// what does this block" questions. DB type is imported type-only.

// Both sides of a task's dependency edges, resolved to the full task rows.
export interface TaskDependencyView {
  // Tasks this task is blocked by (its blockers).
  blockers: Task[]
  // Tasks that are blocked by this task (its dependents).
  blocking: Task[]
}

export class TaskDependenciesRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly deleteEdgeStmt
  private readonly blockersStmt
  private readonly blockingStmt
  private readonly cycleStmt
  private readonly titleStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.insertStmt = db.prepare(
      `INSERT INTO task_dependencies (id, task_id, depends_on_task_id, kind, created_at)
       VALUES (@id, @task_id, @depends_on_task_id, @kind, @created_at)`
    )
    // Would adding "taskId blocked by dependsOnTaskId" close a cycle? Walk the
    // blockers of dependsOnTaskId transitively (its `blocks` upstream); if taskId
    // is already up there, taskId already blocks dependsOnTaskId, so the new edge
    // would be circular. Returns a row when a cycle would form.
    this.cycleStmt = db.prepare(
      `WITH RECURSIVE upstream(id) AS (
         SELECT depends_on_task_id FROM task_dependencies
           WHERE task_id = @dependsOnTaskId AND kind = 'blocks'
         UNION
         SELECT d.depends_on_task_id FROM task_dependencies d
           JOIN upstream u ON d.task_id = u.id
           WHERE d.kind = 'blocks'
       )
       SELECT 1 FROM upstream WHERE id = @taskId LIMIT 1`
    )
    this.titleStmt = db.prepare(`SELECT title FROM tasks WHERE id = ?`)
    this.deleteEdgeStmt = db.prepare(
      `DELETE FROM task_dependencies WHERE task_id = @task_id AND depends_on_task_id = @depends_on_task_id`
    )
    this.blockersStmt = db.prepare(
      `SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ? ORDER BY t.status, t.sort_order, t.created_at`
    )
    this.blockingStmt = db.prepare(
      `SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ? ORDER BY t.status, t.sort_order, t.created_at`
    )
  }

  // Add an edge: `taskId` is blocked by `dependsOnTaskId`. Rejects a self-edge;
  // the UNIQUE(task_id, depends_on_task_id) constraint makes re-adding a no-op.
  add(taskId: string, dependsOnTaskId: string, kind: DependencyKind = 'blocks'): TaskDependency {
    if (taskId === dependsOnTaskId) {
      throw new Error('A task cannot depend on itself.')
    }
    // Reject any edge that would close a cycle (a 2-cycle A↔B, or a longer
    // A→B→C→A). `workableNow` excludes a task with a non-Done blocker, so a cycle
    // would deadlock every task on it forever. Only `blocks` edges gate work, so
    // only they can deadlock.
    if (kind === 'blocks' && this.cycleStmt.get({ taskId, dependsOnTaskId })) {
      const titleOf = (id: string): string =>
        (this.titleStmt.get(id) as { title?: string } | undefined)?.title ?? id
      throw new Error(
        `This would create a circular dependency — "${titleOf(taskId)}" already blocks "${titleOf(dependsOnTaskId)}".`
      )
    }
    const row: TaskDependency = {
      id: randomUUID(),
      task_id: taskId,
      depends_on_task_id: dependsOnTaskId,
      kind,
      created_at: new Date().toISOString()
    }
    try {
      this.insertStmt.run(row)
    } catch (err) {
      // Idempotent: a duplicate edge (UNIQUE violation) is a no-op, not an error.
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        const existing = this.db
          .prepare(
            `SELECT * FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?`
          )
          .get(taskId, dependsOnTaskId) as TaskDependency | undefined
        if (existing) return existing
      }
      throw err
    }
    return row
  }

  remove(taskId: string, dependsOnTaskId: string): void {
    this.deleteEdgeStmt.run({ task_id: taskId, depends_on_task_id: dependsOnTaskId })
  }

  // Both sides of a task's edges, resolved to full task rows for the UI.
  forTask(taskId: string): TaskDependencyView {
    return {
      blockers: this.blockersStmt.all(taskId) as Task[],
      blocking: this.blockingStmt.all(taskId) as Task[]
    }
  }
}
