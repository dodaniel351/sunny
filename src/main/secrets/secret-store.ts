import { randomBytes } from 'node:crypto'
import type { KeychainBackend } from './backend'

// Service namespace for every Sunny secret in the OS keychain. Matches the
// app user-model id used elsewhere so credentials are grouped under one vendor.
export const SECRET_SERVICE = 'Sunny'

// Prefix for generated opaque ids. The `providers` table (and anything else
// that references a credential) stores ONLY this id — never the secret itself
// (spec §2, §4d/§10). The id is meaningless without the keychain.
const ID_PREFIX = 'sk'

// 16 random bytes → 32 hex chars. Plenty of entropy to avoid collisions while
// staying short enough to be a comfortable DB key.
function generateId(): string {
  return `${ID_PREFIX}_${randomBytes(16).toString('hex')}`
}

/**
 * Backend-agnostic secret manager. All persistence is delegated to an injected
 * KeychainBackend (keytar in production, safeStorage as fallback, an in-memory
 * fake in tests), so this class holds no native dependency and is fully unit
 * testable.
 *
 * Secrets only ever leave this layer as opaque ids; the raw value is returned
 * exclusively from `get`. The instance deliberately exposes no secret state, so
 * logging, `toString`, or `JSON.stringify` of a store cannot leak credentials.
 */
export class SecretStore {
  // Private so the backend (and any value it might hold) is never enumerated by
  // JSON.stringify / console.log of the store instance.
  readonly #backend: KeychainBackend

  constructor(backend: KeychainBackend) {
    this.#backend = backend
  }

  /**
   * Store `value` under a freshly generated opaque id and return that id. The
   * caller persists the id (e.g. in `providers`), never the secret.
   */
  async set(value: string): Promise<string> {
    const id = generateId()
    await this.#backend.setSecret(id, value)
    return id
  }

  /**
   * Store `value` under a caller-supplied id (e.g. when re-keying an existing
   * provider). Overwrites any existing secret for that id.
   */
  async setWithId(id: string, value: string): Promise<void> {
    await this.#backend.setSecret(id, value)
  }

  // Resolve the secret for `id`, or null if there is no such entry.
  async get(id: string): Promise<string | null> {
    return this.#backend.getSecret(id)
  }

  // Remove the secret for `id`. Idempotent.
  async delete(id: string): Promise<void> {
    await this.#backend.deleteSecret(id)
  }

  // Whether a secret exists for `id`, without exposing its value.
  async has(id: string): Promise<boolean> {
    const value = await this.#backend.getSecret(id)
    return value !== null
  }

  // List stored secret ids — ids only, never values (spec §2).
  async list(): Promise<string[]> {
    return this.#backend.listIds()
  }

  // Guard against accidental disclosure: a store must never render its secrets.
  toString(): string {
    return '[SecretStore]'
  }

  // Same guard for JSON.stringify — returns a placeholder, never the backend.
  toJSON(): string {
    return '[SecretStore]'
  }
}
