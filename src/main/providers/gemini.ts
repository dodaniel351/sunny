// Google Gemini adapter for the uniform Provider interface (spec §4 / §4a).
//
// Talks to the Google Generative Language API (v1beta). Like the OpenAI adapter
// this file is pure provider logic: it does NOT import the secret store, DB,
// electron, or repositories — the resolved `apiKey` is passed in (see types.ts),
// so the adapter stays unit-friendly.
//
// ── Streaming protocol, verified against live docs 2026-06-17 ──
// Source: https://ai.google.dev/api/generate-content (streamGenerateContent)
//   and https://ai.google.dev/gemini-api/docs/models
// Endpoint: POST .../models/{model}:streamGenerateContent?alt=sse&key={apiKey}
// With `alt=sse` the response is a Server-Sent Events stream of `data: {json}`
// lines (no `event:` field). Each payload is a GenerateContentResponse chunk;
// the incremental text lives at:
//   candidates[0].content.parts[0].text
// There is no explicit terminal event — the stream simply ends, so we emit a
// default `{type:'done'}` once the body closes.
//
// Request shape (also confirmed): `contents` is an array of role-tagged turns
// ({ role: 'user'|'model', parts: [{ text }] }); system guidance goes in the
// top-level `systemInstruction` field. We map `system` turns → systemInstruction
// and `assistant` turns → role `model`.

import type {
  ChatTurn,
  KeyValidationResult,
  ModelInfo,
  Provider,
  StreamChatParams,
  StreamChunk,
  StreamWithToolsParams,
  ToolCall,
  ToolSpec
} from './types'
import { SseParser } from './sse'
import { describeToolCall } from '@main/tools/describe'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** A part of a streamChat content turn: text, or inline image bytes. */
type GeminiContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }

/** A Gemini content turn: a role plus one or more text / inline-image parts. */
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiContentPart[]
}

/** The slice of each streamed GenerateContentResponse chunk we care about. */
interface GeminiStreamChunk {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  /** Cumulative token counts (the last chunk carries the final totals). */
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { code?: number; message?: string; status?: string }
}

/** The error envelope returned on a non-2xx response. */
interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string }
}

// ── Function-calling shapes, verified against live docs 2026-06-18 ──
// Source: https://ai.google.dev/gemini-api/docs/function-calling
//   and  https://ai.google.dev/gemini-api/docs/tool-combination
// Request: function tools go in `tools: [{ functionDeclarations: [{ name,
//   description, parameters: <JSON schema> }] }]`. A function call comes back as
//   a candidate `content.parts[]` entry `{ functionCall: { name, args } }`
//   (Gemini 3 also adds an `id`). The result is returned by appending a content
//   with role `user` (verified — NOT 'function'/'tool') whose parts are
//   `[{ functionResponse: { name, response: {...} } }]`.
//
// Coexistence with google_search: combining the built-in `google_search` tool
// with `functionDeclarations` in one request is Preview and Gemini 3-only (it
// requires `include_server_side_tool_invocations: true`, VALIDATED mode, and
// echoing per-call `id`/`thought_signature`). Sunny defaults to gemini-2.5-flash
// and lets the user pick across the 2.5 family, so when agent function tools are
// present we send ONLY `functionDeclarations` and omit google_search.

/** A function the model may call, in Gemini's declaration shape. */
interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A part of a Gemini content turn: text, inline image bytes, a model-emitted
 *  call, or our result. */
interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

/** A content turn that may carry function-call/response parts (superset of the
 *  text-only GeminiContent used by streamChat). */
interface GeminiToolContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** The slice of a non-streamed generateContent response we read for tool rounds. */
interface GeminiGenerateContentResponse {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] }
    finishReason?: string
  }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { code?: number; message?: string; status?: string }
}

/**
 * Split chat turns into the top-level `systemInstruction` (all system turns
 * joined) and the `contents` array (user/assistant turns, with `assistant`
 * remapped to Gemini's `model` role).
 */
