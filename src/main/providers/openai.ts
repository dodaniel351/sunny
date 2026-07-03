// OpenAI adapter for the uniform Provider interface (spec §4 / §4a).
//
// Uses the Responses API (POST /v1/responses), which the spec prefers over
// /v1/chat/completions. This file is intentionally pure provider logic: it does
// NOT import the secret store, DB, electron, or repositories — the resolved
// `apiKey` is passed in (see types.ts), so the adapter stays unit-friendly.
//
// ── Responses-API streaming protocol, verified against live docs 2026-06-17 ──
// Source: https://developers.openai.com/api/reference/resources/responses/streaming-events
//   and https://developers.openai.com/api/docs/guides/streaming-responses
// Confirmed event `type` strings carried INSIDE each SSE data payload's JSON
// (the Responses API does not use the SSE `event:` field):
//   - 'response.output_text.delta' → incremental text, in the `delta` string field
//   - 'response.completed'         → terminal success (carries final response)
//   - 'response.failed'            → terminal generation failure (response.error)
//   - 'error'                      → out-of-band transport/stream error
// Request shape, also confirmed: `input` accepts a string OR an array of
// { role, content } items, and system guidance goes in the top-level
// `instructions` field (it takes priority over input and is cleaner than a
// system/developer role item). We map `system` turns → `instructions`.
//
// ── Responses-API function calling, verified against live docs 2026-06-18 ──
// Source: https://developers.openai.com/api/docs/guides/function-calling
//   (+ output item shapes: https://developers.openai.com/api/docs/guides/text)
// Unlike chat/completions, Responses uses a FLAT custom-function tool shape:
//   { type:'function', name, description, parameters }  (NOT { function:{…} }).
// A requested call comes back as an `output` item:
//   { type:'function_call', id, call_id, name, arguments:<json-string> }.
// To answer it, append that SAME function_call item back to `input` PLUS a
//   { type:'function_call_output', call_id, output:<string> }  item, then
// re-POST. (`call_id` — not `id` — is the link between the two.) The hosted
// `web_search` tool runs server-side and is NOT surfaced as a function_call, so
// non-function output items are skipped. The final assistant text lives in
// output `message` items: { type:'message', content:[{ type:'output_text',
// text }] } — `output_text` is only an SDK convenience field, so we aggregate
// the `output_text` parts ourselves.

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

const RESPONSES_URL = 'https://api.openai.com/v1/responses'
const MODELS_URL = 'https://api.openai.com/v1/models'

// The hosted web-search tool for the Responses API. The GA tool type is
// `web_search` (the older `web_search_preview` lacks the newer controls and is
// kept only for legacy integrations). Verified against the live OpenAI docs on
// 2026-06-17: https://developers.openai.com/api/docs/guides/tools-web-search
// With the tool enabled, the model still streams its final answer as
// `response.output_text.delta` events after the server-side search runs, so the
// existing SSE parser needs no change (streaming guide, same date:
// https://developers.openai.com/api/docs/guides/streaming-responses).
const WEB_SEARCH_TOOL = { type: 'web_search' } as const

// Doc-confirmed SSE event type strings (see header comment).
const EVENT_TEXT_DELTA = 'response.output_text.delta'
const EVENT_COMPLETED = 'response.completed'
const EVENT_FAILED = 'response.failed'
const EVENT_ERROR = 'error'

/** A Responses-API input item: a role-tagged message. Content is a plain string,
 *  or (for image turns) an array of input_text / input_image parts. */
type ResponsesInputContent =
  | string
  | Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }>
interface ResponsesInputItem {
  role: 'user' | 'assistant'
  content: ResponsesInputContent
}

/** The slice of each streamed event payload we care about. */
interface ResponsesStreamEvent {
  type?: string
  delta?: string
  response?: {
    status?: string
    error?: { message?: string } | null
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  error?: { message?: string } | string
}

/** A custom function tool in the Responses-API FLAT shape (see header comment). */
interface ResponsesFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** The function-call item the model emits in the response `output` array. We
 *  echo it back verbatim into `input` (alongside its result) on the next round. */
interface ResponsesFunctionCallItem {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
}

/** The result item we append to `input` to answer a function_call. */
interface ResponsesFunctionCallOutput {
  type: 'function_call_output'
  call_id: string
  output: string
}

/** Any item we put on the `input` array across tool rounds. */
type ResponsesInput = ResponsesInputItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutput

/** One item from a NON-streaming response's `output` array (the parts we read). */
interface ResponsesOutputItem {
  type?: string
  // function_call fields
  call_id?: string
  name?: string
  arguments?: string
  id?: string
  // message fields
  content?: Array<{ type?: string; text?: string }>
}

/** The slice of a non-streamed /v1/responses body we read in the tool loop. */
interface ResponsesBody {
  output?: ResponsesOutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string } | string
}

/** Map a Sunny ToolSpec (chat/completions nested shape) → the Responses flat
 *  function tool shape. */
