import type { SunnyDatabase } from '@main/db'
import type { Setting } from '@shared/db/types'

// Repository for `settings` rows (spec §10) — a simple key/value store. DB type
// is imported type-only so this module never loads the native binding. Prepared
// statements are built once per instance and reused.

export class SettingsRepo {
  private readonly allStmt
  private readonly getStmt
  private readonly upsertStmt

  constructor(db: SunnyDatabase) {
    this.allStmt = db.prepare(`SELECT * FROM settings ORDER BY key`)
    this.getStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`)
    // Upsert keyed on the primary key so set() is insert-or-update in one call.
    this.upsertStmt = db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updated_at`
    )
  }

  all(): Setting[] {
    return this.allStmt.all() as Setting[]
  }

  get(key: string): string | null {
    const row = this.getStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.upsertStmt.run({ key, value, updated_at: new Date().toISOString() })
  }
}
