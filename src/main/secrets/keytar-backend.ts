import type { KeychainBackend } from './backend'
import { SECRET_SERVICE } from './secret-store'

// IMPORTANT: keytar is compiled against Electron's ABI — it loads only inside
// the Electron runtime. keytar is required LAZILY in the constructor (not at
// module top level) for two reasons: (1) static-importing this class from the
// factory must not eagerly load native code on platforms where keytar/libsecret
// is absent — construction throws there and the factory falls back; (2) the
// relative module must survive bundling (electron-vite inlines local files but
// keeps `keytar` external, so `require('keytar')` resolves at runtime).
//
// Mapping to the OS credential store: service = 'Sunny', account = opaque id,
// password = the secret value. findCredentials(service) gives us the id list.

type Keytar = typeof import('keytar')

function loadKeytar(): Keytar {
  // Lazy CommonJS require of the externalized native module (main builds to CJS).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('keytar') as Keytar
}

export class KeytarBackend implements KeychainBackend {
  readonly #keytar: Keytar

  // Throws synchronously if keytar's native binding cannot load, letting the
  // factory catch it and fall back to safeStorage.
  constructor() {
    this.#keytar = loadKeytar()
  }

  async setSecret(id: string, value: string): Promise<void> {
    await this.#keytar.setPassword(SECRET_SERVICE, id, value)
  }

  async getSecret(id: string): Promise<string | null> {
    return this.#keytar.getPassword(SECRET_SERVICE, id)
  }

  async deleteSecret(id: string): Promise<void> {
    // keytar returns false when nothing was deleted; we treat delete as
    // idempotent, so the boolean is intentionally ignored.
    await this.#keytar.deletePassword(SECRET_SERVICE, id)
  }

  async listIds(): Promise<string[]> {
    // findCredentials returns { account, password }[] for the service. We map to
    // accounts (ids) only and never surface the passwords from here.
    const credentials = await this.#keytar.findCredentials(SECRET_SERVICE)
    return credentials.map((credential) => credential.account)
  }
}
