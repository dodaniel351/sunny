import { describe, it, expect } from 'vitest'
import { migrations } from '@main/db/migrations'
import { migration006 } from '@main/db/migrations/006_org_layer'
import { runMigrations, type MigrationDb, type MigrationStatement } from '@main/db/migrate'

// These tests stay native-free (no better-sqlite3 / sqlite-vec): migration `up()`
// bodies are plain `db.exec(sql)` strings, so a fake that records the SQL it's
// asked to run can assert the DDL is correct without a real engine. The same
// separation the runner is designed for (see migrate.ts / migrate.test.ts).

/**
 * A MigrationDb fake that captures every exec()'d SQL string AND models just
 * enough of the `_migrations` bookkeeping table for the runner's version
 * tracking (mirrors the fake in migrate.test.ts). Migration DDL is recorded but
 * not executed — no native engine involved.
 */
function createRecordingDb(): MigrationDb & { sql: string[] } {
  const sql: string[] = []
  const applied = new Map<number, string>()
  const prepare = (text: string): MigrationStatement => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    return {
      run(...params: unknown[]): unknown {
        if (normalized.startsWith('INSERT INTO _migrations')) {
          const [version, name] = params as [number, string]
          applied.set(version, name)
        }
        return { changes: 1 }
      },
      get(): unknown {
        if (normalized.includes('MAX(version)')) {
          const versions = [...applied.keys()]
          return { v: versions.length ? Math.max(...versions) : null }
        }
        return undefined
      },
      all(): unknown[] {
        if (normalized.startsWith('SELECT version FROM _migrations')) {
          return [...applied.keys()].map((version) => ({ version }))
        }
        return []
      }
    }
  }
  return {
    sql,
    exec(text: string): void {
      sql.push(text)
    },
    prepare,
    transaction(fn: () => void): () => void {
      return () => fn()
    }
  }
}

describe('migrations registry', () => {
  it('has unique, gapless ascending versions starting at 1', () => {
    const versions = migrations.map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length) // unique
    const sorted = [...versions].sort((a, b) => a - b)
    expect(sorted).toEqual(versions) // already ascending in the array
    expect(sorted[0]).toBe(1)
    expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1)) // gapless
  })

  it('registers migration 006 (org_layer)', () => {
    const found = migrations.find((m) => m.version === 6)
    expect(found).toBe(migration006)
    expect(found?.name).toBe('org_layer')
  })

  it('applies the full chain through the runner without error', () => {
    // The recording fake no-ops the DDL, so this exercises ordering + version
    // bookkeeping over the real migration list (currently 1..6).
    const db = createRecordingDb()
    const result = runMigrations(db, migrations)
    expect(result.applied).toEqual(migrations.map((m) => m.version))
    expect(result.currentVersion).toBe(migrations.length)
  })
})

describe('migration 006 — org layer schema', () => {
  it('creates the new structure-layer tables', () => {
    const db = createRecordingDb()
    migration006.up(db)
    const all = db.sql.join('\n')
    for (const table of [
      'budgets',
      'goals',
      'task_dependencies',
      'cost_events',
      'activity_events',
      'approvals'
    ]) {
      expect(all).toContain(`CREATE TABLE ${table}`)
    }
  })

  it('adds the execution-lock columns to tasks and cost columns to runs', () => {
    const db = createRecordingDb()
    migration006.up(db)
    const all = db.sql.join('\n')
    expect(all).toContain('ALTER TABLE tasks ADD COLUMN locked_by')
    expect(all).toContain('ALTER TABLE tasks ADD COLUMN goal_id')
    expect(all).toContain('ALTER TABLE tasks ADD COLUMN wake_at')
    expect(all).toContain('ALTER TABLE runs ADD COLUMN cost_usd')
    expect(all).toContain('ALTER TABLE agents ADD COLUMN manager_id')
  })

  it('creates referenced tables (budgets, goals) before the columns that FK them', () => {
    const db = createRecordingDb()
    migration006.up(db)
    const indexOf = (needle: string): number => db.sql.findIndex((s) => s.includes(needle))
    // budgets must exist before agents.budget_id references it; goals before tasks.goal_id.
    expect(indexOf('CREATE TABLE budgets')).toBeLessThan(indexOf('ADD COLUMN budget_id'))
    expect(indexOf('CREATE TABLE goals')).toBeLessThan(indexOf('ALTER TABLE tasks ADD COLUMN goal_id'))
  })
})
