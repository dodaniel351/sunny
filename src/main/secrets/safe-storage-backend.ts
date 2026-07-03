import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { KeychainBackend } from './backend'

// Fallback backend for platforms/sessions where keytar is unavailable. Electron's
// safeStorage only encrypts/decrypts buffers — it does not persist anything — so
// THIS backend owns the storage: an encrypted JSON map written under the app's
// userData dir. Plaintext is never written; each value is encrypted by
// safeStorage and base64-encoded before it touches disk (spec §2).
//
// safeStorage lives only in the Electron runtime, so it is imported lazily at
// call time (see `loadSafeStorage`). The userData dir is injected via the
// constructor rather than read from `app`, keeping this module decoupled from
// electron for as long as possible.

const SECRETS_FILE = 'secrets.enc.json'

// Minimal slice of Electron's safeStorage we depend on. Declared locally so the
// module type-checks without importing electron's types at the top level.
interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

// Lazy require so loading this file outside Electron does not pull in electron.
function loadSafeStorage(): SafeStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as { safeStorage: SafeStorage }
  return electron.safeStorage
}

// On-disk shape: id → base64(ciphertext). Only ever ciphertext, never plaintext.
type EncryptedMap = Record<string, string>

export class SafeStorageBackend implements KeychainBackend {
  readonly #filePath: string

  constructor(userDataDir: string) {
    this.#filePath = join(userDataDir, SECRETS_FILE)
  }

  // Synchronous selection-time probe: confirms safeStorage can actually encrypt
  // on this session. Throws otherwise so the factory falls through to
  // 'unavailable' rather than choosing a backend that can't store anything.
  ensureAvailable(): void {
    this.#requireEncryption(loadSafeStorage())
  }

  // Surface a clear error so the factory can decide to fall through to
  // 'unavailable' rather than silently writing recoverable (unencrypted) data.
  #requireEncryption(safeStorage: SafeStorage): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is not available on this platform/session')
    }
  }

  #readMap(): EncryptedMap {
    if (!existsSync(this.#filePath)) return {}
    const raw = readFileSync(this.#filePath, 'utf-8')
    if (raw.trim() === '') return {}
    return JSON.parse(raw) as EncryptedMap
  }

  #writeMap(map: EncryptedMap): void {
    const dir = join(this.#filePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.#filePath, JSON.stringify(map), 'utf-8')
  }

  setSecret(id: string, value: string): void {
    const safeStorage = loadSafeStorage()
    this.#requireEncryption(safeStorage)
    const map = this.#readMap()
    // Encrypt, then base64 the raw ciphertext buffer for safe JSON storage.
    map[id] = safeStorage.encryptString(value).toString('base64')
    this.#writeMap(map)
  }

  getSecret(id: string): string | null {
    const safeStorage = loadSafeStorage()
    this.#requireEncryption(safeStorage)
    const map = this.#readMap()
    const encoded = map[id]
    if (encoded === undefined) return null
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  }

  deleteSecret(id: string): void {
    const map = this.#readMap()
    if (!(id in map)) return
    delete map[id]
    this.#writeMap(map)
  }

  listIds(): string[] {
    // Keys are the opaque ids; values (ciphertext) are never returned here.
    return Object.keys(this.#readMap())
  }
}
