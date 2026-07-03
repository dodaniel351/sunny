import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  decodeDdgHref,
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  parseTavilyResults,
  parseBraveResults,
  pageToText,
  runWebSearch,
  runWebFetch,
  runWebTool,
  WEB_TOOLS,
  describeWebToolCall
} from '@main/tools/web'
import { configureWebSearch, parseSearchProvider } from '@main/tools/search-config'

// web.ts now resolves hostnames as part of its SSRF guard. Stub DNS so these
// unit tests stay network-free, and so a normal hostname resolves to a public
// address (literal-IP cases below are checked synchronously, without DNS).
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
}))

// Pure fetch/parse tests for Sunny's keyless web tools — no network, no native
// import. global `fetch` is mocked. The DuckDuckGo HTML parsing is the brittle
// part, so it's exercised against a captured-shape fixture.

function htmlResponse(html: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.ok === false ? 'Forbidden' : 'OK',
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => html
  } as unknown as Response
}

// One result block in the shape html.duckduckgo.com/html returns: the href is a
// `/l/?uddg=<enc>` redirect with HTML-escaped `&amp;` param separators.
function resultBlock(encodedUrl: string, title: string, snippet: string): string {
  return `
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodedUrl}&amp;rut=xyz">${title}</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodedUrl}">${snippet}</a>
  </div>`
}

const FIXTURE = `<html><body><div id="links">
  ${resultBlock('https%3A%2F%2Fexample.com%2Falpha', 'Alpha <b>Result</b>', 'About alpha &amp; things.')}
  ${resultBlock('https%3A%2F%2Fexample.org%2Fbeta', 'Beta Result', 'Beta snippet here.')}
</div></body></html>`

// One result block in the shape lite.duckduckgo.com/lite returns: a no-JS HTML
// table where the title is `<a class="result-link" href="...">` and the snippet
// is a `<td class="result-snippet">`. Verified 2026-06-18; hrefs may be direct
// or `/l/?uddg=`-wrapped redirects (this block uses the redirect form).
function liteResultBlock(encodedUrl: string, title: string, snippet: string): string {
  return `
  <tr>
    <td valign="top">1.&nbsp;</td>
    <td>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodedUrl}&amp;rut=xyz" class="result-link">${title}</a>
    </td>
  </tr>
  <tr>
    <td>&nbsp;</td>
    <td class="result-snippet">${snippet}</td>
  </tr>`
}

const LITE_FIXTURE = `<html><body><table>
  ${liteResultBlock('https%3A%2F%2Fexample.com%2Falpha', 'Alpha <b>Lite</b>', 'About alpha &amp; lite.')}
  ${liteResultBlock('https%3A%2F%2Fexample.org%2Fbeta', 'Beta Lite', 'Beta lite snippet.')}
</table></body></html>`

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  // Reset the module-level search config to the keyless DDG default before
  // every test, so a provider set by one test never bleeds into the next.
  configureWebSearch({ getProvider: () => 'ddg', getKey: () => '' })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('decodeDdgHref', () => {
  it('decodes the uddg redirect param back to the real URL', () => {
    expect(decodeDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=abc')).toBe(
      'https://example.com/a'
    )
  })
  it('stops at the &amp; HTML-escaped separator', () => {
    expect(
      decodeDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc')
    ).toBe('https://example.com/a')
  })
  it('prefixes a protocol on a bare // href with no uddg', () => {
    expect(decodeDdgHref('//example.com/x')).toBe('https://example.com/x')
  })
})

describe('parseDuckDuckGoHtml', () => {
  it('extracts title, decoded url, and snippet per result', () => {
    const results = parseDuckDuckGoHtml(FIXTURE)
    expect(results).toEqual([
      { title: 'Alpha Result', url: 'https://example.com/alpha', snippet: 'About alpha & things.' },
      { title: 'Beta Result', url: 'https://example.org/beta', snippet: 'Beta snippet here.' }
    ])
  })
  it('respects the result limit', () => {
    expect(parseDuckDuckGoHtml(FIXTURE, 1)).toHaveLength(1)
  })
  it('returns [] for a page with no results', () => {
    expect(parseDuckDuckGoHtml('<html><body>nothing</body></html>')).toEqual([])
  })
})

