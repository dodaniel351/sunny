import type { Migration, MigrationDb } from '../migrate'

// Incognito chats (0.5.6): a per-chat flag that keeps the conversation out of
// the memory system — no auto-memory capture, no memory recall injection, no
// content-derived title. Additive defaulted column so existing rows migrate
// cleanly (every existing chat stays a normal, memory-participating chat).
function up(db: MigrationDb): void {
  db.exec(`ALTER TABLE chats ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0`)
}

export const migration009: Migration = {
  version: 9,
  name: 'chat_incognito',
  up
}
