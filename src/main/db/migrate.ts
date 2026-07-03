// Versioned migration runner (spec §10 — "write a versioned migration runner
// before the first table").
//
// Why backend-agnostic: better-sqlite3 + sqlite-vec are compiled for Electron's
// ABI and crash when imported under Vitest's system-Node runtime. So the runner
// depends on nothing native — it takes a minimal injected `MigrationDb` and the
// real connection (src/main/db/database.ts) supplies a better-sqlite3 instance
// at runtime, while tests supply an in-memory fake. This keeps the runner's
// logic (ordering, idempotency, version tracking) unit-testable in isolation.

/** Prepared-statement shape — the slice of better-sqlite3 the runner relies on. */
export interface MigrationStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

/**
 * The smallest DB surface the runner needs. better-sqlite3's `Database`
 * structurally satisfies this, and so does the test fake — neither has to know
 * about the other.
 */
export interface MigrationDb {
  exec(sql: string): void
  prepare(sql: string): MigrationStatement
  /**
   * Wrap a zero-arg function so it runs atomically, returning the wrapped
   * callable. Kept non-generic (the runner only ever wraps a `() => void`) so
   * better-sqlite3's `Database` structurally satisfies it without a cast — a
   * generic `<T>(fn: T): T` can't accept better-sqlite3's `Transaction<T>`
   * intersection return type. The in-memory test fake satisfies it too.
   */
  transaction(fn: () => void): () => void
}

/** A single migration: applied once, in ascending `version` order. */
export interface Migration {
  version: number
  name: string
  up(db: MigrationDb): void
}

export interface MigrationResult {
  /** Versions applied during THIS run (empty when already up to date). */
  applied: number[]
  /** Highest applied version after the run (0 when none applied ever). */
  currentVersion: number
}

const MIGRATIONS_TABLE = '_migrations'

/** Ensure the bookkeeping table exists. Safe to call repeatedly. */
function ensureMigrationsTable(db: MigrationDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`
  )
}

/** Versions already recorded as applied. */
function appliedVersions(db: MigrationDb): Set<number> {
  const rows = db.prepare(`SELECT version FROM ${MIGRATIONS_TABLE}`).all() as Array<{
    version: number
  }>
  return new Set(rows.map((r) => r.version))
}

/**
 * Apply all pending migrations in ascending version order, each recorded in
 * `_migrations`. Idempotent: a second run with the same list is a no-op.
 *
 * Each migration runs inside its own transaction so a failure leaves the DB at
 * the last good version rather than half-migrated (per-migration atomicity).
 */
export function runMigrations(db: MigrationDb, migrations: Migration[]): MigrationResult {
  ensureMigrationsTable(db)

  // Guard against duplicate version numbers — a programming error that would
  // otherwise silently skip a migration.
  const seen = new Set<number>()
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`)
    }
    seen.add(m.version)
  }

  const done = appliedVersions(db)
  const pending = migrations
    .filter((m) => !done.has(m.version))
    .sort((a, b) => a.version - b.version)

  const recordStmt = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`
  )

  const applied: number[] = []
  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db)
      recordStmt.run(migration.version, migration.name, new Date().toISOString())
    })
    apply()
    applied.push(migration.version)
  }

  return { applied, currentVersion: getCurrentVersion(db) }
}

/** Highest applied migration version, or 0 if none have run. */
export function getCurrentVersion(db: MigrationDb): number {
  ensureMigrationsTable(db)
  const row = db.prepare(`SELECT MAX(version) AS v FROM ${MIGRATIONS_TABLE}`).get() as {
    v: number | null
  }
  return row?.v ?? 0
}
