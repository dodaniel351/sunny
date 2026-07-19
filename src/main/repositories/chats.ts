import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Chat } from '@shared/db/types'
import type { ChatSummary } from '@shared/ipc/contract'

// Repository for `chats` rows (spec §8). Receives a live better-sqlite3 handle;
// the DB type is imported type-only so this module never loads the native
// binding. Prepared statements are built once per instance and reused.

export interface ChatCreateInput {
  id?: string
  title?: string
  provider?: string
  model?: string
  projectId?: string
  agentId?: string
  /** Start the chat in incognito mode (kept out of the memory system). */
  incognito?: boolean
}

export class ChatsRepo {
  private readonly insertStmt
  private readonly getStmt
  private readonly listStmt
  private readonly listByProjectStmt
  private readonly listUnattachedStmt
  private readonly renameStmt
  private readonly setProjectStmt
  private readonly setIncognitoStmt
  private readonly touchStmt
  private readonly deleteStmt

  constructor(db: SunnyDatabase) {
    this.insertStmt = db.prepare(
      `INSERT INTO chats (id, project_id, title, provider, model, agent_id, archived, incognito, created_at, updated_at)
       VALUES (@id, @project_id, @title, @provider, @model, @agent_id, 0, @incognito, @created_at, @updated_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM chats WHERE id = ?`)
    // Newest-first by updated_at; LEFT JOIN messages for count + last activity.
    // The SELECT/GROUP BY/ORDER BY is shared; only the WHERE differs by scope.
    const listSelect = (where: string): string =>
      `SELECT
         c.id,
         c.title,
         c.provider,
         c.model,
         c.project_id,
         c.created_at,
         c.updated_at,
         COUNT(m.id) AS messageCount,
         MAX(m.created_at) AS lastMessageAt
       FROM chats c
       LEFT JOIN messages m ON m.chat_id = c.id
       ${where}
       GROUP BY c.id
       ORDER BY c.updated_at DESC`
    this.listStmt = db.prepare(listSelect(''))
    this.listByProjectStmt = db.prepare(listSelect('WHERE c.project_id = @project_id'))
    this.listUnattachedStmt = db.prepare(listSelect('WHERE c.project_id IS NULL'))
    this.renameStmt = db.prepare(
      `UPDATE chats SET title = @title, updated_at = @updated_at WHERE id = @id`
    )
    this.setProjectStmt = db.prepare(
      `UPDATE chats SET project_id = @project_id, updated_at = @updated_at WHERE id = @id`
    )
    this.setIncognitoStmt = db.prepare(
      `UPDATE chats SET incognito = @incognito, updated_at = @updated_at WHERE id = @id`
    )
    this.touchStmt = db.prepare(`UPDATE chats SET updated_at = @updated_at WHERE id = @id`)
    this.deleteStmt = db.prepare(`DELETE FROM chats WHERE id = ?`)
  }

  create(input: ChatCreateInput): Chat {
    const now = new Date().toISOString()
    const row: Chat = {
      id: input.id ?? randomUUID(),
      project_id: input.projectId ?? null,
      title: input.title ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      agent_id: input.agentId ?? null,
      archived: 0,
      incognito: input.incognito ? 1 : 0,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  /** Toggle incognito mode (keeps the chat out of the memory system). Applies
   *  to subsequent turns; already-captured memories are not retroactively removed. */
  setIncognito(id: string, incognito: boolean): void {
    this.setIncognitoStmt.run({
      id,
      incognito: incognito ? 1 : 0,
      updated_at: new Date().toISOString()
    })
  }

  get(id: string): Chat | null {
    return (this.getStmt.get(id) as Chat | undefined) ?? null
  }

  // projectId: undefined = all chats (no scope), null = unattached only,
  // a string = that project's chats. Mirrors TasksRepo.list semantics.
  list(projectId?: string | null): ChatSummary[] {
    if (projectId === undefined) return this.listStmt.all() as ChatSummary[]
    if (projectId === null) return this.listUnattachedStmt.all() as ChatSummary[]
    return this.listByProjectStmt.all({ project_id: projectId }) as ChatSummary[]
  }

  rename(id: string, title: string): void {
    this.renameStmt.run({ id, title, updated_at: new Date().toISOString() })
  }

  /** Move a chat to a project (or to "Unfiled" with projectId = null). */
  setProject(id: string, projectId: string | null): void {
    this.setProjectStmt.run({ id, project_id: projectId, updated_at: new Date().toISOString() })
  }

  // Bump updated_at to now — called when a new message lands so the chat floats
  // to the top of the history list.
  touch(id: string): void {
    this.touchStmt.run({ id, updated_at: new Date().toISOString() })
  }

  // Messages are removed by the ON DELETE CASCADE foreign key.
  delete(id: string): void {
    this.deleteStmt.run(id)
  }
}
