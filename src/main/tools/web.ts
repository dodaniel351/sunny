// Sunny's OWN web tools, handed to models that have no native web search of
// their own — local Ollama, and the chat/completions providers (Grok /
// OpenRouter / Groq) — via OpenAI-style function calling. With these a
// fully-local model can still search and read the web; no cloud handoff needed.
//
// `web_search` is keyless by default: it hits the DuckDuckGo HTML endpoint (no
// API key, no token) and parses the ranked organic results. Optionally, the
// user can configure an API search provider (Tavily or Brave) via
// `configureWebSearch()` in `./search-config` for higher-quality results — any
// failure there (missing key, non-2xx, network error, empty results) silently
// falls back to the DDG path so search never breaks outright.
// `web_fetch` pulls one page and reduces it to readable text.
//
// This module is PURE fetch + parse — it imports no electron, DB, secrets, or
// repositories (only the dependency-free `./search-config`) — so it stays
// unit-testable and safe to import anywhere in the main process.
//
// Verified live 2026-06-17: html.duckduckgo.com/html requires a browser-like
// User-Agent (else 403) and wraps each result href in a `/l/?uddg=<enc>`
// redirect that must be decoded back to the real URL.

import type { ToolSpec, ToolCall } from '@main/providers/types'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { getSearchConfig } from './search-config'

const SEARCH_URL = 'https://html.duckduckgo.com/html/'
// Lite, no-JS fallback endpoint. When the primary html endpoint serves a
// block/challenge page (0 parseable results) we retry here before giving up —
// transient blocks rarely hit both at once. Both are fixed, trusted public
// hosts (constants), so like SEARCH_URL they skip the SSRF check.
const SEARCH_LITE_URL = 'https://lite.duckduckgo.com/lite/'
// Without a real browser UA, DuckDuckGo's HTML endpoint returns 403.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SEARCH_TIMEOUT_MS = 12000
// API search providers are fixed, trusted https hosts (no user-controlled
// URL), so — like SEARCH_URL/SEARCH_LITE_URL — they skip assertPublicUrl.
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'
const API_SEARCH_TIMEOUT_MS = 12000
// Requested from the API providers regardless of the caller's `limit` — we
// trim to `limit` after parsing so the numbered list stays the same size as
// the DDG path's.
const API_SEARCH_MAX_RESULTS = 8
const FETCH_TIMEOUT_MS = 15000
const MAX_RESULTS = 6
// Per-fetch text cap fed back to the model (raised 6k→12k chars — research
// tasks need enough of the page to actually work with).
const MAX_FETCH_CHARS = 12000
// Hard byte ceiling per request, enforced WHILE streaming so a huge or endless
// response can't buffer into and exhaust the main-process heap (DoS).
const MAX_DOWNLOAD_BYTES = 2_000_000
const MAX_REDIRECTS = 5

/** One parsed search result. */
export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/** Decode common HTML entities and strip tags, collapsing whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * DuckDuckGo wraps each result link in a redirect of the form
 * `//duckduckgo.com/l/?uddg=<url-encoded-real-url>&rut=...`. Pull the real URL
 * out of the `uddg` param; fall back to prefixing a protocol on bare `//` hrefs.
 */
export function decodeDdgHref(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      // Malformed encoding — fall through to the raw href handling below.
    }
  }
  if (href.startsWith('//')) return `https:${href}`
  return href
}

/**
 * Parse the DuckDuckGo HTML results page into structured results. Exported so the
 * brittle scraping is unit-tested against a captured fixture. Links and snippets
 * appear in document order; we zip them by index (a result without a snippet just
 * gets an empty one).
 */
export function parseDuckDuckGoHtml(html: string, limit = MAX_RESULTS): WebSearchResult[] {
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g

  const snippets: string[] = []
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(htmlToText(m[1]))
  }

  const results: WebSearchResult[] = []
  let i = 0
  for (let m = linkRe.exec(html); m !== null && results.length < limit; m = linkRe.exec(html)) {
    const url = decodeDdgHref(m[1])
    const title = htmlToText(m[2])
    if (!title || !/^https?:/i.test(url)) {
      i++
      continue
    }
    results.push({ title, url, snippet: snippets[i] ?? '' })
    i++
  }
  return results
}

