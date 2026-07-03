// One configurable adapter for OpenAI-COMPATIBLE providers (spec §4a).
//
// Many providers (OpenRouter, Groq, Together, Fireworks, …) expose the *older*
// OpenAI `/chat/completions` shape rather than the newer `/responses` API used
// by the native OpenAI adapter. They differ only by base URL, API key, and the
// catalog of model ids — the wire protocol is identical. So instead of writing
// one adapter per vendor, we write ONE adapter parameterized by a small config
// object and ship thin PRESET factories (`createOpenRouterProvider`,
// `createGroqProvider`) that fill in the per-vendor specifics. Adding another
// compatible vendor later is a one-line factory, not a new file.
//
// Like the other adapters this file is pure provider logic: it does NOT import
// the secret store, DB, electron, or repositories. The resolved `apiKey` is
// passed in per call (see types.ts), so the adapter stays unit-friendly.
//
// ── Chat-completions streaming protocol ──
// Source: https://platform.openai.com/docs/api-reference/chat/streaming
//   POST {baseUrl}/chat/completions  with `stream: true`
//   SSE `data: {json}` lines; incremental text is at
//     json.choices[0].delta.content
//   A literal `data: [DONE]` line terminates the stream. The final non-[DONE]
//   chunk carries json.choices[0].finish_reason (e.g. 'stop', 'length').

import type {
  ChatTurn,
  KeyValidationResult,
  ModelInfo,
  Provider,
  StreamChatParams,
  StreamChunk,
  StreamWithToolsParams
} from './types'
import { SseParser } from './sse'
import { runToolLoop } from './tool-loop'

/** Per-vendor configuration that specializes the one adapter into a provider. */
export interface OpenAICompatibleConfig {
  /** Stable id stored on the `providers` row (e.g. 'openrouter', 'groq'). */
  kind: string
  /** Human-readable name shown in the UI. */
  label: string
  /** API root WITHOUT a trailing slash, e.g. 'https://api.groq.com/openai/v1'. */
  baseUrl: string
  /** Pre-selected model id; must be present in `models`. */
  defaultModel: string
  /** Static, known-good models — used as the fallback (and before connecting). */
  models: ModelInfo[]
  /**
   * When true, expose `fetchModels()` so the IPC layer pulls the LIVE catalog
   * from GET /models once connected (e.g. OpenRouter's 300+). Leave false for
   * vendors with a small fixed set or no /models route (e.g. Perplexity).
   */
  liveModels?: boolean
  /** Extra request headers some vendors expect (e.g. OpenRouter ranking headers). */
  extraHeaders?: Record<string, string>
  /**
   * True when this provider answers with built-in web search. Web-native vendors
   * (e.g. Perplexity) set this; aggregators that just proxy other models
   * (OpenRouter, Groq) leave it false/undefined. Defaults to false.
   */
  supportsWebSearch?: boolean
  /**
   * Optional model id used to validate a saved key via a tiny POST
   * /chat/completions probe instead of the default GET /models. Set this for
   * vendors that don't expose a GET /models listing (e.g. Perplexity, whose
   * /models route 404s). When omitted, validateKey uses the GET /models probe.
   */
  validateModel?: string
}

/** The slice of each streamed chat-completions chunk we care about. */
interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null }
    finish_reason?: string | null
  }>
}

/** Chat-completions message content: a plain string, or (for image turns) an
 *  array of text + image_url parts (the OpenAI-vision shape OpenRouter/Grok use). */
type ChatCompletionContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

/** Map our ChatTurn[] to the chat-completions `messages` array. Text turns stay a
 *  plain string; a turn with images becomes a text + image_url parts array. */
function toMessages(
  messages: ChatTurn[]
): Array<{ role: ChatTurn['role']; content: ChatCompletionContent }> {
  return messages.map((turn) => {
    if (turn.images && turn.images.length > 0) {
      const parts: Exclude<ChatCompletionContent, string> = []
      if (turn.content) parts.push({ type: 'text', text: turn.content })
      for (const img of turn.images) {
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
      }
      return { role: turn.role, content: parts }
    }
    return { role: turn.role, content: turn.content }
  })
}

/** Best-effort extraction of a human-readable message from an error response body. */
async function readErrorMessage(response: Response): Promise<string> {
  // 401 is the common "bad key" case; give it a stable, friendly message.
  if (response.status === 401) return 'Invalid API key'
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string }
      if (typeof json.error === 'string' && json.error.trim() !== '') return json.error
      if (typeof json.error === 'object' && json.error?.message) return json.error.message
    } catch {
      // Body was not JSON — fall through to the raw text / status line.
    }
    if (text.trim() !== '') return text.trim()
  } catch {
    // Reading the body failed — fall through to the status line.
  }
  return `Request failed (${response.status} ${response.statusText})`
}

