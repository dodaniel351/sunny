import type { Migration, MigrationDb } from '../migrate'

// Image attachments on a message (vision support). A nullable JSON column holding
// an ImageAttachment[] (name, mediaType, dataUrl) the user attached to the turn,
// persisted so vision-capable models still see the images on later turns. The
// messages_fts triggers reference explicit columns (content/rowid), so this
// additive column does not affect full-text search. Additive + nullable.
function up(db: MigrationDb): void {
  db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`)
}

export const migration005: Migration = {
  version: 5,
  name: 'message_attachments',
  up
}
