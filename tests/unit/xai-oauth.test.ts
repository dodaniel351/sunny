import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildPkce,
  normalizeTokenResponse,
  xaiTokensExpired,
  type XaiTokens
} from '@main/oauth/xai'

// Pure-logic tests only: PKCE generation, the token-response normalizer, and the
// expiry predicate. No node:http server, no real network, no electron — the
// loopback flow itself is exercised by integration/manual testing, not here.

/** RFC 4648 base64url (no padding) — mirror the encoding the module uses. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

describe('buildPkce', () => {
  it('produces a base64url verifier of at least 43 chars', () => {
    const { verifier } = buildPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier).toMatch(BASE64URL_RE)
  })

  it('produces a challenge equal to base64url(SHA256(verifier))', () => {
    const { verifier, challenge } = buildPkce()
    const expected = base64url(createHash('sha256').update(verifier).digest())
    expect(challenge).toBe(expected)
    expect(challenge).toMatch(BASE64URL_RE)
  })

  it('generates a fresh verifier on each call', () => {
    expect(buildPkce().verifier).not.toBe(buildPkce().verifier)
  })
})

describe('normalizeTokenResponse', () => {
  it('maps a full response and computes expiresAt from expires_in', () => {
    const now = 1_000_000
    const tokens = normalizeTokenResponse(
      {
        access_token: 'acc',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid api:access'
      },
      now
    )
    expect(tokens).toEqual({
      accessToken: 'acc',
      refreshToken: 'ref',
      expiresAt: now + 3600 * 1000,
      tokenType: 'Bearer',
      scope: 'openid api:access'
    })
  })

  it('throws when access_token is missing or empty', () => {
    expect(() => normalizeTokenResponse({})).toThrow()
    expect(() => normalizeTokenResponse({ access_token: '' })).toThrow()
  })

  it('omits expiresAt when expires_in is absent or non-numeric', () => {
    expect(normalizeTokenResponse({ access_token: 'a' }).expiresAt).toBeUndefined()
    expect(
      normalizeTokenResponse({ access_token: 'a', expires_in: 'soon' as unknown as number })
        .expiresAt
    ).toBeUndefined()
  })

  it('keeps the previous refresh token when the response omits one (refresh case)', () => {
    const previous: XaiTokens = { accessToken: 'old', refreshToken: 'keep-me' }
    const tokens = normalizeTokenResponse({ access_token: 'new', expires_in: 60 }, 0, previous)
    expect(tokens.accessToken).toBe('new')
    expect(tokens.refreshToken).toBe('keep-me')
  })

  it('prefers a new refresh token over the previous one', () => {
    const previous: XaiTokens = { accessToken: 'old', refreshToken: 'old-ref' }
    const tokens = normalizeTokenResponse(
      { access_token: 'new', refresh_token: 'new-ref' },
      0,
      previous
    )
    expect(tokens.refreshToken).toBe('new-ref')
  })
})

describe('xaiTokensExpired', () => {
  const now = Date.now()

  it('treats a token without expiresAt as not expired', () => {
    expect(xaiTokensExpired({ accessToken: 'a' })).toBe(false)
  })

  it('reports an already-past expiry as expired', () => {
    expect(xaiTokensExpired({ accessToken: 'a', expiresAt: now - 1000 })).toBe(true)
  })

  it('reports a comfortably-future expiry as valid', () => {
    expect(xaiTokensExpired({ accessToken: 'a', expiresAt: now + 10 * 60 * 1000 })).toBe(false)
  })

  it('reports a token within the default 120s skew as expired', () => {
    expect(xaiTokensExpired({ accessToken: 'a', expiresAt: now + 60 * 1000 })).toBe(true)
  })

  it('honors a custom skew', () => {
    const expiresAt = now + 5 * 60 * 1000
    expect(xaiTokensExpired({ accessToken: 'a', expiresAt }, 1000)).toBe(false)
    expect(xaiTokensExpired({ accessToken: 'a', expiresAt }, 10 * 60 * 1000)).toBe(true)
  })
})
