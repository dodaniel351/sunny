import { SecretStore } from './secret-store'
import { KeytarBackend } from './keytar-backend'
import { SafeStorageBackend } from './safe-storage-backend'
import type { KeychainBackend } from './backend'

// Public surface of the secrets layer. The factory picks the best available
// keychain backend at runtime; the rest of the app only ever sees a SecretStore.
export { SecretStore, SECRET_SERVICE } from './secret-store'
export type { KeychainBackend } from './backend'

export type SecretsBackendKind = 'keytar' | 'safeStorage' | 'unavailable'

export interface SecretsHealth {
  backend: SecretsBackendKind
  available: boolean
}

export interface CreateSecretStoreOptions {
  // The app's userData dir, used by the safeStorage fallback to persist its
  // encrypted file. Injected (not read from `app` here) so the factory stays
  // testable and the dependency on electron stays explicit.
  userDataDir: string
}

// The backend classes are imported statically (safe — they defer their native
// loads), but instantiating them performs the real native probe synchronously:
// `new KeytarBackend()` throws if keytar's binding can't load, and
// `ensureAvailable()` throws if safeStorage can't encrypt. Both are caught here
// so resolution falls through cleanly.
function tryCreateKeytarBackend(): KeychainBackend | null {
  try {
    // Construction loads keytar's native binding; throws if missing (e.g. no
    // libsecret on Linux), in which case we fall back.
    return new KeytarBackend()
  } catch {
    return null
  }
}

function tryCreateSafeStorageBackend(userDataDir: string): KeychainBackend | null {
  try {
    const backend = new SafeStorageBackend(userDataDir)
    // Confirm safeStorage can actually encrypt on this session before choosing it.
    backend.ensureAvailable()
    return backend
  } catch {
    return null
  }
}

// Resolution: prefer the OS keychain (keytar); fall back to safeStorage; record
// 'unavailable' if neither works so the UI can warn instead of silently failing.
function resolveBackend(userDataDir: string): {
  backend: KeychainBackend | null
  kind: SecretsBackendKind
} {
  const keytarBackend = tryCreateKeytarBackend()
  if (keytarBackend) return { backend: keytarBackend, kind: 'keytar' }

  const safeStorageBackend = tryCreateSafeStorageBackend(userDataDir)
  if (safeStorageBackend) return { backend: safeStorageBackend, kind: 'safeStorage' }

  return { backend: null, kind: 'unavailable' }
}

// Module-level so getSecretsHealth() can report the backend chosen at creation
// without re-probing (and without exposing the backend instance itself).
let activeBackendKind: SecretsBackendKind = 'unavailable'

/**
 * Build the app's SecretStore, choosing the best keychain backend available.
 * Throws if no secure backend can be initialised — the app must not fall back
 * to plaintext storage (spec §2).
 */
export function createSecretStore(opts: CreateSecretStoreOptions): SecretStore {
  const { backend, kind } = resolveBackend(opts.userDataDir)
  activeBackendKind = kind
  if (!backend) {
    throw new Error('No secure secret backend available (keytar and safeStorage both failed)')
  }
  return new SecretStore(backend)
}

// Report which backend is active and whether a secure store is usable. Useful
// for a Settings health indicator. Never exposes secrets or the backend object.
export function getSecretsHealth(): SecretsHealth {
  return {
    backend: activeBackendKind,
    available: activeBackendKind !== 'unavailable'
  }
}