export class OpenAICompatibleProvider implements Provider {
  readonly kind: string
  readonly label: string
  readonly defaultModel: string
  readonly supportsWebSearch: boolean
  private readonly baseUrl: string
  private readonly models: ModelInfo[]
  private readonly extraHeaders: Record<string, string>
  private readonly validateModel?: string
  /** Present only when `liveModels` is set — see the Provider interface. */
  fetchModels?: (apiKey: string) => Promise<ModelInfo[]>

  constructor(config: OpenAICompatibleConfig) {
    this.kind = config.kind
    this.label = config.label
    this.defaultModel = config.defaultModel
    this.supportsWebSearch = config.supportsWebSearch ?? false
    // Defensively strip a trailing slash so `${baseUrl}/chat/completions` never
    // produces a double slash for vendors that include one.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.models = config.models
    this.extraHeaders = config.extraHeaders ?? {}
    this.validateModel = config.validateModel
    if (config.liveModels) this.fetchModels = (apiKey) => this.loadModels(apiKey)
  }

  listModels(): ModelInfo[] {
    return this.models
  }

  /**
   * Pull the live model catalog from GET /models (the standard OpenAI-compatible
   * listing). OpenRouter returns 300+ here. The apiKey is optional (OpenRouter's
   * /models is public); when present it's sent as a bearer. An 8s timeout keeps a
   * hung network from blocking the providers list. Throws on a non-OK response so
   * the caller can fall back to the static list.
   */
  private async loadModels(apiKey: string): Promise<ModelInfo[]> {
    const headers: Record<string, string> = { ...this.extraHeaders }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) throw new Error(`GET /models failed (${res.status})`)
    const json = (await res.json()) as {
      data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown }>
    }
    const rows = Array.isArray(json.data) ? json.data : []
    const models = rows
      .filter((m): m is { id: string; name?: string; context_length?: number } => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        label: typeof m.name === 'string' && m.name.trim() ? m.name : m.id,
        ...(typeof m.context_length === 'number' ? { contextWindow: m.context_length } : {})
      }))
    models.sort((a, b) => a.label.localeCompare(b.label))
    return models
  }

  /**
   * Cheap auth check used when a key is saved in Settings (spec §4a). A GET to
   * /models is the standard lightweight probe across OpenAI-compatible servers;
   * an 8s timeout keeps a hung network from blocking the save flow. Vendors
   * without a GET /models listing (e.g. Perplexity) set `validateModel` so this
   * probes a minimal POST /chat/completions instead — see makeValidateRequest.
   */
  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const { url, init } = this.makeValidateRequest(apiKey)
    try {
      const response = await fetch(url, init)

      if (response.ok) return { ok: true }
      if (response.status === 401) return { ok: false, error: 'Invalid API key' }
      return { ok: false, error: `${response.status} ${response.statusText}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Build the validateKey probe request. Default: GET /models. When the vendor
   * has no /models listing (`validateModel` set), send a minimal 1-token POST
   * /chat/completions instead — a valid key returns 200 (or a non-401 usage/quota
   * error), a bad key returns 401, which validateKey maps the same way.
   */
  private makeValidateRequest(apiKey: string): { url: string; init: RequestInit } {
    const headers = { Authorization: `Bearer ${apiKey}`, ...this.extraHeaders }
    const signal = AbortSignal.timeout(8000)

    if (this.validateModel === undefined) {
      return { url: `${this.baseUrl}/models`, init: { method: 'GET', headers, signal } }
    }

    return {
      url: `${this.baseUrl}/chat/completions`,
      init: {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.validateModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        signal
      }
    }
  }

  /**
   * Stream a completion as normalized chunks. Yields `delta` chunks as text
   * arrives, a terminal `done`, or a terminal `error` (never throws to the
   * caller — failures surface as an `error` chunk so the UI can render them).
   */
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamChunk> {
    const { apiKey, model, messages, signal } = params

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...this.extraHeaders
        },
        body: JSON.stringify({ model, messages: toMessages(messages), stream: true }),
        signal
      })
    } catch (err) {
      // Network-level failure (DNS, connection refused, abort before headers).
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return
    }

    if (!response.ok) {
      yield { type: 'error', message: await readErrorMessage(response) }
      return
    }

    const body = response.body
    if (!body) {
      yield { type: 'error', message: 'Response had no body to stream' }
      return
    }

    // getReader() + TextDecoder is the robust, version-agnostic way to read a
    // streamed body in Node (async iteration over response.body is not reliable
    // across Node versions). We reuse the shared SseParser for framing.
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

      // Flush any tail the decoder/parser are still holding (a server may close
      // right after the last data line without the trailing blank line), then
      // emit a default `done` if the stream ended without a terminal event.
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
   * Give the model Sunny's own tools (web search/fetch) via OpenAI-style function
   * calling. Used for providers WITHOUT native web search — Grok, OpenRouter,
   * Groq — so the web toggle still works on them. (Perplexity sets
   * `supportsWebSearch`, so the runtime uses its native path and never calls this.)
   */
  streamWithTools(params: StreamWithToolsParams): AsyncIterable<StreamChunk> {
    return runToolLoop({
      url: `${this.baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${params.apiKey}`, ...this.extraHeaders },
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      runTool: params.runTool,
      signal: params.signal,
      maxRounds: params.maxToolRounds
    })
  }
}

/**
 * Map one decoded SSE `data:` payload to a normalized chunk, or undefined for
 * lines we ignore (the `[DONE]` sentinel, non-JSON lines, empty deltas). Kept a
 * free function — it has no dependency on instance state and so is the natural
 * unit-test surface for delta extraction.
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

  // Many providers send the final chunk with an empty delta + a finish_reason;
  // surface that as the terminal `done`. (Empty interim deltas just yield nothing.)
  const finishReason = choice?.finish_reason
  if (typeof finishReason === 'string' && finishReason !== '') {
    return { type: 'done', finishReason }
  }

  return undefined
}

// ── Presets ──────────────────────────────────────────────────────────────────
// Thin factories over the one adapter above. Model ids web-verified 2026-06-17.

/**
 * OpenRouter (https://openrouter.ai) — an aggregator exposing 400+ models behind
 * the chat-completions API. The optional HTTP-Referer / X-Title headers are the
 * conventional way to identify an app for OpenRouter's rankings.
 */
export function createOpenRouterProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    kind: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-3.5-flash',
    // Live catalog (300+) is fetched once connected; these are the fallback /
    // pre-connect set and the default.
    liveModels: true,
    models: [
      { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash (Google)', contextWindow: 1048576 },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5 (OpenAI)', contextWindow: 1050000 },
      {
        id: 'anthropic/claude-opus-4.8',
        label: 'Claude Opus 4.8 (Anthropic)',
        contextWindow: 1000000
      },
      {
        id: 'anthropic/claude-opus-4.7',
        label: 'Claude Opus 4.7 (Anthropic)',
        contextWindow: 1000000
      }
    ],
    extraHeaders: {
      'HTTP-Referer': 'https://sunny.app',
      'X-Title': 'Sunny'
    }
  })
}

/**
 * Groq (https://groq.com) — extremely fast inference of open models behind the
 * chat-completions API. Model ids confirmed against console.groq.com/docs/models.
 */
export function createGroqProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    kind: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', contextWindow: 131072 },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', contextWindow: 131072 },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', contextWindow: 131072 },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', contextWindow: 131072 }
    ]
  })
}

/**
 * Perplexity (https://www.perplexity.ai) — a web-native provider whose Sonar
 * models answer with live web grounding on EVERY request, so it's a natural
 * handoff target for web-needing tasks (supportsWebSearch: true). Because search
 * is intrinsic to the model, there's no per-request flag to set — the normal
 * chat-completions call already searches, so `streamChat` needs no special case.
 *
 * OpenAI-compatible at https://api.perplexity.ai (POST /chat/completions, SSE
 * `stream: true`). Verified live on 2026-06-17: a bad-key POST to
 * https://api.perplexity.ai/chat/completions returns 401 with the OpenAI error
 * envelope. Sonar model ids verified the same day against
 * https://docs.perplexity.ai/getting-started/models. Perplexity has no GET
 * /models listing (it 404s), so `validateModel` routes key validation through a
 * minimal /chat/completions probe instead.
 */
export function createPerplexityProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    kind: 'perplexity',
    label: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar-pro',
    models: [
      { id: 'sonar', label: 'Sonar', contextWindow: 128000 },
      { id: 'sonar-pro', label: 'Sonar Pro', contextWindow: 200000 },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', contextWindow: 128000 },
      { id: 'sonar-deep-research', label: 'Sonar Deep Research', contextWindow: 128000 }
    ],
    supportsWebSearch: true,
    validateModel: 'sonar'
  })
}
