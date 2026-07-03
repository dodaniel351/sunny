import { describe, it, expect, beforeEach } from 'vitest'
import {
  runMigrations,
  getCurrentVersion,
  type Migration,
  type MigrationDb,
  type MigrationStatement
} from '@main/db/migrate'

// These tests exercise ONLY the runner's logic (ordering, idempotency, version
// tracking) with an in-memory fake — they never import better-sqlite3 /
// sqlite-vec / keytar, and never run the real 001_init schema (which contains
// vec0/FTS5 SQL that requires the native extension). That separation is the
// whole point of the runner being backend-agnostic (see migrate.ts).

/**
 * Minimal in-memory fake of the slice of better-sqlite3 the runner uses. It
 * understands just enough SQL to track the `_migrations` table the runner
 * manages itself; migration `up()` bodies here are no-ops, so they need no SQL.
 */
function createFakeDb(): MigrationDb & { applied: Map<number, string> } {
  const applied = new Map<number, string>()

  const prepare = (sql: string): MigrationStatement => {
    const text = sql.replace(/\s+/g, ' ').trim()

    return {
      run(...params: unknown[]): unknown {
        if (text.startsWith('INSERT INTO _migrations')) {
          const [version, name] = params as [number, string]
          applied.set(version, name)
        }
        return { changes: 1 }
      },
      get(...params: unknown[]): unknown {
        void params
        if (text.includes('MAX(version)')) {
          const versions = [...applied.keys()]
          return { v: versions.length ? Math.max(...versions) : null }
        }
        return undefined
      },
      all(...params: unknown[]): unknown[] {
        void params
        if (text.startsWith('SELECT version FROM _migrations')) {
          return [...applied.keys()].map((version) => ({ version }))
        }
        return []
      }
    }
  }

  return {
    applied,
    // CREATE TABLE IF NOT EXISTS _migrations and any migration DDL are no-ops in
    // the fake — we only model the version bookkeeping.
    exec(_sql: string): void {
      void _sql
    },
    prepare,
    // Synchronous pass-through transaction wrapper, matching better-sqlite3's
    // shape (it returns a callable that runs the fn).
    transaction<T extends (...args: never[]) => unknown>(fn: T): T {
      return ((...args: never[]) => fn(...args)) as T
    }
  }
}

/** Build a no-op migration that records the order its `up()` ran. */
function makeMigration(version: number, name: string, order: number[]): Migration {
  return {
    version,
    name,
    up() {
      order.push(version)
    }
  }
}

describe('runMigrations', () => {
  let db: ReturnType<typeof createFakeDb>

  beforeEach(() => {
    db = createFakeDb()
  })

  it('applies all pending migrations and records their versions', () => {
    const order: number[] = []
    const migrations = [
      makeMigration(1, 'init', order),
      makeMigration(2, 'add_x', order)
    ]

    const result = runMigrations(db, migrations)

    expect(result.applied).toEqual([1, 2])
    expect(result.currentVersion).toBe(2)
    expect([...db.applied.keys()].sort((a, b) => a - b)).toEqual([1, 2])
    expect(order).toEqual([1, 2])
  })

  it('applies migrations in ascending version order regardless of input order', () => {
    const order: number[] = []
    const migrations = [
      makeMigration(3, 'third', order),
      makeMigration(1, 'first', order),
      makeMigration(2, 'second', order)
    ]

    const result = runMigrations(db, migrations)

    expect(order).toEqual([1, 2, 3])
    expect(result.applied).toEqual([1, 2, 3])
    expect(result.currentVersion).toBe(3)
  })

  it('is idempotent: re-running with the same list applies nothing', () => {
    const order: number[] = []
    const migrations = [makeMigration(1, 'init', order), makeMigration(2, 'add_x', order)]

    runMigrations(db, migrations)
    const second = runMigrations(db, migrations)

    expect(second.applied).toEqual([])
    expect(second.currentVersion).toBe(2)
    // up() ran exactly once per migration across both runs.
    expect(order).toEqual([1, 2])
  })

  it('applies only the newly-added migration on a later run', () => {
    const order: number[] = []
    const v1 = [makeMigration(1, 'init', order)]
    runMigrations(db, v1)

    const v2 = [...v1, makeMigration(2, 'add_x', order)]
    const result = runMigrations(db, v2)

    expect(result.applied).toEqual([2])
    expect(result.currentVersion).toBe(2)
    expect(order).toEqual([1, 2])
  })

  it('handles an empty migration list', () => {
    const result = runMigrations(db, [])

    expect(result.applied).toEqual([])
    expect(result.currentVersion).toBe(0)
  })

  it('throws on duplicate version numbers', () => {
    const order: number[] = []
    const migrations = [makeMigration(1, 'a', order), makeMigration(1, 'b', order)]

    expect(() => runMigrations(db, migrations)).toThrow(/Duplicate migration version: 1/)
  })
})

describe('getCurrentVersion', () => {
  it('returns 0 for a fresh database', () => {
    const db = createFakeDb()
    expect(getCurrentVersion(db)).toBe(0)
  })

  it('returns the highest applied version', () => {
    const db = createFakeDb()
    const order: number[] = []
    runMigrations(db, [makeMigration(1, 'a', order), makeMigration(5, 'b', order)])
    expect(getCurrentVersion(db)).toBe(5)
  })
})