/**
 * Parse the DuckDuckGo *lite* (no-JS) results page into the same structured
 * shape as {@link parseDuckDuckGoHtml}. The lite markup is a plain HTML table:
 * each result is an `<a rel="nofollow" class="result-link" href="...">Title</a>`
 * and its snippet lives in a `<td class="result-snippet">…</td>`. Hrefs are
 * either direct URLs or `/l/?uddg=`-wrapped redirects — both handled by
 * {@link decodeDdgHref}. Exported so this brittle scraping is unit-tested.
 *
 * Verified live 2026-06-18 against lite.duckduckgo.com/lite (and corroborated by
 * public scrapers, e.g. github.com/ezcorp-org/EZCorp src/search/providers.ts):
 * link class `result-link`, snippet class `result-snippet`. The `class` and
 * `href` attributes appear in either order, so we match defensively.
 */
export function parseDuckDuckGoLite(html: string, limit = MAX_RESULTS): WebSearchResult[] {
  // result-link with class either before or after href.
  const linkRe =
    /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<a[^>]*href="([^"]+)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g

  const snippets: string[] = []
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(htmlToText(m[1]))
  }

  const results: WebSearchResult[] = []
  let i = 0
  for (let m = linkRe.exec(html); m !== null && results.length < limit; m = linkRe.exec(html)) {
    const href = m[1] ?? m[3] ?? ''
    const rawTitle = m[2] ?? m[4] ?? ''
    const url = decodeDdgHref(href)
    const title = htmlToText(rawTitle)
    if (!title || !/^https?:/i.test(url)) {
      i++
      continue
    }
    results.push({ title, url, snippet: snippets[i] ?? '' })
    i++
  }
  return results
}

/** Format results as a compact, model-friendly numbered list with citations. */
function formatResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) {
    return `No web results found for "${query}". Try a different or more specific query.`
  }
  const lines = results.map(
    (r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || '(no snippet)'}`
  )
  return `Web search results for "${query}":\n\n${lines.join('\n\n')}`
}

// ── API search providers (optional, keyed) ──────────────────────────────────
// Both parsers are defensive: any missing/malformed field just skips that
// entry rather than throwing, since this is third-party JSON we don't control.

/** Parse Tavily's `{ results: [{ title, url, content }] }` response shape into
 *  the same structured shape as the DDG parsers. Exported for unit testing
 *  without touching `fetch`. */
export function parseTavilyResults(json: unknown, limit = MAX_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const arr = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(arr)) return results
  for (const entry of arr) {
    if (results.length >= limit) break
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title : ''
    const url = typeof item.url === 'string' ? item.url : ''
    if (!title || !url) continue
    const snippet = typeof item.content === 'string' ? item.content : ''
    results.push({ title, url, snippet })
  }
  return results
}

/** Parse Brave's `{ web: { results: [{ title, url, description }] } }`
 *  response shape into the same structured shape as the DDG parsers. Exported
 *  for unit testing without touching `fetch`. */
export function parseBraveResults(json: unknown, limit = MAX_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const arr = (json as { web?: { results?: unknown } } | null)?.web?.results
  if (!Array.isArray(arr)) return results
  for (const entry of arr) {
    if (results.length >= limit) break
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title : ''
    const url = typeof item.url === 'string' ? item.url : ''
    if (!title || !url) continue
    const snippet = typeof item.description === 'string' ? item.description : ''
    results.push({ title, url, snippet })
  }
  return results
}

/** Query Tavily's search API. Returns `null` (never throws) on anything that
 *  should fall back to DDG: a network error, a non-2xx response, or a
 *  genuinely empty result set. */
async function searchTavily(
  query: string,
  apiKey: string,
  limit: number
): Promise<WebSearchResult[] | null> {
  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: API_SEARCH_MAX_RESULTS }),
      signal: AbortSignal.timeout(API_SEARCH_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const json = (await response.json()) as unknown
    const results = parseTavilyResults(json, limit)
    return results.length > 0 ? results : null
  } catch {
    return null
  }
}

/** Query Brave's Web Search API. Returns `null` (never throws) on anything
 *  that should fall back to DDG — see {@link searchTavily}. */
async function searchBrave(
  query: string,
  apiKey: string,
  limit: number
): Promise<WebSearchResult[] | null> {
  try {
    const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${API_SEARCH_MAX_RESULTS}`
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_SEARCH_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const json = (await response.json()) as unknown
    const results = parseBraveResults(json, limit)
    return results.length > 0 ? results : null
  } catch {
    return null
  }
}

