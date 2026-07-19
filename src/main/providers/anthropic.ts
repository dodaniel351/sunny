// Anthropic adapter for the uniform Provider interface (spec §4 / §4a).
//
// Like the OpenAI adapter, this file is pure provider logic: it does NOT import
// the secret store, DB, electron, or repositories — the resolved `apiKey` is
// passed in (see types.ts), so the adapter stays unit-friendly. It reuses the
// shared SseParser (sse.ts) for wire framing and never re-implements it.
//
// ── Messages-API streaming protocol (verified via the claude-api reference) ──
// Endpoint: POST https://api.anthropic.com/v1/messages
// Auth/headers: x-api-key, anthropic-version: 2023-06-01, content-type JSON.
// Streaming is SSE: each event carries an `event:` name AND a `data: {json}`
// payload. We ignore the `event:` name (SseParser yields the data JSON) and
// switch on the parsed JSON's `type`:
//   - 'content_block_delta' + delta.type 'text_delta' → incremental text
//   - 'message_delta'                                 → carries delta.stop_reason
//   - 'message_stop'                                  → terminal success
//   - 'error'                                         → out-of-band stream error
// Request body notes (current Opus/Fable line): `system` is a TOP-LEVEL string
// (system-role turns are joined into it), `messages` alternate user/assistant
// and start with user, and `temperature`/`top_p`/`top_k`/`thinking` are omitted
// (they 400). A `stop_reason` of 'refusal' is a graceful finish, not an error.

import type {
  ChatTurn,
  KeyValidationResult,
  ModelInfo,
  Provider,
  StreamChatParams,
  StreamChunk,
  StreamWithToolsParams,
  ToolSpec
} from './types'
import { SseParser } from './sse'
import { describeToolCall } from '@main/tools/describe'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VERSION = '2023-06-01'

// Anthropic requires an explicit output cap. 4096 is a sensible interactive
// default and matches the spec's request shape.
const MAX_TOKENS = 4096

// With adaptive thinking on, reasoning tokens count against max_tokens — give
// the turn extra headroom so long thinking never truncates the answer.
const THINKING_MAX_TOKENS = 16000

/**
 * The `thinking` request config for a model, or undefined for models where the
 * request must stay unchanged (Haiku and older only accept the deprecated
 * budget_tokens form — not worth the cost/latency change for chat).
 *
 * Adaptive thinking is the recommended config on every 4.6+ model. On Fable 5 /
 * Sonnet 5 / Opus 4.7/4.8 the `display` field defaults to "omitted" (thinking
 * blocks stream with EMPTY text), so we must opt into "summarized" to have
 * anything to show. The 4.6 family predates `display` and already defaults to
 * summarized, so it gets the bare adaptive form.
 */
export function thinkingConfigFor(
  model: string
): { type: 'adaptive'; display?: 'summarized' } | undefined {
  if (/^claude-(fable-5|sonnet-5|opus-4-[78])/.test(model))
    return { type: 'adaptive', display: 'summarized' }
  if (/^claude-(opus-4-6|sonnet-4-6)/.test(model)) return { type: 'adaptive' }
  return undefined
}

// The shared tool loop runs ≈5 model round-trips before forcing a text answer.
const MAX_TOOL_ROUNDS = 5

// The native server-side web-search tool (GA — no beta header). Coexists with
// custom tools in the same `tools` array; its results stream back as
// web_search_tool_result content blocks which we ignore in the tool loop.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as const

/** A text or image content block for a user turn (image turns use these). */
type AnthropicContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** A Messages-API input message: a role-tagged turn. Content is plain text, or
 *  (for image turns) an array of text + image blocks. */
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentPart[]
}

// ── Tool-use wire shapes (verified via the claude-api reference, 2026) ──
// Custom tools are declared as `{ name, description, input_schema }` (NOT the
// OpenAI `parameters` key). A tool call comes back as a `tool_use` content block
// `{ type:'tool_use', id, name, input }` inside the assistant message, with the
// message-level `stop_reason:'tool_use'`. The result is returned as a `user`
// message whose content is `[{ type:'tool_result', tool_use_id, content }]`.

/** A custom tool declaration in the Messages-API shape. */
interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** One content block in a non-streamed assistant response. We only act on
 *  `tool_use` (custom calls) and `text`; other block types (the server
 *  `web_search` tool_use/result, thinking, etc.) are passed through untouched
 *  when we echo the assistant turn, and otherwise ignored. */
interface AnthropicContentBlock {
  type?: string
  // text block
  text?: string
  // thinking block (adaptive thinking): the summarized reasoning text.
  thinking?: string
  // tool_use block
  id?: string
  name?: string
  input?: Record<string, unknown>
}