function toResponsesFunctionTool(spec: ToolSpec): ResponsesFunctionTool {
  return {
    type: 'function',
    name: spec.function.name,
    description: spec.function.description,
    parameters: spec.function.parameters
  }
}

/** Collect the assistant text from a non-streaming response's `output` array by
 *  concatenating every `output_text` part of every `message` item. */
function collectOutputText(output: ResponsesOutputItem[]): string {
  let text = ''
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (part.type === 'output_text' && typeof part.text === 'string') text += part.text
    }
  }
  return text
}

/**
 * Split chat turns into the top-level `instructions` (all system turns joined)
 * and the `input` array (user/assistant turns). Keeping system content out of
 * `input` matches the API's recommended shape and its priority semantics.
 */
function mapMessages(messages: ChatTurn[]): {
  instructions?: string
  input: ResponsesInputItem[]
} {
  const systemParts: string[] = []
  const input: ResponsesInputItem[] = []

  for (const turn of messages) {
    if (turn.role === 'system') {
      systemParts.push(turn.content)
      continue
    }
    if (turn.images && turn.images.length > 0) {
      const parts: Exclude<ResponsesInputContent, string> = []
      if (turn.content) parts.push({ type: 'input_text', text: turn.content })
      for (const img of turn.images) parts.push({ type: 'input_image', image_url: img.dataUrl })
      input.push({ role: turn.role, content: parts })
    } else {
      input.push({ role: turn.role, content: turn.content })
    }
  }

  const instructions = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  return instructions === undefined ? { input } : { instructions, input }
}

/** Best-effort extraction of a human-readable message from an error response body. */
async function readErrorMessage(response: Response): Promise<string> {
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
  return `OpenAI request failed (${response.status} ${response.statusText})`
}

/** Pull a message out of the various error shapes the stream can carry. */
function extractStreamError(event: ResponsesStreamEvent): string {
  if (typeof event.error === 'string') return event.error
  if (event.error?.message) return event.error.message
  if (event.response?.error?.message) return event.response.error.message
  return 'OpenAI streaming error'
}

export class OpenAIProvider implements Provider {
  readonly kind = 'openai'
  readonly label = 'OpenAI'
  readonly defaultModel = 'gpt-5.4-mini'
  // OpenAI can answer with built-in web search via the Responses API hosted tool,
  // so it's a valid handoff target for web-needing tasks (see WEB_SEARCH_TOOL).
  readonly supportsWebSearch = true

  /**
   * Current OpenAI chat models valid for the Responses API (ids + context
   * windows confirmed from the OpenAI docs, 2026-06-17:
   * https://developers.openai.com/api/docs/models). The flagship GPT-5.5 plus
   * the GPT-5.4 flagship/mini/nano tiers; the default is the cost-effective
   * mini tier per spec.
   */
  listModels(): ModelInfo[] {
    return [
      { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 1050000 },
      { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 1050000 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindow: 400000 },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', contextWindow: 400000 }
    ]
  }