function mapMessages(messages: ChatTurn[]): {
  systemInstruction?: { parts: { text: string }[] }
  contents: GeminiContent[]
} {
  const systemParts: string[] = []
  const contents: GeminiContent[] = []

  for (const turn of messages) {
    if (turn.role === 'system') {
      systemParts.push(turn.content)
      continue
    }
    const role = turn.role === 'assistant' ? 'model' : 'user'
    if (turn.images && turn.images.length > 0) {
      const parts: GeminiContentPart[] = []
      if (turn.content) parts.push({ text: turn.content })
      for (const img of turn.images) {
        parts.push({
          inlineData: { mimeType: img.mediaType, data: img.dataUrl.replace(/^data:[^;]+;base64,/, '') }
        })
      }
      contents.push({ role, parts })
    } else {
      contents.push({ role, parts: [{ text: turn.content }] })
    }
  }

  if (systemParts.length === 0) return { contents }
  return { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] }, contents }
}

/** Extract the incremental text delta from one streamed chunk, if present. */
function extractDelta(chunk: GeminiStreamChunk): string | undefined {
  const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text
  return typeof text === 'string' && text !== '' ? text : undefined
}

/**
 * Map a non-2xx error body to a friendly message. API-key problems (400/403
 * whose message mentions the key) get a stable, recognizable string so the UI
 * can prompt the user to fix their credential.
 */
function readErrorMessage(status: number, body: GeminiErrorBody): string {
  const message = body.error?.message ?? ''
  if ((status === 400 || status === 403) && /api[\s_-]?key|api key not valid/i.test(message)) {
    return 'Invalid Google API key'
  }
  if (message !== '') return message
  return `Google Gemini request failed (${status})`
}

export class GeminiProvider implements Provider {
  readonly kind = 'google'
  readonly label = 'Google Gemini'
  readonly defaultModel = 'gemini-2.5-flash'

  /** Gemini answers with its OWN built-in web search (Google Search grounding).
   *  When the web toggle is on, the runtime sets `webSearch: true` on
   *  `streamChat` and we attach the native `google_search` tool. */
  readonly supportsWebSearch = true

  /**
   * Current Gemini models on the Generative Language API (ids + context windows
   * confirmed from the Gemini docs, 2026-06-17:
   * https://ai.google.dev/gemini-api/docs/models). gemini-3.5-flash is the GA
   * flagship; the 2.5 family (pro/flash/flash-lite) is the stable
   * price-performance lineup. gemini-2.0-flash was shut down 2026-06-01, so it
   * is removed. Newer 3.x pro/flash-lite tiers remain preview-only and are
   * omitted until GA. gemini-2.5-flash stays the balanced, cost-effective
   * default per spec.
   */
  listModels(): ModelInfo[] {
    return [
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', contextWindow: 1048576 }
    ]
  }