/** A content block we send back: text/tool_use echoes (assistant) or
 *  tool_result (user). `unknown` so we can round-trip echoed assistant blocks
 *  verbatim without re-typing every server-tool variant. */
type AnthropicSendBlock =
  | AnthropicContentBlock
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** A message in the agentic (block-content) Messages shape. The non-streaming
 *  loop uses block arrays (text + tool_use + tool_result), unlike the simple
 *  string-content `AnthropicMessage` streamChat builds. */
interface AnthropicLoopMessage {
  role: 'user' | 'assistant'
  content: AnthropicSendBlock[]
}

/** The slice of a non-streamed /v1/messages response the tool loop reads. */
interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[]
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string } | string
}

/** Map a Sunny ToolSpec → an Anthropic custom tool: `function.parameters`
 *  becomes `input_schema`; name/description carry over unchanged. */
function toAnthropicTool(spec: ToolSpec): AnthropicTool {
  return {
    name: spec.function.name,
    description: spec.function.description,
    input_schema: spec.function.parameters
  }
}

/** The slice of each streamed event payload we care about. */
interface AnthropicStreamEvent {
  type?: string
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null }
  /** message_start wraps the message (carries usage.input_tokens). */
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  /** message_delta carries CUMULATIVE usage.output_tokens at the top level. */
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

/**
 * Pull token usage out of a streamed event, or undefined when it carries none.
 * Anthropic reports input_tokens once on `message_start` and a CUMULATIVE
 * output_tokens on each `message_delta` — so callers ASSIGN (last wins), not
 * sum. Separate from mapStreamEvent so the chunk mapping stays untouched.
 */
export function extractUsage(
  data: string
): { promptTokens?: number; completionTokens?: number } | undefined {
  let event: AnthropicStreamEvent
  try {
    event = JSON.parse(data) as AnthropicStreamEvent
  } catch {
    return undefined
  }
  const usage = event.type === 'message_start' ? event.message?.usage : event.usage
  if (!usage) return undefined
  const out: { promptTokens?: number; completionTokens?: number } = {}
  if (typeof usage.input_tokens === 'number') out.promptTokens = usage.input_tokens
  if (typeof usage.output_tokens === 'number') out.completionTokens = usage.output_tokens
  return out.promptTokens === undefined && out.completionTokens === undefined ? undefined : out
}

/**
 * Split chat turns into the top-level `system` string (all system turns joined)
 * and the `messages` array (user/assistant turns). Anthropic takes `system` as
 * a top-level param, NOT a message, so system content never enters `messages`.
 */
function mapMessages(messages: ChatTurn[]): {
  system?: string
  messages: AnthropicMessage[]
} {
  const systemParts: string[] = []
  const out: AnthropicMessage[] = []

  for (const turn of messages) {
    if (turn.role === 'system') {
      systemParts.push(turn.content)
      continue
    }
    if (turn.images && turn.images.length > 0) {
      const blocks: AnthropicContentPart[] = []
      if (turn.content) blocks.push({ type: 'text', text: turn.content })
      for (const img of turn.images) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.dataUrl.replace(/^data:[^;]+;base64,/, '')
          }
        })
      }
      out.push({ role: turn.role, content: blocks })
    } else {
      out.push({ role: turn.role, content: turn.content })
    }
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  return system === undefined ? { messages: out } : { system, messages: out }
}

/** Best-effort extraction of a human-readable message from an error response body. */
async function readErrorMessage(response: Response): Promise<string> {
  // 401 is the common "bad key" case; give it a stable, friendly message.
  if (response.status === 401) return 'Invalid Anthropic API key'
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
  return `Anthropic request failed (${response.status} ${response.statusText})`
}

/**
 * Map one decoded SSE data payload to a normalized chunk, or undefined for
 * events we ignore (message_start, content_block_start/stop, ping heartbeats,
 * etc.). The `type` discriminator lives inside the JSON. Exported so the
 * delta-extraction logic can be unit-tested without touching fetch or natives.
 */
export function mapStreamEvent(data: string): StreamChunk | undefined {
  let event: AnthropicStreamEvent
  try {
    event = JSON.parse(data) as AnthropicStreamEvent
  } catch {
    // A non-JSON data line is not actionable; skip rather than fail the stream.
    return undefined
  }

  switch (event.type) {
    case 'content_block_delta':
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string')
        return { type: 'delta', text: event.delta.text }
      // Adaptive-thinking summaries stream as thinking_delta events; surface
      // them as thinking chunks so the UI can render the reasoning live.
      if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string')
        return event.delta.thinking === ''
          ? undefined
          : { type: 'thinking', text: event.delta.thinking }
      return undefined
    case 'message_delta': {
      // Carries the final stop_reason; the stream ends on message_stop, so we
      // surface the reason here but do not terminate yet. A server-side web
      // search emits a `pause_turn` message_delta mid-loop while it keeps
      // working — that is NOT a terminal/error condition, so we ignore it and
      // keep reading until the real terminal (`message_stop`). Mapping it to a
      // `done` chunk would let the streamChat loop `return` early and cut the
      // answer off mid-search.
      const finishReason = event.delta?.stop_reason
      if (!finishReason || finishReason === 'pause_turn') return undefined
      return { type: 'done', finishReason }
    }
    case 'message_stop':
      return { type: 'done' }
    case 'error':
      return { type: 'error', message: event.error?.message ?? 'Anthropic streaming error' }
    default:
      return undefined
  }
}