  /**
   * Cheap auth check used when a key is saved in Settings (spec §4a). A GET to
   * /v1/models is the standard lightweight probe; an 8s timeout keeps a hung
   * network from blocking the save flow.
   */
  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    try {
      const response = await fetch(MODELS_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000)
      })

      if (response.ok) return { ok: true }
      if (response.status === 401) return { ok: false, error: 'Invalid API key' }
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
    const { instructions, input } = mapMessages(messages)

    let response: Response
    try {
      response = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          input,
          stream: true,
          ...(instructions ? { instructions } : {}),
          // Only attach the hosted web-search tool when explicitly requested; the
          // request is otherwise byte-for-byte identical to before.
          ...(webSearch ? { tools: [WEB_SEARCH_TOOL] } : {})
        }),
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
      yield { type: 'error', message: 'OpenAI response had no body to stream' }
      return
    }

    // getReader() + TextDecoder is the robust, version-agnostic way to read a
    // streamed body in Node (async iteration over response.body is not reliable
    // across Node versions).
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
          for (const chunk of this.handleEvent(sse.data)) {
            yield chunk
            if (chunk.type === 'done' || chunk.type === 'error') return
          }
        }
      }

      // Flush any tail the decoder/parser are still holding (no trailing blank
      // line before connection close), then emit a default `done` if the stream
      // ended without an explicit terminal event.
      for (const sse of parser.flush()) {
        for (const chunk of this.handleEvent(sse.data)) {
          yield chunk
          if (chunk.type === 'done' || chunk.type === 'error') return
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
   * Agentic function-calling loop over the Responses API. Lets the model call
   * Sunny-provided tools (file/shell/web) AND, when `webSearch` is on, OpenAI's
   * native server-run `web_search` in the same turn.
   *
   * Each round is NON-streaming (stream:false): tool round-trips parse far more
   * robustly when the response arrives complete, and the final answer is emitted
   * as one `delta`. Liveness comes from a `status` chunk per tool call. On the
   * last allowed round the custom tools are withheld (web search is kept) so the
   * model is forced to produce a text answer. Never throws — failures and aborts
   * surface as an `error` chunk.
   */
  async *streamWithTools(params: StreamWithToolsParams): AsyncIterable<StreamChunk> {
    const { apiKey, model, messages, tools, runTool, signal, webSearch } = params
    const { instructions, input: baseInput } = mapMessages(messages)
    const input: ResponsesInput[] = [...baseInput]
    const functionTools = tools.map(toResponsesFunctionTool)
    const maxRounds = params.maxToolRounds ?? 5
    // Token accounting across rounds, emitted once before `done`.
    let promptTokens = 0
    let completionTokens = 0

    for (let round = 0; round < maxRounds; round++) {
      const finalRound = round === maxRounds - 1
      // A runTool call between rounds can take seconds — bail promptly on cancel.
      if (signal?.aborted) {
        yield { type: 'error', message: 'Cancelled.' }
        return
      }

      // Withhold the custom function tools on the final round to force an answer;
      // keep the hosted web search throughout when requested.
      const requestTools = [
        ...(finalRound ? [] : functionTools),
        ...(webSearch ? [WEB_SEARCH_TOOL] : [])
      ]

      let response: Response
      try {
        response = await fetch(RESPONSES_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            input,
            stream: false,
            ...(instructions ? { instructions } : {}),
            ...(requestTools.length > 0 ? { tools: requestTools } : {})
          }),
          signal
        })
      } catch (err) {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }

      if (!response.ok) {
        yield { type: 'error', message: await readErrorMessage(response) }
        return
      }

      let body: ResponsesBody
      try {
        body = (await response.json()) as ResponsesBody
      } catch {
        yield { type: 'error', message: 'OpenAI returned a malformed response.' }
        return
      }
      if (typeof body.usage?.input_tokens === 'number') promptTokens += body.usage.input_tokens
      if (typeof body.usage?.output_tokens === 'number')
        completionTokens += body.usage.output_tokens

      const output = body.output ?? []
      // Server-run web_search items are NOT function_call items — skip everything
      // that isn't a custom-tool call.
      const calls = output.filter(
        (item): item is ResponsesOutputItem & { type: 'function_call' } =>
          item.type === 'function_call'
      )

      if (calls.length > 0) {
        for (const item of calls) {
          if (signal?.aborted) {
            yield { type: 'error', message: 'Cancelled.' }
            return
          }
          const call: ToolCall = {
            id: item.call_id ?? item.id ?? `call_${round}`,
            name: item.name ?? '',
            arguments: item.arguments ?? '{}'
          }
          yield { type: 'status', text: describeToolCall(call) }

          let result: string
          try {
            result = await runTool(call)
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`
          }

          // Echo the model's function_call item back, then append its result, so
          // the next round sees both (call_id links them — see header comment).
          input.push({
            type: 'function_call',
            ...(item.id ? { id: item.id } : {}),
            call_id: call.id,
            name: call.name,
            arguments: call.arguments
          })
          input.push({ type: 'function_call_output', call_id: call.id, output: result })
        }
        continue // re-ask the model now that it has the tool results
      }

      // No function calls → this round carries the final answer.
      const text = collectOutputText(output)
      if (text) yield { type: 'delta', text }
      if (promptTokens > 0 || completionTokens > 0) {
        yield { type: 'usage', promptTokens, completionTokens }
      }
      yield { type: 'done', finishReason: 'stop' }
      return
    }

    // Defensive: the final round withholds tools and always returns above.
    yield { type: 'done', finishReason: 'length' }
  }

  /**
   * Map one decoded SSE data payload to a normalized chunk, or undefined for
   * events we ignore (response.created, response.in_progress, heartbeats, the
   * `[DONE]` sentinel, etc.). The `type` discriminator lives inside the JSON.
   */
  // Returns the chunk(s) an SSE event maps to — an array because the terminal
  // `response.completed` event carries token usage AND ends the stream (usage
  // chunk, then done).
  private handleEvent(data: string): StreamChunk[] {
    // Some OpenAI-compatible servers append a `[DONE]` sentinel; the native
    // Responses API does not, but tolerate it either way.
    if (data === '[DONE]') return []

    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(data) as ResponsesStreamEvent
    } catch {
      // A non-JSON data line is not actionable; skip rather than fail the stream.
      return []
    }

    switch (event.type) {
      case EVENT_TEXT_DELTA:
        return typeof event.delta === 'string' ? [{ type: 'delta', text: event.delta }] : []
      case EVENT_COMPLETED: {
        const usage = event.response?.usage
        const chunks: StreamChunk[] = []
        if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
          chunks.push({
            type: 'usage',
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0
          })
        }
        chunks.push({ type: 'done', finishReason: 'stop' })
        return chunks
      }
      case EVENT_FAILED:
        return [{ type: 'error', message: extractStreamError(event) }]
      case EVENT_ERROR:
        return [{ type: 'error', message: extractStreamError(event) }]
      default:
        return []
    }
  }
}
