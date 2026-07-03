// The Ollama (local) provider (spec §4a) — keyless local chat + local embeddings
// served by a user-run Ollama daemon (default http://localhost:11434).
//
// Ollama is a special case among our adapters: it runs ON THE USER'S MACHINE and
// needs NO API key. Its model catalog is whatever the user has pulled, so unlike
// the static-catalog adapters the live list comes from the daemon (`/api/tags`)
// and the registry/IPC layer fills it in — `listModels()` here returns []. The
// same single `/api/tags` source feeds both the chat dropdown (non-embedding
// models) and the embeddings model picker (embedding models), partitioned by the
// `isEmbedModelName` heuristic below.
//
// Wire protocols (https://github.com/ollama/ollama/blob/main/docs):
//   - Chat:       POST {base}/v1/chat/completions  (OpenAI-COMPATIBLE; identical
//                 SSE framing to openai-compatible.ts — reuse SseParser + the same
//                 choices[0].delta.content / [DONE] handling). NO Authorization.
//   - Embeddings: POST {base}/api/embed  with {model, input}; returns
//                 {embeddings: number[][]} — one vector per input, in order.
//   - Models:     GET  {base}/api/tags     → {models: [{name, ...}]}
//   - Liveness:   GET  {base}/api/version  → 2xx when the daemon is up.
//
// Like the other adapters this file is pure provider logic: it does NOT import the
// secret store, DB, electron, or repositories. Everything talks to the local
// daemon over Node's global `fetch`, so the heuristics + parsing stay unit-testable.

import type {
  ChatTurn,
  KeyValidationResult,
  ModelInfo,
  Provider,
  StreamChatParams,
  StreamChunk,
  StreamWithToolsParams
} from './types'
import type { Embedder } from '../memory/embeddings'
import { SseParser } from './sse'
import { runToolLoop } from './tool-loop'

/** The daemon's default loopback address; overridable in Settings. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434'

// Liveness probe is a single GET that must not hang the UI; embeddings are a short
// request/response that can be slower on first-load (model warm-up), so give them
// a more generous ceiling than chat liveness.
const REACHABLE_TIMEOUT_MS = 3000
const EMBED_TIMEOUT_MS = 30000

// Name prefixes that mark a pulled model as an embedding model. Kept here (not a
// regex literal) so the truth table in the test reads 1:1 against this list.
const EMBED_NAME_PREFIXES = ['nomic-', 'mxbai-', 'bge', 'snowflake-arctic-embed', 'all-minilm']

/** The slice of /api/tags we rely on. */
interface TagsResponse {
  models?: Array<{ name?: string }>
}

/** The slice of /api/embed we rely on. */
interface EmbedResponse {
  embeddings?: number[][]
}

/** The slice of each streamed chat-completions chunk we care about (Ollama's
 * /v1 endpoint mirrors the OpenAI chat-completions wire shape exactly). */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null }
    finish_reason?: string | null
  }>
}

/**
 * Pure heuristic: does this model name look like an embedding model? True if the
 * name contains 'embed' anywhere, or starts with a known embedding-family prefix
 * (nomic-, mxbai-, bge, snowflake-arctic-embed, all-minilm). Case-insensitive.
 * Used to partition the single /api/tags catalog into chat vs embedding models.
 */
export function isEmbedModelName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.includes('embed')) return true
  return EMBED_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** Strip a trailing slash so `${base}/path` never produces a double slash. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** Map our ChatTurn[] to Ollama's `messages` array. The role vocabulary is
 *  identical; a turn with images adds an `images: [base64]` field (no data: URL
 *  prefix), which vision models (e.g. llava) read. */
function toMessages(
  messages: ChatTurn[]
): Array<{ role: ChatTurn['role']; content: string; images?: string[] }> {
  return messages.map((turn) => {
    if (turn.images && turn.images.length > 0) {
      return {
        role: turn.role,
        content: turn.content,
        images: turn.images.map((i) => i.dataUrl.replace(/^data:[^;]+;base64,/, ''))
      }
    }
    return { role: turn.role, content: turn.content }
  })
}

/**
 * Fetch the daemon's full model list from /api/tags, returning the raw names.
 * Returns [] on any error (daemon down, bad JSON) so callers can degrade quietly.
 */