// ── SSRF defense ─────────────────────────────────────────────────────────────
// web_fetch lets the MODEL choose a URL, and prompt-injected web content could
// point it at internal services (Ollama, the router, cloud metadata at
// 169.254.169.254, other LAN hosts). We block loopback/private/link-local/CGNAT
// targets — checking literal IPs directly AND re-checking the DNS-resolved
// address (defeating rebinding) — and re-validate every redirect hop.

/** Is this IPv4 literal in a loopback/private/link-local/CGNAT/reserved range? */
function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true // malformed → fail closed
  }
  const [a, b] = parts
  if (a === 0 || a === 127) return true // this-host / loopback
  if (a === 10) return true // private
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 169 && b === 254) return true // link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast / reserved / broadcast
  return false
}

/** Is this IP literal (v4 or v6) one we refuse to fetch? */
function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip)
  if (fam === 4) return isBlockedV4(ip)
  if (fam === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true // loopback / unspecified
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped
    if (mapped) return isBlockedV4(mapped[1])
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true // unique-local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true // link-local fe80::/10
    return false
  }
  return true // not a parseable IP in a context that expected one → fail closed
}

/** Validate a URL is a public http(s) target. Throws on any blocked target. */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked URL scheme "${url.protocol}"`)
  }
  // IPv6 hosts arrive bracketed from URL parsing (e.g. "[::1]") — strip them so
  // the literal-IP check below actually recognizes the address.
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('blocked local host')
  }
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new Error('blocked private/loopback address')
    return url
  }
  // Hostname → resolve and re-check every address (defeats DNS rebinding).
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error('DNS resolution failed')
  }
  if (addresses.length === 0) throw new Error('host did not resolve')
  for (const a of addresses) {
    if (isBlockedIp(a.address)) throw new Error('host resolves to a private/loopback address')
  }
  return url
}

/** Read a response body, stopping at `maxBytes` so a huge stream can't OOM us.
 *  Falls back to `.text()` for body-less responses (e.g. mocked in tests). */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let out = ''
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        out += decoder.decode(value, { stream: true })
        if (total >= maxBytes) {
          out += decoder.decode()
          try {
            await reader.cancel()
          } catch {
            // already closing
          }
          break
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // best effort
      }
    }
    return out
  }
  const text = await response.text()
  return text.length > maxBytes ? text.slice(0, maxBytes) : text
}

interface GuardedResponse {
  ok: boolean
  status: number
  statusText: string
  contentType: string
  body: string
}

/** Fetch a model-chosen URL with SSRF validation on every hop + a size cap.
 *  Follows redirects MANUALLY so each Location is re-validated (native `fetch`
 *  redirect-following would skip the check and could land on an internal host). */
async function fetchGuarded(rawUrl: string, timeoutMs: number): Promise<GuardedResponse> {
  let target = rawUrl
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(target) // throws on a blocked target
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location) {
        target = new URL(location, url).toString()
        continue // re-validate the redirect target on the next iteration
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') ?? '',
      body: await readBodyCapped(response, MAX_DOWNLOAD_BYTES)
    }
  }
  throw new Error('too many redirects')
}

/** Run a keyless web search via DuckDuckGo's HTML endpoint. Never throws — on
 *  failure it returns an explanatory string the model can react to. The search
 *  endpoint is a fixed, trusted public host, so it skips the SSRF check, but the
 *  response is still size-capped and block-pages are reported distinctly. */
export async function runWebSearch(query: string, limit = MAX_RESULTS): Promise<string> {
  const q = query.trim()
  if (!q) return 'web_search requires a non-empty "query".'

  // Optional API provider, tried first when configured with a key. Any
  // failure here (including "no key set") falls through to the unchanged DDG
  // path below — the keyless default behaves exactly as before.
  const config = getSearchConfig()
  const provider = config.getProvider()
  const apiKey = config.getKey().trim()
  if (apiKey) {
    if (provider === 'tavily') {
      const results = await searchTavily(q, apiKey, limit)
      if (results) return formatResults(q, results)
    } else if (provider === 'brave') {
      const results = await searchBrave(q, apiKey, limit)
      if (results) return formatResults(q, results)
    }
  }

  try {
    // Primary: the html endpoint. A non-2xx, OR a 200 with no result markup at
    // all, means we were blocked/challenged rather than handed a genuine empty
    // result set — both trigger the lite fallback below.
    let primaryBlocked = false
    const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}`
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    })
    if (!response.ok) {
      primaryBlocked = true
    } else {
      const html = await readBodyCapped(response, MAX_DOWNLOAD_BYTES)
      const results = parseDuckDuckGoHtml(html, limit)
      if (results.length > 0) return formatResults(q, results)
      // 0 results: a genuine empty set still carries result markup; its absence
      // means a block/challenge page, so fall through to the lite endpoint.
      if (/result__a/.test(html)) return formatResults(q, results)
      primaryBlocked = true
    }

    // Fallback: DuckDuckGo's lite (no-JS) endpoint. A transient block on one
    // endpoint rarely hits both, so this recovers most "0 results" cases.
    if (primaryBlocked) {
      try {
        const liteUrl = `${SEARCH_LITE_URL}?q=${encodeURIComponent(q)}`
        const liteResponse = await fetch(liteUrl, {
          method: 'GET',
          headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
        })
        if (liteResponse.ok) {
          const liteHtml = await readBodyCapped(liteResponse, MAX_DOWNLOAD_BYTES)
          const liteResults = parseDuckDuckGoLite(liteHtml, limit)
          if (liteResults.length > 0) return formatResults(q, liteResults)
        }
      } catch {
        // Lite endpoint also failed — fall through to the unavailable message.
      }
    }

    // Both endpoints failed. Say so distinctly so the model doesn't treat
    // "unavailable" as "nothing exists".
    return `Web search is temporarily unavailable (the search endpoint returned no usable results — it may be rate-limiting automated requests). Try again later or answer from what you know, noting it isn't web-verified.`
  } catch (err) {
    return `Web search error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Reduce a fetched HTML page to readable text (scripts/styles removed, capped). */
export function pageToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const text = htmlToText(stripped)
  return text.length > MAX_FETCH_CHARS ? `${text.slice(0, MAX_FETCH_CHARS)}…[truncated]` : text
}

/** Fetch a single URL and return its readable text. Never throws — returns an
 *  explanatory string on failure. SSRF-guarded (no loopback/private/LAN/metadata
 *  targets), redirects re-validated per hop, and the download is size-capped. */
export async function runWebFetch(rawUrl: string): Promise<string> {
  const url = rawUrl.trim()
  if (!/^https?:\/\//i.test(url)) {
    return 'web_fetch requires an absolute http(s) "url".'
  }
  try {
    const response = await fetchGuarded(url, FETCH_TIMEOUT_MS)
    if (!response.ok) {
      return `Could not fetch ${url} (${response.status} ${response.statusText}).`
    }
    const text = /html/i.test(response.contentType)
      ? pageToText(response.body)
      : response.body.slice(0, MAX_FETCH_CHARS)
    return `Content of ${url}:\n\n${text}`
  } catch (err) {
    // Includes the SSRF refusals from assertPublicUrl.
    return `Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** The tool specs advertised to the model (OpenAI function-calling shape). */
export const WEB_TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web and return the top results (title, URL, snippet). ' +
        'Use this for current events, recent data, prices, or anything you are unsure of.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a single web page by URL and return its readable text. Use after ' +
        'web_search to read a specific result in detail.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to fetch.' }
        },
        required: ['url']
      }
    }
  }
]

/** A short human-readable label for a tool call, shown as a transient status. */
export function describeWebToolCall(call: ToolCall): string {
  const args = safeParseArgs(call.arguments)
  if (call.name === 'web_search') return `🔎 Searching the web: ${String(args.query ?? '')}`.trim()
  if (call.name === 'web_fetch') return `📄 Reading ${String(args.url ?? '')}`.trim()
  return `Running ${call.name}…`
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Execute a web tool the model requested. Dispatches by name; unknown tools and
 *  bad arguments come back as a string (never throws) so the loop can continue. */
export async function runWebTool(call: ToolCall): Promise<string> {
  const args = safeParseArgs(call.arguments)
  switch (call.name) {
    case 'web_search':
      return runWebSearch(typeof args.query === 'string' ? args.query : '')
    case 'web_fetch':
      return runWebFetch(typeof args.url === 'string' ? args.url : '')
    default:
      return `Unknown tool: ${call.name}`
  }
}