export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic'
  readonly label = 'Anthropic'
  readonly defaultModel = 'claude-sonnet-4-6'

  /** Anthropic answers with its OWN built-in web search (the GA `web_search`
   *  server tool). When the web toggle is on, the runtime sets `webSearch: true`
   *  on `streamChat` and we attach the native tool. */
  readonly supportsWebSearch = true

  /**
   * Current Anthropic chat models (ids confirmed from the claude-api reference,
   * 2026-06-17). The default is Sonnet 4.6 — balanced speed/intelligence for
   * interactive chat per spec.
   */
  listModels(): ModelInfo[] {
    return [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 1000000 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 1000000 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200000 },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', contextWindow: 1000000 },
      { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindow: 1000000 }
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
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
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
    const { system, messages: anthropicMessages } = mapMessages(messages)
    const thinking = thinkingConfigFor(model)

    let response: Response
    try {
      response = await fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          messages: anthropicMessages,
          stream: true,
          // Adaptive thinking (supported models): reasoning summaries stream as
          // thinking_delta events → thinking chunks. Thinking tokens count
          // against max_tokens, so the cap gets extra headroom.
          ...(thinking ? { thinking, max_tokens: THINKING_MAX_TOKENS } : {}),
          ...(system ? { system } : {}),
          // Native server-side web search (GA — no beta header needed). The
          // stream may then carry web_search_tool_result and other non-text
          // blocks (ignored below) and a `pause_turn` message_delta (not
          // terminal — mapStreamEvent keeps reading until message_stop).
          ...(webSearch
            ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }
            : {})
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
      yield { type: 'error', message: 'Anthropic response had no body to stream' }
      return
    }

    // getReader() + TextDecoder is the robust, version-agnostic way to read a
    // streamed body in Node (async iteration over response.body is not reliable
    // across Node versions).
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    // Usage arrives incrementally (input on message_start, cumulative output on
    // message_delta) — assign as reported, emit once before the terminal chunk.
    let promptTokens = 0
    let completionTokens = 0
    const takeUsage = (data: string): void => {
      const usage = extractUsage(data)
      if (usage?.promptTokens !== undefined) promptTokens = usage.promptTokens
      if (usage?.completionTokens !== undefined) completionTokens = usage.completionTokens
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        // stream:true so the decoder accumulates partial multibyte sequences.
        const text = decoder.decode(value, { stream: true })
        for (const sse of parser.push(text)) {
          takeUsage(sse.data)
          const chunk = mapStreamEvent(sse.data)
          if (chunk) {
            if (chunk.type !== 'delta' && chunk.type !== 'thinking') {
              if (promptTokens > 0 || completionTokens > 0)
                yield { type: 'usage', promptTokens, completionTokens }
              yield chunk
              return
            }
            yield chunk
          }
        }
      }

      // Flush any tail the decoder/parser are still holding (no trailing blank
      // line before connection close), then emit a default `done` if the stream
      // ended without an explicit terminal event.
      for (const sse of parser.flush()) {
        takeUsage(sse.data)
        const chunk = mapStreamEvent(sse.data)
        if (chunk) {
          if (chunk.type !== 'delta' && chunk.type !== 'thinking') {
            if (promptTokens > 0 || completionTokens > 0)
              yield { type: 'usage', promptTokens, completionTokens }
            yield chunk
            return
          }
          yield chunk
        }
      }
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
   * Agentic function-calling loop so the model can invoke Sunny's OWN tools
   * (file/shell) while ALSO using Anthropic's native web search in the same turn
   * (both live in one `tools` array). Mirrors the canonical tool-loop pattern
   * (tool-loop.ts) but over the Messages-API tool-use wire shape rather than the
   * OpenAI chat/completions shape.
   *
   * Each round is a NON-STREAMING POST to /v1/messages (stream:false) — tool
   * round-trips parse far more robustly when the assistant message arrives
   * complete. Liveness comes from a `status` chunk per tool call (mirroring the
   * shared loop); the final text answer is emitted as a single `delta` then a
   * terminal `done`. Failures surface as an `error` chunk — this never throws.
   *
   * Per round: read the response `content`. If it has `tool_use` blocks (custom
   * tools — server `web_search` runs entirely server-side and never asks us to
   * execute anything), echo the full assistant content back, run each tool,
   * append one `user` message carrying all the `tool_result` blocks, and loop.
   * If there are no tool_use blocks the model answered: concatenate its `text`
   * blocks and finish. On the final round the custom tools are withheld (web
   * search is kept) so the model is forced to produce a text answer.
   */
  async *streamWithTools(params: StreamWithToolsParams): AsyncIterable<StreamChunk> {
    const { apiKey, model, messages, signal, webSearch, tools, runTool } = params
    const { system, messages: initial } = mapMessages(messages)
    const thinking = thinkingConfigFor(model)

    // Start from the plain user/assistant turns (string content is a valid
    // Messages content shape), then grow the transcript with block-content
    // assistant/tool turns as the loop runs.
    const loopMessages: AnthropicLoopMessage[] = initial.map((m) => ({
      role: m.role,
      // String content → a single text block; an image turn already carries
      // text + image blocks, which are valid send blocks as-is.
      content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    }))

    const customTools = tools.map(toAnthropicTool)
    const maxRounds = params.maxToolRounds ?? MAX_TOOL_ROUNDS
    // Token accounting across rounds, emitted once before `done`.
    let promptTokens = 0
    let completionTokens = 0

    for (let round = 0; round < maxRounds; round++) {
      // A tool call between rounds can take seconds — bail promptly if cancelled.
      if (signal?.aborted) {
        yield { type: 'error', message: 'Cancelled.' }
        return
      }

      // On the last round, withhold the custom tools so the model must answer;
      // keep web search (it resolves server-side and won't stall the loop).
      const finalRound = round === maxRounds - 1
      const roundTools: Array<AnthropicTool | typeof WEB_SEARCH_TOOL> = [
        ...(finalRound ? [] : customTools),
        ...(webSearch ? [WEB_SEARCH_TOOL] : [])
      ]

      let response: Response
      try {
        response = await fetch(MESSAGES_URL, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            messages: loopMessages,
            stream: false,
            // Adaptive thinking (supported models). The verbatim assistant-content
            // echo below is what makes this safe: thinking blocks MUST be passed
            // back unchanged when a turn continues through tool_use rounds.
            ...(thinking ? { thinking, max_tokens: THINKING_MAX_TOKENS } : {}),
            ...(system ? { system } : {}),
            ...(roundTools.length > 0 ? { tools: roundTools } : {})
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

      let json: AnthropicMessageResponse
      try {
        json = (await response.json()) as AnthropicMessageResponse
      } catch {
        yield { type: 'error', message: 'Anthropic returned a malformed response.' }
        return
      }
      if (typeof json.usage?.input_tokens === 'number') promptTokens += json.usage.input_tokens
      if (typeof json.usage?.output_tokens === 'number')
        completionTokens += json.usage.output_tokens

      const content = Array.isArray(json.content) ? json.content : []

      // Surface this round's reasoning (adaptive thinking summaries) so the UI
      // shows it live. The blocks stay in `content` untouched — the echo below
      // sends them back verbatim, as the API requires mid-turn.
      for (const b of content) {
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
          yield { type: 'thinking', text: b.thinking }
        }
      }

      const toolUses = content.filter(
        (b): b is AnthropicContentBlock & { id: string; name: string } =>
          b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'
      )

      // No custom tool calls → the model has answered. (A `pause_turn` would have
      // server tool work pending, but in non-streaming mode the server resolves
      // the whole turn before returning, so a response with no tool_use blocks is
      // the final answer regardless of stop_reason.)
      if (toolUses.length === 0) {
        const text = content
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('')
        if (text) yield { type: 'delta', text }
        if (promptTokens > 0 || completionTokens > 0)
          yield { type: 'usage', promptTokens, completionTokens }
        yield { type: 'done', finishReason: json.stop_reason ?? 'end_turn' }
        return
      }

      // Echo the assistant turn verbatim (the FULL content — including any server
      // web_search blocks and the tool_use blocks) so the next round has the
      // model's own context, then run each custom tool and collect its result.
      loopMessages.push({ role: 'assistant', content })

      const results: AnthropicSendBlock[] = []
      for (const call of toolUses) {
        if (signal?.aborted) {
          yield { type: 'error', message: 'Cancelled.' }
          return
        }
        const toolCall = {
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {})
        }
        yield { type: 'status', text: describeToolCall(toolCall) }
        let result: string
        try {
          result = await runTool(toolCall)
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: result })
      }

      // One user turn carrying all the tool_result blocks, then loop.
      loopMessages.push({ role: 'user', content: results })
    }

    // Defensive: the final round withholds custom tools, so the model answers and
    // we return above. Emit a clean terminal if we somehow fall through.
    yield { type: 'done', finishReason: 'length' }
  }
}
