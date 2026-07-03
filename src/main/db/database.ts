import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

// Real SQLite connection (spec §3). This is the ONLY file that imports the
// native better-sqlite3 / sqlite-vec modules, which are compiled for Electron's
// ABI — so it is loaded exclusively inside the Electron main process and NEVER
// by Vitest (which runs under system Node). The migration runner and shared
// types stay native-free so they remain testable.

export type SunnyDatabase = Database.Database

/**
 * Open the SQLite database at `filePath`, configure it for local-first use, and
 * load the sqlite-vec extension. The path is a parameter (not pulled from
 * electron here) so this stays decoupled from the app shell — the caller in the
 * main process passes `app.getPath('userData')/sunny.sqlite`.
 */
export function openDatabase(filePath: string): SunnyDatabase {
  const db = new Database(filePath)

  // WAL gives better concurrency for the main process's read/write mix and
  // survives crashes more gracefully than the default rollback journal.
  db.pragma('journal_mode = WAL')
  // Enforce the foreign keys declared across the v1 schema (off by default in
  // SQLite). Must be set per-connection.
  db.pragma('foreign_keys = ON')

  // Load the sqlite-vec loadable extension so the vec0 virtual table
  // (memory_vectors) and vec_version() are available (spec §5).
  loadVecExtension(db)

  return db
}

/**
 * Load the sqlite-vec native extension, resolving its binary correctly in a
 * PACKAGED app. sqlite-vec computes the path to vec0.{dll,so,dylib} relative to
 * its own module — which lives inside `app.asar` — but the binary is unpacked to
 * `app.asar.unpacked`, and `loadExtension` is a native dlopen that does NOT go
 * through Electron's asar path redirect. So when the path points into app.asar,
 * rewrite it to the unpacked dir. In dev (no app.asar) this is a no-op.
 */
function loadVecExtension(db: SunnyDatabase): void {
  let loadablePath = sqliteVec.getLoadablePath()
  if (loadablePath.includes('app.asar') && !loadablePath.includes('app.asar.unpacked')) {
    loadablePath = loadablePath.replace('app.asar', 'app.asar.unpacked')
  }
  db.loadExtension(loadablePath)
}

// Singleton accessor pattern. The app opens one connection for its lifetime;
// holding it here avoids threading the handle through every module.
let instance: SunnyDatabase | null = null

/**
 * Open the singleton connection. Idempotent: a second call with the database
 * already open returns the existing instance (the path is ignored once set).
 */
export function initDatabase(filePath: string): SunnyDatabase {
  if (!instance) {
    instance = openDatabase(filePath)
  }
  return instance
}

/** Get the initialized singleton, or throw if initDatabase hasn't run yet. */
export function getDb(): SunnyDatabase {
  if (!instance) {
    throw new Error('Database not initialized — call initDatabase(filePath) first')
  }
  return instance
}

/** Close and clear the singleton (used on app quit / in teardown). */
export function closeDatabase(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}
