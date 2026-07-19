import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Message, MessageRole } from '@shared/db/types'

// Repository for `messages` rows (spec §8). DB type is imported type-only so the
// native binding is never loaded here. The FTS5 mirror is kept in sync by the
// triggers declared in the migration, so plain INSERT/DELETE is enough.

export interface MessageCreateInput {
  id?: string
  chatId: string
  role: MessageRole
  content: string
  provider?: string
  model?: string
  toolCalls?: string
  runId?: string
  /** JSON-encoded ImageAttachment[] the user attached to this turn. */
  attachments?: string
  /** The model's reasoning for this turn (thinking summaries / <think> text). */
  thinking?: string
}

export class MessagesRepo {
  private readonly insertStmt
  private readonly listByChatStmt
  private readonly getStmt

  constructor(db: SunnyDatabase) {
    this.insertStmt = db.prepare(
      `INSERT INTO messages (id, chat_id, role, content, provider, model, tool_calls, run_id, attachments, thinking, created_at)
       VALUES (@id, @chat_id, @role, @content, @provider, @model, @tool_calls, @run_id, @attachments, @thinking, @created_at)`
    )
    this.listByChatStmt = db.prepare(
      `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC`
    )
    this.getStmt = db.prepare(`SELECT * FROM messages WHERE id = ?`)
  }

  create(input: MessageCreateInput): Message {
    const row: Message = {
      id: input.id ?? randomUUID(),
      chat_id: input.chatId,
      role: input.role,
      content: input.content,
      provider: input.provider ?? null,
      model: input.model ?? null,
      tool_calls: input.toolCalls ?? null,
      run_id: input.runId ?? null,
      attachments: input.attachments ?? null,
      thinking: input.thinking ?? null,
      created_at: new Date().toISOString()
    }
    this.insertStmt.run(row)
    return row
  }

  listByChat(chatId: string): Message[] {
    return this.listByChatStmt.all(chatId) as Message[]
  }

  get(id: string): Message | null {
    return (this.getStmt.get(id) as Message | undefined) ?? null
  }
}