describe('parseDuckDuckGoLite', () => {
  it('extracts title, decoded url, and snippet per lite result', () => {
    const results = parseDuckDuckGoLite(LITE_FIXTURE)
    expect(results).toEqual([
      { title: 'Alpha Lite', url: 'https://example.com/alpha', snippet: 'About alpha & lite.' },
      { title: 'Beta Lite', url: 'https://example.org/beta', snippet: 'Beta lite snippet.' }
    ])
  })
  it('handles a direct (non-redirect) href', () => {
    const html =
      '<table><tr><td><a href="https://direct.example/x" class="result-link">Direct</a></td></tr>' +
      '<tr><td class="result-snippet">Direct snippet.</td></tr></table>'
    expect(parseDuckDuckGoLite(html)).toEqual([
      { title: 'Direct', url: 'https://direct.example/x', snippet: 'Direct snippet.' }
    ])
  })
  it('matches result-link with class before href too', () => {
    const html =
      '<table><tr><td><a class="result-link" rel="nofollow" href="https://order.example/y">Order</a></td></tr>' +
      '<tr><td class="result-snippet">Order snippet.</td></tr></table>'
    expect(parseDuckDuckGoLite(html)).toEqual([
      { title: 'Order', url: 'https://order.example/y', snippet: 'Order snippet.' }
    ])
  })
  it('respects the result limit', () => {
    expect(parseDuckDuckGoLite(LITE_FIXTURE, 1)).toHaveLength(1)
  })
  it('returns [] for a page with no lite results', () => {
    expect(parseDuckDuckGoLite('<html><body>nothing</body></html>')).toEqual([])
  })
})

describe('parseSearchProvider', () => {
  it('passes through known providers', () => {
    expect(parseSearchProvider('ddg')).toBe('ddg')
    expect(parseSearchProvider('tavily')).toBe('tavily')
    expect(parseSearchProvider('brave')).toBe('brave')
  })
  it('defaults unknown, empty, null, or undefined values to ddg', () => {
    expect(parseSearchProvider('bing')).toBe('ddg')
    expect(parseSearchProvider('')).toBe('ddg')
    expect(parseSearchProvider(null)).toBe('ddg')
    expect(parseSearchProvider(undefined)).toBe('ddg')
  })
})

describe('parseTavilyResults', () => {
  it('extracts title, url, and content into the shared result shape', () => {
    const json = {
      results: [
        { title: 'Alpha', url: 'https://example.com/alpha', content: 'About alpha.' },
        { title: 'Beta', url: 'https://example.org/beta', content: 'About beta.' }
      ]
    }
    expect(parseTavilyResults(json)).toEqual([
      { title: 'Alpha', url: 'https://example.com/alpha', snippet: 'About alpha.' },
      { title: 'Beta', url: 'https://example.org/beta', snippet: 'About beta.' }
    ])
  })
  it('respects the result limit', () => {
    const json = {
      results: [
        { title: 'Alpha', url: 'https://example.com/alpha', content: 'x' },
        { title: 'Beta', url: 'https://example.org/beta', content: 'y' }
      ]
    }
    expect(parseTavilyResults(json, 1)).toHaveLength(1)
  })
  it('defaults a missing content field to an empty snippet', () => {
    const json = { results: [{ title: 'No snippet', url: 'https://example.com/x' }] }
    expect(parseTavilyResults(json)).toEqual([
      { title: 'No snippet', url: 'https://example.com/x', snippet: '' }
    ])
  })
  it('skips entries missing a title or url, and tolerates malformed shapes', () => {
    expect(parseTavilyResults(null)).toEqual([])
    expect(parseTavilyResults({})).toEqual([])
    expect(parseTavilyResults({ results: 'not an array' })).toEqual([])
    expect(
      parseTavilyResults({
        results: [{ title: 'No URL' }, { url: 'https://example.com/no-title' }, null, 'string', 42]
      })
    ).toEqual([])
  })
})

describe('parseBraveResults', () => {
  it('extracts title, url, and description into the shared result shape', () => {
    const json = {
      web: {
        results: [
          { title: 'Alpha', url: 'https://example.com/alpha', description: 'About alpha.' },
          { title: 'Beta', url: 'https://example.org/beta', description: 'About beta.' }
        ]
      }
    }
    expect(parseBraveResults(json)).toEqual([
      { title: 'Alpha', url: 'https://example.com/alpha', snippet: 'About alpha.' },
      { title: 'Beta', url: 'https://example.org/beta', snippet: 'About beta.' }
    ])
  })
  it('respects the result limit', () => {
    const json = {
      web: {
        results: [
          { title: 'Alpha', url: 'https://example.com/alpha', description: 'x' },
          { title: 'Beta', url: 'https://example.org/beta', description: 'y' }
        ]
      }
    }
    expect(parseBraveResults(json, 1)).toHaveLength(1)
  })
  it('skips entries missing a title or url, and tolerates malformed/missing shapes', () => {
    expect(parseBraveResults(null)).toEqual([])
    expect(parseBraveResults({})).toEqual([])
    expect(parseBraveResults({ web: {} })).toEqual([])
    expect(parseBraveResults({ web: { results: 'not an array' } })).toEqual([])
    expect(
      parseBraveResults({ web: { results: [{ title: 'No URL' }, null, 'string'] } })
    ).toEqual([])
  })
})

