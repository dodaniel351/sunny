import type { Migration, MigrationDb } from '../migrate'

// Per-agent web access (spec §7). When an agent runs autonomously on the board
// (the task worker), this flag decides whether it may search the web — natively
// on a web-capable model, otherwise via Sunny's own keyless web tools. Defaults
// off so web access stays opt-in/manual. Additive, NOT NULL with a default.
function up(db: MigrationDb): void {
  db.exec(`ALTER TABLE agents ADD COLUMN web_access INTEGER NOT NULL DEFAULT 0`)
}

export const migration004: Migration = {
  version: 4,
  name: 'agent_web_access',
  up
}