  /**
   * Cheap auth check used when a key is saved in Settings (spec §4a). A GET to
   * /v1beta/models is the standard lightweight probe; an 8s timeout keeps a hung
   * network from blocking the save flow.
   */
  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    try {
      const url = `${API_BASE}/models?key=${encodeURIComponent(apiKey)}`
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(8000)
      })

      if (response.ok) return { ok: true }
      if (response.status === 400 || response.status === 403) {
        return { ok: false, error: 'Invalid API key' }
      }
      return { ok: false, error: `${response.status} ${response.statusText}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Stream a completion as normalized chunks. Yields `delta` chunks as text
   * arrives, a terminal `done`, or a terminal `error` (never throws to the
   * caller — failures surface as an `error` chunk so the UI can render them).
   */
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamChunk> {
    const { apiKey, model, messages, signal, webSearch } = params
    const { systemInstruction, contents } = mapMessages(messages)
    const url = `${API_BASE}/models/${encodeURIComponent(
      model
    )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
          // Native server-side Google Search grounding (Gemini 2.5/3.x). The
          // empty-object value is required — `true`/the deprecated
          // `google_search_retrieval` are wrong. groundingMetadata rides along
          // on candidates and is ignored; text streaming is unchanged.
          ...(webSearch ? { tools: [{ google_search: {} }] } : {})
        }),
        signal
      })
    } catch (err) {
      // Network-level failure (DNS, connection refused, abort before headers).
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return
    }

    if (!response.ok) {
      let body: GeminiErrorBody = {}
      try {
        body = (await response.json()) as GeminiErrorBody
      } catch {
        // Body was missing or not JSON — fall back to the status-only message.
      }
      yield { type: 'error', message: readErrorMessage(response.status, body) }
      return
    }

    const body = response.body
    if (!body) {
      yield { type: 'error', message: 'Google Gemini response had no body to stream' }
      return
    }

    // getReader() + TextDecoder is the robust, version-agnostic way to read a
    // streamed body in Node (async iteration over response.body is not reliable
    // across Node versions).
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    // usageMetadata is cumulative per chunk — the last seen values are the
    // final totals, emitted once before the terminal `done`.
    let promptTokens = 0
    let completionTokens = 0
    const takeUsage = (data: string): void => {
      try {
        const parsed = JSON.parse(data) as GeminiStreamChunk
        const usage = parsed.usageMetadata
        if (typeof usage?.promptTokenCount === 'number') promptTokens = usage.promptTokenCount
        if (typeof usage?.candidatesTokenCount === 'number')
          completionTokens = usage.candidatesTokenCount
      } catch {
        // Non-JSON line — handleEvent skips it too.
      }
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        // stream:true so the decoder accumulates partial multibyte sequences.
        const text = decoder.decode(value, { stream: true })
        for (const sse of parser.push(text)) {
          takeUsage(sse.data)
          const chunk = this.handleEvent(sse.data)
          if (chunk) {
            yield chunk
            if (chunk.type !== 'delta') return
          }
        }
      }

      // Flush any tail the parser still holds (a server may close right after
      // the last data line without a trailing blank line).
      for (const sse of parser.flush()) {
        takeUsage(sse.data)
        const chunk = this.handleEvent(sse.data)
        if (chunk) {
          yield chunk
          if (chunk.type !== 'delta') return
        }
      }

      // Gemini has no explicit terminal event — the stream just ends.
      if (promptTokens > 0 || completionTokens > 0)
        yield { type: 'usage', promptTokens, completionTokens }
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
   * Map one decoded SSE data payload to a normalized chunk, or undefined for
   * chunks that carry no text (e.g. a final chunk with only a finishReason).
   */
  private handleEvent(data: string): StreamChunk | undefined {
    let chunk: GeminiStreamChunk
    try {
      chunk = JSON.parse(data) as GeminiStreamChunk
    } catch {
      // A non-JSON data line is not actionable; skip rather than fail the stream.
      return undefined
    }

    // An in-band error chunk can appear even after a 200 response.
    if (chunk.error?.message) return { type: 'error', message: chunk.error.message }

    const delta = extractDelta(chunk)
    return delta === undefined ? undefined : { type: 'delta', text: delta }
  }

  /**
   * Run an agentic function-calling loop so the model can invoke Sunny's own
   * tools (file/shell/web). Unlike `streamChat` this uses NON-streaming
   * `generateContent`: a tool round-trip is far simpler to parse complete than
   * to reassemble from SSE, and final answers are emitted as a single `delta`.
   * Liveness comes from `status` chunks between rounds.
   *
   * Each round reads `candidates[0].content.parts`. If any `functionCall` parts
   * are present, we echo the model's content, run each tool, append a single
   * `user` content carrying all `functionResponse` parts, and loop. With no
   * function calls the concatenated `text` parts become the final answer. On the
   * last round we withhold `functionDeclarations` so the model must answer.
   *
   * Never throws: HTTP/parse failures and cancellation surface as an `error`
   * chunk so the UI can render them uniformly.
   */
  async *streamWithTools(params: StreamWithToolsParams): AsyncIterable<StreamChunk> {
    const { apiKey, model, messages, signal, tools, runTool } = params
    const maxRounds = params.maxToolRounds ?? 5
    // Token accounting across rounds, emitted once before `done`.
    let promptTokens = 0
    let completionTokens = 0

    const { systemInstruction, contents: baseContents } = mapMessages(messages)
    // Widen the text-only base turns to the tool-capable content shape so we can
    // append functionCall/functionResponse parts as the loop progresses.
    const contents: GeminiToolContent[] = baseContents.map((c) => ({
      role: c.role,
      parts: c.parts.map<GeminiPart>((p) =>
        'text' in p ? { text: p.text } : { inlineData: p.inlineData }
      )
    }))

    const functionDeclarations: GeminiFunctionDeclaration[] = tools.map((t: ToolSpec) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }))

    const url = `${API_BASE}/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`

    for (let round = 0; round < maxRounds; round++) {
      const finalRound = round === maxRounds - 1
      // The per-round fetch carries the signal, but a tool call between rounds
      // can take seconds — bail promptly when the turn is cancelled.
      if (signal?.aborted) {
        yield { type: 'error', message: 'Cancelled.' }
        return
      }

      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents,
            ...(systemInstruction ? { systemInstruction } : {}),
            // Withhold the declarations on the last round so the model produces a
            // text answer instead of another (un-actionable) function call. We
            // deliberately omit google_search: combining it with
            // functionDeclarations is Gemini-3-only Preview (see note above).
            ...(finalRound ? {} : { tools: [{ functionDeclarations }] })
          }),
          signal
        })
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }

      if (!response.ok) {
        let body: GeminiErrorBody = {}
        try {
          body = (await response.json()) as GeminiErrorBody
        } catch {
          // Body was missing or not JSON — fall back to the status-only message.
        }
        yield { type: 'error', message: readErrorMessage(response.status, body) }
        return
      }

      let json: GeminiGenerateContentResponse
      try {
        json = (await response.json()) as GeminiGenerateContentResponse
      } catch {
        yield { type: 'error', message: 'Google Gemini returned a malformed response.' }
        return
      }

      // An in-band error can appear even after a 200 response.
      if (json.error?.message) {
        yield { type: 'error', message: json.error.message }
        return
      }
      if (typeof json.usageMetadata?.promptTokenCount === 'number')
        promptTokens += json.usageMetadata.promptTokenCount
      if (typeof json.usageMetadata?.candidatesTokenCount === 'number')
        completionTokens += json.usageMetadata.candidatesTokenCount

      const candidate = json.candidates?.[0]
      const parts = candidate?.content?.parts ?? []
      const functionCalls = parts.filter(
        (
          p
        ): p is GeminiPart & { functionCall: { name?: string; args?: Record<string, unknown> } } =>
          p.functionCall !== undefined && typeof p.functionCall.name === 'string'
      )

      if (functionCalls.length > 0) {
        // Echo the model's turn (including the functionCall parts) so the next
        // round has the full context, then run each tool and append a single
        // `user` content carrying every functionResponse part.
        contents.push({ role: 'model', parts })

        const responseParts: GeminiPart[] = []
        for (const part of functionCalls) {
          if (signal?.aborted) {
            yield { type: 'error', message: 'Cancelled.' }
            return
          }
          const name = part.functionCall.name ?? ''
          const args = part.functionCall.args ?? {}
          const call: ToolCall = { id: name, name, arguments: JSON.stringify(args) }
          yield { type: 'status', text: describeToolCall(call) }

          let result: string
          try {
            result = await runTool(call)
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`
          }
          // functionResponse.response must be an object; wrap the tool's text.
          responseParts.push({ functionResponse: { name, response: { result } } })
        }

        contents.push({ role: 'user', parts: responseParts })
        continue // ask the model again now that it has the tool results
      }

      // No function calls → concatenate the text parts into the final answer.
      const text = parts
        .map((p) => p.text)
        .filter((t): t is string => typeof t === 'string' && t !== '')
        .join('')
      if (text) yield { type: 'delta', text }
      if (promptTokens > 0 || completionTokens > 0)
        yield { type: 'usage', promptTokens, completionTokens }
      yield { type: 'done', finishReason: candidate?.finishReason ?? 'stop' }
      return
    }

    // Defensive: the loop returns on the final round (declarations withheld), so
    // this is unreachable in practice — emit a clean terminal just in case.
    yield { type: 'done', finishReason: 'length' }
  }
}
