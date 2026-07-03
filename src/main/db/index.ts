// Public barrel for the database layer. The main process imports from here.
//
// IMPORTANT: this re-exports database.ts, which pulls in the native
// better-sqlite3 / sqlite-vec modules — so this barrel must only be imported
// inside Electron, never from a Vitest unit test. Tests import migrate.ts (and
// shared types) directly, neither of which touches native code.

import type { MigrationDb } from './migrate'
import { getCurrentVersion } from './migrate'

export { openDatabase, initDatabase, getDb, closeDatabase } from './database'
export type { SunnyDatabase } from './database'
export { runMigrations, getCurrentVersion } from './migrate'
export type { Migration, MigrationDb, MigrationResult, MigrationStatement } from './migrate'
export { migrations, DEFAULT_EMBEDDING_DIM } from './migrations'

export interface DbHealth {
  currentVersion: number
  tables: string[]
  /** Whether the sqlite-vec extension is loaded and responding. */
  vecAvailable: boolean
}

/**
 * Diagnostic snapshot of the database: current migration version, the list of
 * user tables, and whether sqlite-vec is live. Used by a Settings/diagnostics
 * view and to assert health at startup.
 */
export function getDbHealth(db: MigrationDb): DbHealth {
  const tableRows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as Array<{ name: string }>

  // vec_version() only resolves when the extension is loaded; guard so a missing
  // extension reports false instead of throwing.
  let vecAvailable = false
  try {
    db.prepare('SELECT vec_version() AS v').get()
    vecAvailable = true
  } catch {
    vecAvailable = false
  }

  return {
    currentVersion: getCurrentVersion(db),
    tables: tableRows.map((r) => r.name),
    vecAvailable
  }
}
