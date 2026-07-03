import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Memory, MemoryKind, MemoryScope } from '@shared/db/types'

// Repository for `memories` rows (spec §5). The sqlite-vec mirror in
// memory_vectors is populated by the embedding pipeline, not here; rows start
// with embedded = 0. DB type is imported type-only so the native binding is
// never loaded in this module. Fixed prepared statements are built once per
// instance; list() builds its statement dynamically because its WHERE clause
// depends on which filters were supplied.

export interface MemoryCreateInput {
  id?: string
  content: string
  scope?: MemoryScope
  kind?: MemoryKind
  scopeRef?: string
  projectId?: string
  metadata?: string
}

export interface MemoryUpdateInput {
  id: string
  content?: string
  scope?: MemoryScope
  kind?: MemoryKind
}

export interface MemoryListInput {
  scope?: MemoryScope
  query?: string
  // Exact project filter for the Memory browser (a project's own memories).
  // undefined = no filter (all). Retrieval uses a wider "project OR global"
  // scope, applied in MemoryService, not here.
  projectId?: string
}

export class MemoriesRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly getStmt
  private readonly updateStmt
  private readonly deleteStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.insertStmt = db.prepare(
      `INSERT INTO memories
         (id, scope, kind, scope_ref, project_id, content, metadata, embedded, created_at, updated_at)
       VALUES
         (@id, @scope, @kind, @scope_ref, @project_id, @content, @metadata, @embedded, @created_at, @updated_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM memories WHERE id = ?`)
    this.updateStmt = db.prepare(
      `UPDATE memories SET content = @content, scope = @scope, kind = @kind, updated_at = @updated_at WHERE id = @id`
    )
    this.deleteStmt = db.prepare(`DELETE FROM memories WHERE id = ?`)
  }

  // Filter by scope when given and case-insensitively substring-match `content`
  // when a query is given. The query is escaped so user '%'/'_' are literal, and
  // an explicit ESCAPE clause makes the escape character active.
  list(input?: MemoryListInput): Memory[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}

    if (input?.scope) {
      clauses.push(`scope = @scope`)
      params.scope = input.scope
    }
    if (input?.projectId) {
      clauses.push(`project_id = @project_id`)
      params.project_id = input.projectId
    }
    if (input?.query) {
      clauses.push(`content LIKE @query ESCAPE '\\'`)
      params.query = `%${escapeLike(input.query)}%`
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const stmt = this.db.prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC`)
    return stmt.all(params) as Memory[]
  }

  create(input: MemoryCreateInput): Memory {
    const now = new Date().toISOString()
    const row: Memory = {
      id: input.id ?? randomUUID(),
      scope: input.scope ?? 'global',
      kind: input.kind ?? 'semantic',
      scope_ref: input.scopeRef ?? null,
      project_id: input.projectId ?? null,
      content: input.content,
      metadata: input.metadata ?? null,
      embedded: 0,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  update(input: MemoryUpdateInput): Memory {
    const existing = this.getStmt.get(input.id) as Memory | undefined
    if (!existing) {
      throw new Error(`Memory not found: ${input.id}`)
    }

    const row: Memory = {
      ...existing,
      content: input.content ?? existing.content,
      scope: input.scope ?? existing.scope,
      kind: input.kind ?? existing.kind,
      updated_at: new Date().toISOString()
    }
    this.updateStmt.run({
      id: row.id,
      content: row.content,
      scope: row.scope,
      kind: row.kind,
      updated_at: row.updated_at
    })
    return row
  }

  delete(id: string): void {
    this.deleteStmt.run(id)
  }
}

// Escape SQL LIKE wildcards so a user query matches literally. Backslash is the
// escape character declared in the LIKE ... ESCAPE clause above.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}
