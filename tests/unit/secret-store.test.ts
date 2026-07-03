import { describe, it, expect, beforeEach } from 'vitest'
import { SecretStore } from '@main/secrets/secret-store'
import type { KeychainBackend } from '@main/secrets/backend'

// In-memory fake backend. The whole point of SecretStore's injected-backend
// design: we exercise the real store logic here WITHOUT importing keytar or
// electron (both crash under system Node — see vitest.config.ts).
class FakeBackend implements KeychainBackend {
  readonly store = new Map<string, string>()

  setSecret(id: string, value: string): void {
    this.store.set(id, value)
  }

  getSecret(id: string): string | null {
    return this.store.has(id) ? (this.store.get(id) as string) : null
  }

  deleteSecret(id: string): void {
    this.store.delete(id)
  }

  listIds(): string[] {
    return [...this.store.keys()]
  }
}

describe('SecretStore', () => {
  let backend: FakeBackend
  let store: SecretStore

  beforeEach(() => {
    backend = new FakeBackend()
    store = new SecretStore(backend)
  })

  it('set returns a freshly generated opaque id (sk_ prefix), not the value', async () => {
    const id = await store.set('super-secret-key')
    expect(id).toMatch(/^sk_[0-9a-f]{32}$/)
    expect(id).not.toContain('super-secret-key')
  })

  it('get returns the stored value for its id', async () => {
    const id = await store.set('value-123')
    expect(await store.get(id)).toBe('value-123')
  })

  it('get returns null for an unknown id', async () => {
    expect(await store.get('sk_does_not_exist')).toBeNull()
  })

  it('two set calls yield different ids', async () => {
    const idA = await store.set('a')
    const idB = await store.set('b')
    expect(idA).not.toBe(idB)
    expect(await store.get(idA)).toBe('a')
    expect(await store.get(idB)).toBe('b')
  })

  it('setWithId stores under a caller-supplied id and overwrites', async () => {
    await store.setWithId('sk_fixed', 'first')
    expect(await store.get('sk_fixed')).toBe('first')
    await store.setWithId('sk_fixed', 'second')
    expect(await store.get('sk_fixed')).toBe('second')
  })

  it('delete removes the secret and is idempotent', async () => {
    const id = await store.set('to-delete')
    await store.delete(id)
    expect(await store.get(id)).toBeNull()
    // Deleting again must not throw.
    await expect(store.delete(id)).resolves.toBeUndefined()
  })

  it('has reflects presence without exposing the value', async () => {
    const id = await store.set('present')
    expect(await store.has(id)).toBe(true)
    await store.delete(id)
    expect(await store.has(id)).toBe(false)
    expect(await store.has('sk_never')).toBe(false)
  })

  it('list returns ids only, never values', async () => {
    const idA = await store.set('secret-A')
    const idB = await store.set('secret-B')
    const ids = await store.list()
    expect(ids).toHaveLength(2)
    expect(ids).toEqual(expect.arrayContaining([idA, idB]))
    // No raw secret value may appear in the id list.
    expect(ids).not.toContain('secret-A')
    expect(ids).not.toContain('secret-B')
  })

  it('does not expose raw secrets via toString / JSON / console formatting', async () => {
    await store.set('top-secret-token')

    expect(store.toString()).toBe('[SecretStore]')
    expect(JSON.stringify(store)).toBe('"[SecretStore]"')

    // Enumerating the instance must not leak the backend or any secret value.
    const serialized = JSON.stringify(store)
    expect(serialized).not.toContain('top-secret-token')
    expect(Object.keys(store)).toHaveLength(0)
  })
})