async function fetchModelNames(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS)
    })
    if (!response.ok) return []

    const json = (await response.json()) as TagsResponse
    const models = json.models
    if (!Array.isArray(models)) return []

    const names: string[] = []
    for (const model of models) {
      if (typeof model.name === 'string' && model.name !== '') names.push(model.name)
    }
    return names
  } catch {
    return []
  }
}

/**
 * Liveness probe: GET /api/version with a short timeout. True on a 2xx response,
 * false on any error (connection refused, timeout, non-2xx). Used by Settings to
 * tell the user whether the daemon is running before they pick a model.
 */
export async function ollamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/version`, {
      method: 'GET',
      signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS)
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * The user's pulled CHAT models (embedding models excluded) as ModelInfo, from
 * /api/tags. Empty on error. Both id and label are the raw model name (Ollama
 * has no separate display name).
 */
export async function ollamaChatModels(baseUrl: string): Promise<ModelInfo[]> {
  const names = await fetchModelNames(baseUrl)
  return names.filter((name) => !isEmbedModelName(name)).map((name) => ({ id: name, label: name }))
}

/**
 * The user's pulled EMBEDDING model names, from /api/tags. Empty on error. Feeds
 * the embeddings model picker in Settings (paired with createOllamaEmbedder).
 */
export async function ollamaEmbedModels(baseUrl: string): Promise<string[]> {
  const names = await fetchModelNames(baseUrl)
  return names.filter((name) => isEmbedModelName(name))
}

/**
 * Map one decoded SSE `data:` payload to a normalized chunk, or undefined for
 * lines we ignore (the `[DONE]` sentinel, non-JSON lines, empty deltas). Identical
 * to the openai-compatible adapter's handling — Ollama's /v1 endpoint is the same
 * chat-completions wire shape. Kept a free function so it is unit-testable.
 */
export function handleData(data: string): StreamChunk | undefined {
  // The chat-completions stream terminates with a literal [DONE] sentinel.
  if (data === '[DONE]') return undefined

  let chunk: ChatCompletionChunk
  try {
    chunk = JSON.parse(data) as ChatCompletionChunk
  } catch {
    // A non-JSON data line is not actionable; skip rather than fail the stream.
    return undefined
  }

  const choice = chunk.choices?.[0]
  const content = choice?.delta?.content
  if (typeof content === 'string' && content !== '') {
    return { type: 'delta', text: content }
  }

  // The final chunk arrives with an empty delta + a finish_reason; surface that
  // as the terminal `done`. (Empty interim deltas just yield nothing.)
  const finishReason = choice?.finish_reason
  if (typeof finishReason === 'string' && finishReason !== '') {
    return { type: 'done', finishReason }
  }

  return undefined
}

export class OllamaProvider implements Provider {
  readonly kind = 'ollama'
  readonly label = 'Ollama (local)'
  // Models are dynamic (whatever the user has pulled), so there is no sensible
  // static default — the registry/IPC layer resolves the live list and selection.
  readonly defaultModel = ''
  // Resolved on each use so a Base URL change in Settings takes effect without a
  // restart — and so chat hits the SAME server the model list came from. Accepts
  // a fixed string or a live getter (the registry passes one that reads settings).
  readonly #resolveBaseUrl: () => string

  constructor(baseUrl: string | (() => string)) {
    this.#resolveBaseUrl = typeof baseUrl === 'function' ? baseUrl : (): string => baseUrl
  }

  /** The current Ollama root (no trailing slash), read live at call time. */
  private get baseUrl(): string {
    return normalizeBaseUrl(this.#resolveBaseUrl())
  }

  /** Live listing is done by the registry/IPC via ollamaChatModels — not here. */
  listModels(): ModelInfo[] {
    return []
  }

  /** Ollama is keyless, so there is nothing to validate. */
  async validateKey(): Promise<KeyValidationResult> {
    return { ok: true }
  }

  /**
   * Stream a completion as normalized chunks. POSTs the OpenAI-compatible
   * chat-completions endpoint with NO Authorization header (Ollama is keyless —
   * the `apiKey` param is ignored). Yields `delta` chunks as text arrives, a
   * terminal `done`, or a terminal `error` (never throws — failures surface as an
   * `error` chunk so the UI can render them, with a hint to check the daemon).
   */
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamChunk> {
    const { model, messages, signal } = params

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        // No Authorization header — Ollama runs locally and takes no key.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: toMessages(messages), stream: true }),
        signal
      })
    } catch (err) {
      // Connection refused is the common "daemon not running" case — add a hint.
      const detail = err instanceof Error ? err.message : String(err)
      yield {
        type: 'error',
        message: `Could not reach Ollama at ${this.baseUrl} (${detail}). Is Ollama running?`
      }
      return
    }

    if (!response.ok) {
      yield { type: 'error', message: await this.readErrorMessage(response) }
      return
    }

    const body = response.body
    if (!body) {
      yield { type: 'error', message: 'Response had no body to stream' }
      return
    }

    // getReader() + TextDecoder is the robust, version-agnostic way to read a
    // streamed body in Node; reuse the shared SseParser for the framing.
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        // stream:true so the decoder accumulates partial multibyte sequences.
        const text = decoder.decode(value, { stream: true })
        for (const sse of parser.push(text)) {
          const chunk = handleData(sse.data)
          if (chunk) {
            yield chunk
            if (chunk.type !== 'delta') return
          }
        }
      }

      // Flush any tail the parser is still holding (a server may close right
      // after the last data line without the trailing blank line), then emit a
      // default `done` if the stream ended without a terminal event.
      for (const sse of parser.flush()) {
        const chunk = handleData(sse.data)
        if (chunk) {
          yield chunk
          if (chunk.type !== 'delta') return
        }
      }
      yield { type: 'done' }
    } catch (err) {
      // Includes AbortError when `signal` fires mid-stream — surface uniformly.
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    } finally {
      // Releasing the lock lets the underlying connection be cancelled/cleaned.
      reader.releaseLock()
    }
  }

  /**
   * Give a local model Sunny's tools (web search/fetch) via OpenAI-style function
   * calling against Ollama's `/v1/chat/completions` endpoint (keyless). This is
   * how a fully-local model gets web access — see tools/web.ts + tool-loop.ts.
   */
  streamWithTools(params: StreamWithToolsParams): AsyncIterable<StreamChunk> {
    return runToolLoop({
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: {}, // keyless local daemon — no Authorization
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      runTool: params.runTool,
      signal: params.signal,
      maxRounds: params.maxToolRounds
    })
  }

  /** Best-effort human-readable message from a non-2xx body, with a daemon hint. */
  private async readErrorMessage(response: Response): Promise<string> {
    let detail = `${response.status} ${response.statusText}`
    try {
      const text = await response.text()
      try {
        const json = JSON.parse(text) as { error?: { message?: string } | string }
        if (typeof json.error === 'string' && json.error.trim() !== '') detail = json.error
        else if (typeof json.error === 'object' && json.error?.message) detail = json.error.message
        else if (text.trim() !== '') detail = text.trim()
      } catch {
        if (text.trim() !== '') detail = text.trim()
      }
    } catch {
      // Reading the body failed — keep the status line.
    }
    return `Ollama request failed: ${detail}. Is Ollama running and the model pulled?`
  }
}

/**
 * Create an Ollama embedder (`provider = 'ollama'`) for a pulled embedding model.
 * `embed(texts)` POSTs /api/embed with {model, input}; Ollama returns one vector
 * per input IN ORDER as {embeddings: number[][]}. Empty input → [] with no call.
 * (The embedding dimension is model-dependent, so — unlike the OpenAI embedder —
 * we do not assert a fixed dimension here; the storage layer owns that contract.)
 */
export function createOllamaEmbedder(baseUrl: string, model: string): Embedder {
  const root = normalizeBaseUrl(baseUrl)
  return {
    provider: 'ollama',
    model,

    async embed(texts: string[]): Promise<number[][]> {
      // No inputs → no network call.
      if (texts.length === 0) return []

      const response = await fetch(`${root}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
      })

      if (!response.ok) {
        let detail = `${response.status} ${response.statusText}`
        try {
          const text = await response.text()
          if (text.trim() !== '') detail = text.trim()
        } catch {
          // Keep the status line.
        }
        throw new Error(
          `Ollama embeddings request failed: ${detail}. Is Ollama running and the model pulled?`
        )
      }

      const json = (await response.json()) as EmbedResponse
      const embeddings = json.embeddings
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new Error(
          `Ollama embeddings returned ${embeddings?.length ?? 0} vectors for ${texts.length} inputs`
        )
      }
      return embeddings
    }
  }
}
