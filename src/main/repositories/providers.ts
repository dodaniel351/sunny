import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Provider } from '@shared/db/types'

// Repository for `providers` rows (spec §2/§10). CRITICAL: these are config rows
// ONLY — never a secret. The `secret_ref` column holds an opaque keychain id, the
// sole link to a key/token that lives in the OS keychain. DB type is imported
// type-only so the native binding is never loaded here.

export interface ProviderUpsertInput {
  kind: string
  label: string
  authMethod: string
  secretRef: string | null
  baseUrl?: string
  config?: string
  enabled?: boolean
}

export class ProvidersRepo {
  private readonly insertStmt
  private readonly updateByKindStmt
  private readonly getByKindStmt
  private readonly listStmt
  private readonly setSecretRefStmt
  private readonly setEnabledStmt
  private readonly setConfigStmt
  private readonly deleteByKindStmt

  constructor(db: SunnyDatabase) {
    this.insertStmt = db.prepare(
      `INSERT INTO providers
         (id, kind, label, auth_method, secret_ref, base_url, enabled, config, created_at, updated_at)
       VALUES
         (@id, @kind, @label, @auth_method, @secret_ref, @base_url, @enabled, @config, @created_at, @updated_at)`
    )
    this.updateByKindStmt = db.prepare(
      `UPDATE providers SET
         label = @label,
         auth_method = @auth_method,
         secret_ref = @secret_ref,
         base_url = @base_url,
         enabled = @enabled,
         config = @config,
         updated_at = @updated_at
       WHERE kind = @kind`
    )
    this.getByKindStmt = db.prepare(`SELECT * FROM providers WHERE kind = ?`)
    this.listStmt = db.prepare(`SELECT * FROM providers ORDER BY created_at ASC`)
    this.setSecretRefStmt = db.prepare(
      `UPDATE providers SET secret_ref = @secret_ref, updated_at = @updated_at WHERE kind = @kind`
    )
    this.setEnabledStmt = db.prepare(
      `UPDATE providers SET enabled = @enabled, updated_at = @updated_at WHERE kind = @kind`
    )
    this.setConfigStmt = db.prepare(
      `UPDATE providers SET config = @config, updated_at = @updated_at WHERE kind = @kind`
    )
    this.deleteByKindStmt = db.prepare(`DELETE FROM providers WHERE kind = ?`)
  }

  // Insert or update the single row keyed by `kind`.
  upsertByKind(input: ProviderUpsertInput): Provider {
    const now = new Date().toISOString()
    const existing = this.getByKind(input.kind)
    const enabled = input.enabled === undefined ? (existing?.enabled ?? 1) : input.enabled ? 1 : 0

    if (existing) {
      this.updateByKindStmt.run({
        kind: input.kind,
        label: input.label,
        auth_method: input.authMethod,
        secret_ref: input.secretRef,
        base_url: input.baseUrl ?? null,
        enabled,
        config: input.config ?? null,
        updated_at: now
      })
      return this.getByKind(input.kind) as Provider
    }

    const row: Provider = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label,
      auth_method: input.authMethod,
      secret_ref: input.secretRef,
      base_url: input.baseUrl ?? null,
      enabled,
      config: input.config ?? null,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  getByKind(kind: string): Provider | null {
    return (this.getByKindStmt.get(kind) as Provider | undefined) ?? null
  }

  list(): Provider[] {
    return this.listStmt.all() as Provider[]
  }

  setSecretRef(kind: string, secretRef: string | null): void {
    this.setSecretRefStmt.run({ kind, secret_ref: secretRef, updated_at: new Date().toISOString() })
  }

  setEnabled(kind: string, enabled: boolean): void {
    this.setEnabledStmt.run({
      kind,
      enabled: enabled ? 1 : 0,
      updated_at: new Date().toISOString()
    })
  }

  // Store the provider's JSON config blob (e.g. { disabledModels: [...] }).
  setConfig(kind: string, config: string | null): void {
    this.setConfigStmt.run({ kind, config, updated_at: new Date().toISOString() })
  }

  deleteByKind(kind: string): void {
    this.deleteByKindStmt.run(kind)
  }
}
