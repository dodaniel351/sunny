// A shared OpenAI-style function-calling loop over the `/chat/completions` wire
// shape, used to give models Sunny's own tools (web search/fetch). It is how a
// local Ollama model — or any chat/completions provider like Grok/OpenRouter/
// Groq — gets web access without native server-side search.
//
// The loop runs NON-STREAMING rounds (stream:false): a tool-calling round-trip
// is far more robust to parse non-streamed (tool_calls arrive complete), and web
// answers are occasional, so token-by-token streaming isn't worth the fragility.
// Liveness comes from `status` chunks emitted between rounds ("🔎 Searching…").
// The final answer is emitted as a single `delta`.
//
// Like the adapters, this file is pure provider logic: the resolved bearer comes
// in via `headers`, and the tools + their executor come in via params — so it
// imports no secrets/DB/electron and stays unit-testable.

import type { ChatTurn, StreamChunk, ToolCall, ToolSpec } from './types'
import { describeToolCall } from '@main/tools/describe'
import { splitThinkTag } from './think-tags'

/** An OpenAI chat-completions message (superset of ChatTurn for the tool turns). */
interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** The slice of a non-streamed chat-completions response we read. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      // Reasoning models return their chain of thought in a dedicated field:
      // `reasoning` (OpenRouter, Grok) or `reasoning_content` (DeepSeek, Groq).
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string } | string
}

export interface ToolLoopOptions {
  /** Full chat/completions URL, e.g. `${base}/v1/chat/completions`. */
  url: string
  /** Auth/extra headers (content-type is added automatically). Empty for Ollama. */
  headers: Record<string, string>
  model: string
  messages: ChatTurn[]
  tools: ToolSpec[]
  runTool: (call: ToolCall) => Promise<string>
  signal?: AbortSignal
  /** Max model round-trips before forcing a final text answer. Default 5. */
  maxRounds?: number
}

async function readError(response: Response): Promise<string> {
  if (response.status === 401) return 'Invalid or unauthorized API key'
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string }
      if (typeof json.error === 'string' && json.error.trim() !== '') return json.error
      if (typeof json.error === 'object' && json.error?.message) return json.error.message
    } catch {
      // Not JSON — fall through.
    }
    if (text.trim() !== '') return text.trim()
  } catch {
    // Reading the body failed.
  }
  return `Request failed (${response.status} ${response.statusText})`
}

/**
 * Drive the tool loop. Yields `status` chunks for each tool call, then a single
 * `delta` with the final answer and a terminal `done` — or an `error`. On the
 * last allowed round, tools are withheld so the model is forced to answer.
 */
export async function* runToolLoop(opts: ToolLoopOptions): AsyncIterable<StreamChunk> {
  const { url, headers, model, tools, runTool, signal } = opts
  const maxRounds = opts.maxRounds ?? 5
  const messages: OaiMessage[] = opts.messages.map((t) => ({ role: t.role, content: t.content }))
  // Token accounting, accumulated across rounds (non-streaming responses carry
  // `usage`) and emitted once before `done`.
  let promptTokens = 0
  let completionTokens = 0

  for (let round = 0; round < maxRounds; round++) {
    const finalRound = round === maxRounds - 1
    // The per-round fetch carries the signal, but a tool call between rounds can
    // take seconds — bail promptly when the turn is cancelled.
    if (signal?.aborted) {
      yield { type: 'error', message: 'Cancelled.' }
      return
    }
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          // Withhold tools on the last round to force a text answer instead of
          // another (un-actionable) tool call.
          ...(finalRound ? {} : { tools, tool_choice: 'auto' })
        }),
        signal
      })
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return
    }

    if (!response.ok) {
      yield { type: 'error', message: await readError(response) }
      return
    }

    let json: ChatCompletionResponse
    try {
      json = (await response.json()) as ChatCompletionResponse
    } catch {
      yield { type: 'error', message: 'Provider returned a malformed response.' }
      return
    }

    const choice = json.choices?.[0]
    if (typeof json.usage?.prompt_tokens === 'number') promptTokens += json.usage.prompt_tokens
    if (typeof json.usage?.completion_tokens === 'number')
      completionTokens += json.usage.completion_tokens
    const message = choice?.message
    const rawToolCalls = message?.tool_calls ?? []
    const toolCalls: ToolCall[] = rawToolCalls
      .filter((tc) => tc.function?.name)
      .map((tc, idx) => ({
        id: tc.id ?? `call_${round}_${idx}`,
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}'
      }))

    if (toolCalls.length > 0) {
      // Echo the assistant turn that requested the tools, then run each tool and
      // append its result, so the next round sees the tool outputs.
      messages.push({
        role: 'assistant',
        content: message?.content ?? '',
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments }
        }))
      })
      for (const call of toolCalls) {
        if (signal?.aborted) {
          yield { type: 'error', message: 'Cancelled.' }
          return
        }
        yield { type: 'status', text: describeToolCall(call) }
        let result: string
        try {
          result = await runTool(call)
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
      continue // ask the model again now that it has the tool results
    }

    // No tool calls → this is the final answer. Surface any reasoning first
    // (the dedicated field, or a leading <think>…</think> block inlined in the
    // content by local/aggregator-served thinking models), then the answer.
    const reasoningField = message?.reasoning ?? message?.reasoning_content
    if (typeof reasoningField === 'string' && reasoningField !== '') {
      yield { type: 'thinking', text: reasoningField }
    }
    const raw = typeof message?.content === 'string' ? message.content : ''
    const { thinking: inlineThinking, answer: content } = splitThinkTag(raw)
    if (inlineThinking) yield { type: 'thinking', text: inlineThinking }
    if (content) yield { type: 'delta', text: content }
    if (promptTokens > 0 || completionTokens > 0) {
      yield { type: 'usage', promptTokens, completionTokens }
    }
    yield { type: 'done', finishReason: choice?.finish_reason ?? 'stop' }
    return
  }

  // Defensive: the loop above always returns on the final round (tools withheld),
  // so this is unreachable in practice — emit a clean terminal just in case.
  yield { type: 'done', finishReason: 'length' }
}
