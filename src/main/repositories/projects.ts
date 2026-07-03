import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Project } from '@shared/db/types'

// Repository for `projects` rows (spec §7). A project scopes chats, tasks, and
// memory. Children reference projects with ON DELETE SET NULL, so deleting a
// project safely re-parents its chats/tasks/memories to "unattached" rather than
// destroying them. DB type is imported type-only so the native binding is never
// loaded here.

export interface ProjectCreateInput {
  id?: string
  name: string
  description?: string | null
}

export interface ProjectUpdateInput {
  id: string
  name?: string
  description?: string | null
  archived?: boolean
}

export class ProjectsRepo {
  private readonly insertStmt
  private readonly getStmt
  private readonly listAllStmt
  private readonly listActiveStmt
  private readonly updateStmt
  private readonly deleteStmt

  constructor(db: SunnyDatabase) {
    this.insertStmt = db.prepare(
      `INSERT INTO projects (id, name, description, columns, archived, created_at, updated_at)
       VALUES (@id, @name, @description, @columns, @archived, @created_at, @updated_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM projects WHERE id = ?`)
    this.listAllStmt = db.prepare(`SELECT * FROM projects ORDER BY archived ASC, updated_at DESC`)
    this.listActiveStmt = db.prepare(
      `SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC`
    )
    this.updateStmt = db.prepare(
      `UPDATE projects SET name = @name, description = @description, archived = @archived,
         updated_at = @updated_at WHERE id = @id`
    )
    this.deleteStmt = db.prepare(`DELETE FROM projects WHERE id = ?`)
  }

  list(includeArchived = false): Project[] {
    return (includeArchived ? this.listAllStmt : this.listActiveStmt).all() as Project[]
  }

  get(id: string): Project | null {
    return (this.getStmt.get(id) as Project | undefined) ?? null
  }

  create(input: ProjectCreateInput): Project {
    const now = new Date().toISOString()
    const row: Project = {
      id: input.id ?? randomUUID(),
      name: input.name,
      description: input.description ?? null,
      columns: null,
      archived: 0,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  update(input: ProjectUpdateInput): Project {
    const existing = this.getStmt.get(input.id) as Project | undefined
    if (!existing) throw new Error(`Project not found: ${input.id}`)
    const row: Project = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : input.description,
      archived: input.archived === undefined ? existing.archived : input.archived ? 1 : 0,
      updated_at: new Date().toISOString()
    }
    this.updateStmt.run({
      id: row.id,
      name: row.name,
      description: row.description,
      archived: row.archived,
      updated_at: row.updated_at
    })
    return row
  }

  // chats/tasks/memories/runs/schedules re-parent to NULL via ON DELETE SET NULL.
  delete(id: string): void {
    this.deleteStmt.run(id)
  }
}
