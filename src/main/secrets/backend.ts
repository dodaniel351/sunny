// The keychain backend contract. SecretStore is written against this interface
// only, so its logic can be unit-tested with an in-memory fake — keytar
// (Electron ABI) and Electron's safeStorage never have to be imported in tests.
//
// Implementations key every secret by an opaque id (the `account` in keychain
// terms). The id is the only thing that ever leaves this layer in plaintext;
// the secret value itself is returned solely on an explicit `getSecret` call.
export interface KeychainBackend {
  // Store (or overwrite) the secret for `id`.
  setSecret(id: string, value: string): Promise<void> | void
  // Return the secret for `id`, or null if there is no entry.
  getSecret(id: string): Promise<string | null> | string | null
  // Remove the secret for `id`. No-op if it does not exist.
  deleteSecret(id: string): Promise<void> | void
  // List the ids of every stored secret — ids only, never values.
  listIds(): Promise<string[]> | string[]
}
