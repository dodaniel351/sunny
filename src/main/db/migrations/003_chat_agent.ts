import type { Migration, MigrationDb } from '../migrate'

// Associate a chat with an agent (spec §7). When set, the chat runs with that
// agent's system prompt/persona injected — used by the dashboard preset cards
// and by "Work this task" on the Kanban board (assign an agent to a task, then
// work it in a chat). Additive, nullable column.
function up(db: MigrationDb): void {
  db.exec(`ALTER TABLE chats ADD COLUMN agent_id TEXT`)
}

export const migration003: Migration = {
  version: 3,
  name: 'chat_agent',
  up
}
