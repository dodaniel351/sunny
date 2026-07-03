// xAI (Grok) subscription OAuth — loopback + PKCE (Phase 4).
//
// This is the "no API key" path: the user signs in with their xAI subscription
// and we receive an OAuth access token that the existing OpenAI-compatible chat
// adapter uses as the `Authorization: Bearer` value against https://api.x.ai/v1
// (the API treats an OAuth access token and a raw API key identically).
//
// The flow is the standard native-app pattern (RFC 8252): a transient localhost
// HTTP server on a fixed loopback port receives the redirect, we use PKCE S256
// (the public desktop client has no secret), and `offline_access` yields a
// refresh token so the session survives access-token expiry.
//
// Decoupled from Electron on purpose: the caller injects `openUrl` (e.g.
// shell.openExternal) so this module stays a pure, unit-testable Node module
// with no electron import. NEVER log token values.

import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'

/** Normalized xAI OAuth tokens persisted by the caller (e.g. in the keychain). */
export interface XaiTokens {
  accessToken: string
  refreshToken?: string
  /** Absolute epoch ms when the access token expires (Date.now() + expires_in*1000). */
  expiresAt?: number
  tokenType?: string
  scope?: string
}

/** OAuth endpoints, resolved from discovery at runtime with a static fallback. */
interface XaiEndpoints {
  authorize: string
  token: string
}

// ── Constants (verified) ──────────────────────────────────────────────────────
const DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'

// Static fallback used when discovery is unreachable.
const FALLBACK_ENDPOINTS: XaiEndpoints = {
  authorize: 'https://auth.x.ai/oauth2/authorize',
  token: 'https://auth.x.ai/oauth2/token'
}

// Public PKCE desktop client (no secret). Shared by Hermes Agent / OpenClaw / Warp.
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