describe('runWebSearch provider routing', () => {
  it('uses Tavily when configured with a key, POSTing the expected body', async () => {
    configureWebSearch({ getProvider: () => 'tavily', getKey: () => 'tvly-test-key' })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ title: 'Tavily Result', url: 'https://example.com/tavily', content: 'snippet' }]
      })
    } as unknown as Response)

    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.tavily.com/search')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      api_key: 'tvly-test-key',
      query: 'alpha beta',
      max_results: 8
    })
    expect(out).toContain('Tavily Result')
    expect(out).toContain('https://example.com/tavily')
  })

  it('uses Brave when configured with a key, GETing the expected URL and headers', async () => {
    configureWebSearch({ getProvider: () => 'brave', getKey: () => 'brave-test-key' })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            { title: 'Brave Result', url: 'https://example.com/brave', description: 'snippet' }
          ]
        }
      })
    } as unknown as Response)

    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.search.brave.com/res/v1/web/search?q=alpha%20beta&count=8')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Subscription-Token']).toBe('brave-test-key')
    expect(out).toContain('Brave Result')
  })

  it('falls back to the DDG path when Tavily errors (network failure)', async () => {
    configureWebSearch({ getProvider: () => 'tavily', getKey: () => 'bad-key' })
    // 1st call: Tavily rejects outright.
    fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    // 2nd call: the DDG html endpoint, which should still be tried and succeed.
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))

    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [ddgUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(ddgUrl).toContain('https://html.duckduckgo.com/html/?q=alpha%20beta')
    expect(out).toContain('Alpha Result')
  })

  it('falls back to the DDG path when Tavily returns a non-2xx response', async () => {
    configureWebSearch({ getProvider: () => 'tavily', getKey: () => 'bad-key' })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as unknown as Response)
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))

    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out).toContain('Alpha Result')
  })

  it('falls back to the DDG path when Tavily returns an empty result set', async () => {
    configureWebSearch({ getProvider: () => 'tavily', getKey: () => 'ok-key' })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [] })
    } as unknown as Response)
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))

    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out).toContain('Alpha Result')
  })

  it('does not call any API provider when the provider is ddg (default, keyless path unchanged)', async () => {
    configureWebSearch({ getProvider: () => 'ddg', getKey: () => 'unused-if-ddg' })
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))

    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://html.duckduckgo.com/html/')
    expect(out).toContain('Alpha Result')
  })

  it('does not call the API provider when tavily/brave is selected but no key is set', async () => {
    configureWebSearch({ getProvider: () => 'tavily', getKey: () => '' })
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))

    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://html.duckduckgo.com/html/')
    expect(out).toContain('Alpha Result')
  })
})

