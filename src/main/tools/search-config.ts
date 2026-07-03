// Module-level config for Sunny's web_search tool (structure layer). The main
// process calls `configureWebSearch()` once at startup after reading the
// `search_provider` / `search_api_key` settings; `web.ts` reads it back via
// `getSearchConfig()` on every search so a key change takes effect immediately
// without restarting the app. Kept dependency-free (no electron/DB imports) so
// it's trivial to import from `web.ts` (which must stay pure fetch + parse) and
// to unit-test in isolation.

/** Which backend `runWebSearch` should try first. 'ddg' needs no key. */
export type SearchProviderKind = 'ddg' | 'tavily' | 'brave'

/** Live source for the configured provider + key — a thin indirection so the
 *  main process can back it with settings (possibly re-read on each call)
 *  without `web.ts` importing the settings repository directly. */
export interface SearchConfigSource {
  getProvider(): SearchProviderKind
  getKey(): string
}

/** Keyless default: matches today's DDG-only behavior when nothing is configured. */
const DEFAULT_SOURCE: SearchConfigSource = {
  getProvider: () => 'ddg',
  getKey: () => ''
}

let currentSource: SearchConfigSource = DEFAULT_SOURCE

/** Install the live config source. Call once at startup (and again if the
 *  user changes the provider/key, unless the source already re-reads live). */
export function configureWebSearch(source: SearchConfigSource): void {
  currentSource = source
}

/** The active config source — 'ddg'/'' until `configureWebSearch` is called. */
export function getSearchConfig(): SearchConfigSource {
  return currentSource
}

/** Normalize a raw settings value into a known provider kind. Unknown, empty,
 *  or missing values fall back to 'ddg' so a bad/cleared setting never breaks
 *  search — it just drops back to the keyless default. Pure + exported for
 *  unit testing without touching the module-level config. */
export function parseSearchProvider(raw: string | null | undefined): SearchProviderKind {
  if (raw === 'tavily' || raw === 'brave') return raw
  return 'ddg'
}