// Must be literal 127.0.0.1 on this exact port — the client registration pins it.
const REDIRECT_PORT = 56121
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`

const SCOPE = 'openid profile email offline_access grok-cli:access api:access'

// How long to wait for the browser round-trip before giving up.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

// Default clock skew when judging expiry — refresh a little early.
const DEFAULT_SKEW_MS = 120000

// ── PKCE ────────────────────────────────────────────────────────────────────

/** RFC 4648 base64url (no padding) — the encoding PKCE and OAuth state use. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Generate a PKCE verifier/challenge pair (S256). The verifier is 32 random
 * bytes → 43 base64url chars (within the 43–128 spec range); the challenge is
 * base64url(SHA256(verifier)). Exported so tests can recompute and assert.
 */
export function buildPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// ── Token-response normalization ──────────────────────────────────────────────

/** The raw token-endpoint JSON shape we read (snake_case per OAuth spec). */
interface RawTokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  token_type?: unknown
  scope?: unknown
}

/**
 * Pure mapping from a raw token-endpoint response to `XaiTokens`. Factored out
 * (and exported) so it can be unit-tested without any network. `now` is
 * injectable for deterministic `expiresAt` assertions. `previous` lets a refresh
 * keep the prior refresh token when the response omits a new one.
 *
 * Throws if `access_token` is missing/empty — a token response without one is
 * unusable and we must not produce an `XaiTokens` with an empty credential.
 */
export function normalizeTokenResponse(
  raw: RawTokenResponse,
  now: number = Date.now(),
  previous?: XaiTokens
): XaiTokens {
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : ''
  if (accessToken === '') {
    throw new Error('xAI token response did not contain an access_token')
  }

  const tokens: XaiTokens = { accessToken }

  // Prefer a fresh refresh token; otherwise fall back to the previous one.
  const refreshToken =
    typeof raw.refresh_token === 'string' && raw.refresh_token !== ''
      ? raw.refresh_token
      : previous?.refreshToken
  if (refreshToken) tokens.refreshToken = refreshToken

  if (typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)) {
    tokens.expiresAt = now + raw.expires_in * 1000
  }
  if (typeof raw.token_type === 'string') tokens.tokenType = raw.token_type
  if (typeof raw.scope === 'string') tokens.scope = raw.scope

  return tokens
}

/**
 * True when the access token is expired or will expire within `skewMs`. Tokens
 * with no `expiresAt` are treated as NOT expired (we have no basis to refresh
 * proactively — let an actual 401 drive a refresh instead).
 */
export function xaiTokensExpired(tokens: XaiTokens, skewMs: number = DEFAULT_SKEW_MS): boolean {
  if (typeof tokens.expiresAt !== 'number') return false
  return Date.now() + skewMs >= tokens.expiresAt
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/** Fetch the OIDC discovery doc; fall back to the static endpoints on any failure. */
async function resolveEndpoints(signal?: AbortSignal): Promise<XaiEndpoints> {
  try {
    const response = await fetch(DISCOVERY_URL, {
      headers: { accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(8000)
    })
    if (!response.ok) return FALLBACK_ENDPOINTS
    const doc = (await response.json()) as {
      authorization_endpoint?: unknown
      token_endpoint?: unknown
    }
    const authorize =
      typeof doc.authorization_endpoint === 'string'
        ? doc.authorization_endpoint
        : FALLBACK_ENDPOINTS.authorize
    const token =
      typeof doc.token_endpoint === 'string' ? doc.token_endpoint : FALLBACK_ENDPOINTS.token
    return { authorize, token }
  } catch {
    return FALLBACK_ENDPOINTS
  }
}

// ── Token exchange / refresh ────────────────────────────────────────────────

/** POST a urlencoded body to the token endpoint and normalize the response. */
async function postToken(
  tokenUrl: string,
  body: URLSearchParams,
  signal?: AbortSignal,
  previous?: XaiTokens
): Promise<XaiTokens> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: body.toString(),
    signal
  })

  if (!response.ok) {
    // Read the body for an OAuth error description without leaking secrets (the
    // request body is what carries the code/verifier, not the response).
    let detail = `${response.status} ${response.statusText}`
    try {
      const text = await response.text()
      if (text.trim() !== '') detail = text.trim()
    } catch {
      // Ignore — fall back to the status line.
    }
    throw new Error(`xAI token request failed: ${detail}`)
  }

  const raw = (await response.json()) as RawTokenResponse
  return normalizeTokenResponse(raw, Date.now(), previous)
}

/** Exchange an authorization code for tokens (PKCE: send the verifier). */
async function exchangeCode(
  tokenUrl: string,
  code: string,
  codeVerifier: string,
  signal?: AbortSignal
): Promise<XaiTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier
  })
  return postToken(tokenUrl, body, signal)
}

/**
 * Refresh an access token using the stored refresh token. If the server omits a
 * new refresh token, `normalizeTokenResponse` keeps the existing one.
 */
export async function refreshXai(tokens: XaiTokens): Promise<XaiTokens> {
  if (!tokens.refreshToken) {
    throw new Error('Cannot refresh xAI session: no refresh token')
  }
  const endpoints = await resolveEndpoints()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID
  })
  return postToken(endpoints.token, body, undefined, tokens)
}

// ── Login (loopback + PKCE) ─────────────────────────────────────────────────

/** Small HTML shown in the browser after the redirect lands. */
const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Sunny</title></head>' +
  '<body style="font-family:system-ui;text-align:center;padding:3rem">' +
  '<h2>Signed in to xAI</h2><p>You can close this tab and return to Sunny.</p>' +
  '</body></html>'

const ERROR_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Sunny</title></head>' +
  '<body style="font-family:system-ui;text-align:center;padding:3rem">' +
  '<h2>Sign-in failed</h2><p>You can close this tab and return to Sunny.</p>' +
  '</body></html>'

/**
 * Run the full subscription-OAuth login: spin up the loopback server, open the
 * browser to the authorize URL, await the redirect, validate `state`, and
 * exchange the code for tokens. The HTTP server is ALWAYS torn down — on
 * success, on error, on the 5-minute timeout, and on external abort.
 */
export async function loginXai(opts: {
  openUrl: (url: string) => void
  signal?: AbortSignal
}): Promise<XaiTokens> {
  const { verifier, challenge } = buildPkce()
  const state = base64url(randomBytes(16))
  const endpoints = await resolveEndpoints(opts.signal)

  return new Promise<XaiTokens>((resolve, reject) => {
    // Single-shot settle guard: ensures the server is closed exactly once and
    // late callbacks (e.g. a second request) cannot resolve/reject twice.
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${REDIRECT_PORT}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not found')
        return
      }

      const params = url.searchParams
      const errorParam = params.get('error')
      const returnedState = params.get('state')
      const code = params.get('code')

      if (errorParam) {
        const desc = params.get('error_description')
        respond(res, ERROR_HTML)
        finish(undefined, new Error(`xAI authorization error: ${desc ?? errorParam}`))
        return
      }
      if (returnedState !== state) {
        respond(res, ERROR_HTML)
        finish(undefined, new Error('xAI OAuth state mismatch — possible CSRF, aborting'))
        return
      }
      if (!code) {
        respond(res, ERROR_HTML)
        finish(undefined, new Error('xAI callback missing authorization code'))
        return
      }

      // Show the success page immediately, then do the token exchange. The
      // exchange result settles the outer promise.
      respond(res, SUCCESS_HTML)
      exchangeCode(endpoints.token, code, verifier, opts.signal)
        .then((tokens) => finish(tokens))
        .catch((err: unknown) => finish(undefined, asError(err)))
    })

    // Settle once: clear timer, detach abort listener, close the server, then
    // resolve or reject.
    const finish = (tokens?: XaiTokens, err?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      server.close(() => {
        if (err) reject(err)
        else if (tokens) resolve(tokens)
        else reject(new Error('xAI login ended without tokens'))
      })
    }

    const onAbort = (): void => finish(undefined, new Error('xAI login aborted'))

    if (opts.signal) {
      if (opts.signal.aborted) {
        finish(undefined, new Error('xAI login aborted'))
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    server.on('error', (err) => finish(undefined, asError(err)))

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      timer = setTimeout(
        () => finish(undefined, new Error('xAI login timed out')),
        LOGIN_TIMEOUT_MS
      )

      const authUrl = new URL(endpoints.authorize)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', CLIENT_ID)
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
      authUrl.searchParams.set('scope', SCOPE)
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')

      try {
        opts.openUrl(authUrl.toString())
      } catch (err) {
        finish(undefined, asError(err))
      }
    })
  })
}

/** Write a small HTML page to the browser. */
function respond(res: import('node:http').ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

/** Coerce an unknown thrown value into an Error. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