describe('runWebSearch', () => {
  it('sends a browser UA and formats the parsed results', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))
    const out = await runWebSearch('alpha beta')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://html.duckduckgo.com/html/?q=alpha%20beta')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toMatch(/Mozilla/)

    expect(out).toContain('Alpha Result')
    expect(out).toContain('https://example.com/alpha')
    expect(out).toContain('Beta Result')
  })
  it('rejects an empty query without a network call', async () => {
    const out = await runWebSearch('   ')
    expect(out).toMatch(/non-empty/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('falls back to lite, then reports unavailable when BOTH endpoints fail', async () => {
    // Primary non-2xx is now a block condition that triggers the lite fallback;
    // here lite also fails (non-2xx), so we get the distinct unavailable message.
    fetchMock.mockResolvedValueOnce(htmlResponse('', { ok: false, status: 403 }))
    fetchMock.mockResolvedValueOnce(htmlResponse('', { ok: false, status: 403 }))
    const out = await runWebSearch('blocked')
    expect(out).toMatch(/unavailable/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('reports a network error without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const out = await runWebSearch('boom')
    expect(out).toMatch(/error: ETIMEDOUT/)
  })
  it('reports a block/challenge page as unavailable when lite also blocks', async () => {
    // A 200 page with no result markup = blocked, not an empty set. Both the
    // primary and the lite fallback serve block pages here → unavailable.
    fetchMock.mockResolvedValueOnce(htmlResponse('<html><body>captcha challenge</body></html>'))
    fetchMock.mockResolvedValueOnce(htmlResponse('<html><body>captcha challenge</body></html>'))
    const out = await runWebSearch('anything')
    expect(out).toMatch(/unavailable/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('falls back to the lite endpoint when the primary serves a block page', async () => {
    // 1st fetch (html endpoint): 200 but no result markup → block condition.
    fetchMock.mockResolvedValueOnce(htmlResponse('<html><body>captcha challenge</body></html>'))
    // 2nd fetch (lite endpoint): real lite results → these are returned.
    fetchMock.mockResolvedValueOnce(htmlResponse(LITE_FIXTURE))
    const out = await runWebSearch('alpha beta')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [liteUrl] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(liteUrl).toContain('https://lite.duckduckgo.com/lite/?q=alpha%20beta')

    expect(out).toContain('Alpha Lite')
    expect(out).toContain('https://example.com/alpha')
    expect(out).toContain('Beta Lite')
  })
  it('does not call the lite endpoint when the primary returns results', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))
    const out = await runWebSearch('alpha beta')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out).toContain('Alpha Result')
  })
})

describe('pageToText', () => {
  it('strips scripts/styles/comments and collapses whitespace', () => {
    const html =
      '<html><head><style>.x{color:red}</style></head>' +
      '<body><script>evil()</script><!-- c --><h1>Title</h1>\n\n<p>Body  text.</p></body></html>'
    const text = pageToText(html)
    expect(text).toContain('Title')
    expect(text).toContain('Body text.')
    expect(text).not.toContain('evil')
    expect(text).not.toContain('color:red')
  })
})

describe('runWebFetch', () => {
  it('rejects a non-http url without a network call', async () => {
    const out = await runWebFetch('ftp://nope')
    expect(out).toMatch(/absolute http/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('fetches a page and returns reduced text', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse('<html><body><p>Hello page</p></body></html>'))
    const out = await runWebFetch('https://example.com')
    expect(out).toContain('Content of https://example.com')
    expect(out).toContain('Hello page')
  })
  it('reports a non-2xx without throwing', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse('', { ok: false, status: 404 }))
    const out = await runWebFetch('https://example.com/missing')
    expect(out).toMatch(/Could not fetch .*404/)
  })
})

describe('runWebFetch SSRF guard', () => {
  // Each of these must be refused BEFORE any network call (no fetch, no DNS).
  const blocked = [
    'http://127.0.0.1',
    'http://localhost:11434',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1',
    'http://10.0.0.5',
    'http://172.16.0.9',
    'http://[::1]/'
  ]
  for (const url of blocked) {
    it(`refuses ${url}`, async () => {
      const out = await runWebFetch(url)
      expect(out).toMatch(/Could not fetch/i)
      expect(out).toMatch(/blocked|private|loopback|local/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }
})

describe('runWebTool', () => {
  it('dispatches web_search by name with parsed args', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(FIXTURE))
    const out = await runWebTool({ id: '1', name: 'web_search', arguments: '{"query":"alpha"}' })
    expect(out).toContain('Alpha Result')
  })
  it('returns a message for an unknown tool', async () => {
    const out = await runWebTool({ id: '1', name: 'nope', arguments: '{}' })
    expect(out).toBe('Unknown tool: nope')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('tolerates malformed arguments JSON', async () => {
    const out = await runWebTool({ id: '1', name: 'web_search', arguments: 'not json' })
    expect(out).toMatch(/non-empty/) // empty query path, no throw
  })
})

describe('WEB_TOOLS specs', () => {
  it('advertises web_search and web_fetch in the OpenAI function shape', () => {
    const names = WEB_TOOLS.map((t) => t.function.name)
    expect(names).toEqual(['web_search', 'web_fetch'])
    expect(WEB_TOOLS[0].type).toBe('function')
    expect(WEB_TOOLS[0].function.parameters).toHaveProperty('properties.query')
  })
  it('describes calls with a readable status line', () => {
    expect(describeWebToolCall({ id: '1', name: 'web_search', arguments: '{"query":"cats"}' })).toBe(
      '🔎 Searching the web: cats'
    )
    expect(
      describeWebToolCall({ id: '2', name: 'web_fetch', arguments: '{"url":"https://x.com"}' })
    ).toBe('📄 Reading https://x.com')
  })
})
