// Embeddings service for the knowledge-graph memory (vector store
// memory_vectors(embedding FLOAT[dim])). The vec table's dimension adapts to the
// active model (see vector-store.ts reconcileVectorDimension), so embedders are
// no longer pinned to 1536.
//
// Like the chat providers, this file is intentionally pure logic: it does NOT
// import the secret store, DB, or electron. The caller injects a `getKey`
// resolver so the embedder stays unit-friendly and the key is fetched fresh on
// every call (it may change in Settings between calls).
//
// OpenAI and OpenRouter both speak the OpenAI `/embeddings` schema, so they share
// `createOpenAiCompatibleEmbedder` (just a different base URL + model). Ollama has
// its own embedder (see providers/ollama.ts). Each embedder's dimension is
// discovered by probing, not assumed.

/** Default OpenAI embedding dimension (text-embedding-3-small). */
export const EMBEDDING_DIM = 1536

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'

// Embedding calls are short request/response (no streaming); a 20s ceiling keeps
// a hung network from blocking the memory pipeline.
const REQUEST_TIMEOUT_MS = 20000

export interface Embedder {
  readonly provider: string // 'openai' | 'openrouter' | 'ollama'
  readonly model: string
  embed(texts: string[]): Promise<number[][]>
}

/** The slice of the /embeddings response we rely on. */
interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
}

/** Best-effort extraction of a human-readable message from an error response body. */
async function readErrorMessage(response: Response, provider: string): Promise<string> {
  // 401 is the common "bad key" case; give it a stable, friendly message.
  if (response.status === 401) return 'Invalid or unauthorized API key'
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as { error?: { message?: string } }
      if (json.error?.message) return json.error.message
    } catch {
      // Body was not JSON — fall through to the raw text / status line.
    }
    if (text.trim() !== '') return text.trim()
  } catch {
    // Reading the body failed — fall through to the status line.
  }
  return `${provider} embeddings request failed (${response.status} ${response.statusText})`
}

export interface OpenAiCompatibleEmbedderOptions {
  /** Display kind, e.g. 'openai' | 'openrouter'. */
  provider: string
  /** API root, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1. */
  baseUrl: string
  /** The embedding model id (provider-specific). */
  model: string
  /** Resolve the API key (or null) fresh on each call. */
  getKey: () => Promise<string | null>
  /**
   * The dimension the vector table is sized to. When set, a returned vector of a
   * different length throws a clear, actionable error instead of failing silently
   * at the vec0 INSERT (which sits inside a swallowed catch). resolveEmbedder
   * passes the probed dim so the active embedder self-checks.
   */
  expectDim?: number
}

/**
 * Create an embedder against any OpenAI-compatible `/embeddings` endpoint
 * (OpenAI, OpenRouter, …). The dimension is whatever the model returns — the
 * caller probes it and sizes the vector table to match.
 */
export function createOpenAiCompatibleEmbedder(opts: OpenAiCompatibleEmbedderOptions): Embedder {
  const root = opts.baseUrl.replace(/\/+$/, '')
  return {
    provider: opts.provider,
    model: opts.model,

    async embed(texts: string[]): Promise<number[][]> {
      // No inputs → no network call (the API would reject an empty `input`).
      if (texts.length === 0) return []

      const key = await opts.getKey()
      if (key === null) throw new Error(`No API key for ${opts.provider} embeddings`)

      const response = await fetch(`${root}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: opts.model, input: texts }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })

      if (!response.ok) throw new Error(await readErrorMessage(response, opts.provider))

      const json = (await response.json()) as EmbeddingsResponse
      const data = json.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `${opts.provider} embeddings returned ${data?.length ?? 0} vectors for ${texts.length} inputs`
        )
      }

      // Map each item back to its input position via `index` when provided
      // (OpenAI guarantees it); fall back to array order otherwise.
      const ordered: number[][] = new Array<number[]>(texts.length)
      let pos = 0
      for (const item of data) {
        const index = typeof item.index === 'number' ? item.index : pos
        const embedding = item.embedding
        if (index < 0 || index >= texts.length) {
          throw new Error(`${opts.provider} embeddings response had an out-of-range index`)
        }
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error(`${opts.provider} embeddings response had an empty vector`)
        }
        ordered[index] = embedding
        pos++
      }

      for (const vec of ordered) {
        if (vec === undefined) throw new Error(`${opts.provider} embeddings response was missing a vector`)
        if (opts.expectDim !== undefined && vec.length !== opts.expectDim) {
          throw new Error(
            `${opts.provider} returned ${vec.length}-dim vectors, expected ${opts.expectDim} — re-select the embedding model in Settings → Memory`
          )
        }
      }

      return ordered
    }
  }
}

/**
 * The OpenAI embedder (`text-embedding-3-small` → 1536-dim). `getKey` resolves
 * the user's OpenAI API key (or null), fetched fresh on every `embed`.
 */
export function createOpenAiEmbedder(getKey: () => Promise<string | null>): Embedder {
  return createOpenAiCompatibleEmbedder({
    provider: 'openai',
    baseUrl: OPENAI_BASE_URL,
    model: OPENAI_EMBEDDING_MODEL,
    getKey
  })
}
