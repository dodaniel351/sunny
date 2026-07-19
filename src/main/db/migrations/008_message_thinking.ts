import type { Migration, MigrationDb } from '../migrate'

// Reasoning display (0.5.5): persist the model's thinking (Anthropic adaptive-
// thinking summaries, Gemini thought summaries, reasoning fields / <think>
// blocks on local models) alongside the answer, so the collapsible "Thinking"
// section survives a reload. Additive nullable column — existing rows migrate
// cleanly, and the FTS mirror's triggers are unaffected by ADD COLUMN.
function up(db: MigrationDb): void {
  db.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`)
}

export const migration008: Migration = {
  version: 8,
  name: 'message_thinking',
  up
}
