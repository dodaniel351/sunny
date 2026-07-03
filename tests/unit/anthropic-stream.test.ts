import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseSseEvents, SseParser } from '@main/providers/sse'
import { AnthropicProvider, mapStreamEvent } from '@main/providers/anthropic'
import type { StreamChunk, ToolSpec } from '@main/providers/types'

// These tests exercise ONLY the Anthropic adapter's pure delta-extraction logic
// (mapStreamEvent) plus the shared SseParser — no network, no fetch, no native
// imports. They feed realistic Messages-API SSE text and assert the text
// reassembles and the terminal events are detected. Event shapes match the
// claude-api reference (see anthropic.ts header comment): content_block_delta
// with delta.type 'text_delta', message_delta carrying delta.stop_reason, and
// message_stop ending the stream.

/**
 * Frame a Messages-API event the way the wire carries it: an `event:` name line
 * plus a `data: {json}` line, terminated by a blank line. The adapter ignores
 * the `event:` name and switches on the JSON `type`, but real streams send both.
 */
function frame(name: string, obj: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`
}

/** Run decoded data payloads through the adapter's mapper and fold the chunks. */
function fold(data: string[]): { text: string; finishReason?: string; error?: string } {
  let text = ''
  let finishReason: string | undefined
  let error: string | undefined
  for (const raw of data) {
    const chunk: StreamChunk | undefined = mapStreamEvent(raw)
    if (!chunk) continue
    if (chunk.type === 'delta') text += chunk.text
    else if (chunk.type === 'done') finishReason = chunk.finishReason ?? finishReason
    else error = chunk.message
  }
  return { text, finishReason, error }
}

/** A realistic Anthropic streaming turn, mirroring the documented event order. */
function turn(deltas: string[], stopReason = 'end_turn'): string {
  return (
    frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_01', role: 'assistant', content: [] }
    }) +
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    }) +
    deltas
      .map((text) =>
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text }
        })
      )
      .join('') +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null }
    }) +
    frame('message_stop', { type: 'message_stop' })
  )
}

describe('Anthropic stream delta extraction', () => {
  it('concatenates text deltas across a realistic sequence in a single chunk', () => {
    const stream = turn(['Hello', ', ', 'world', '!'])

    const events = parseSseEvents(stream)
    const { text, finishReason } = fold(events.map((e) => e.data))

    expect(text).toBe('Hello, world!')
    expect(finishReason).toBe('end_turn')
  })

  it('ignores message_start, content_block_start/stop, and ping heartbeats', () => {
    const stream =
      frame('ping', { type: 'ping' }) +
      turn(['only ', 'the ', 'text']) +
      frame('ping', { type: 'ping' })

    const events = parseSseEvents(stream)
    const { text, finishReason } = fold(events.map((e) => e.data))

    expect(text).toBe('only the text')
    expect(finishReason).toBe('end_turn')
  })

  it('reassembles deltas when events are split across chunk boundaries', () => {
    const parser = new SseParser()
    const full = turn(['Strea', 'ming ', 'works'])

    // Cut mid-way through the second delta's JSON so neither chunk is a whole
    // event on its own — the parser must buffer the partial line.
    const cut = full.indexOf('ming ') + 2
    const collected: string[] = []
    for (const e of parser.push(full.slice(0, cut))) collected.push(e.data)
    for (const e of parser.push(full.slice(cut))) collected.push(e.data)
    for (const e of parser.flush()) collected.push(e.data)

    const { text, finishReason } = fold(collected)
    expect(text).toBe('Streaming works')
    expect(finishReason).toBe('end_turn')
  })

  it('surfaces a refusal stop_reason as a graceful finish', () => {
    const stream = turn(['partial'], 'refusal')

    const { text, finishReason, error } = fold(parseSseEvents(stream).map((e) => e.data))
    expect(text).toBe('partial')
    expect(finishReason).toBe('refusal')
    expect(error).toBeUndefined()
  })

  it('maps an error event to an error chunk', () => {
    const stream = frame('error', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' }
    })

    const { error } = fold(parseSseEvents(stream).map((e) => e.data))
    expect(error).toBe('Overloaded')
  })

  it('treats message_stop alone as a terminal done with no finishReason', () => {
    const chunk = mapStreamEvent(JSON.stringify({ type: 'message_stop' }))
    expect(chunk).toEqual({ type: 'done' })
  })

  it('does NOT terminate on a pause_turn message_delta (server-side web search)', () => {
    // A server-side search emits a `pause_turn` message_delta mid-loop; this
    // must be ignored so the stream keeps reading until the real message_stop.
    const chunk = mapStreamEvent(
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'pause_turn' } })
    )
    expect(chunk).toBeUndefined()

    // The full text still reassembles across a pause_turn boundary.
    const stream =
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Searching... ' }
      }) +
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'here is the answer.' }
      }) +
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
      frame('message_stop', { type: 'message_stop' })

    const { text, finishReason } = fold(parseSseEvents(stream).map((e) => e.data))
    expect(text).toBe('Searching... here is the answer.')
    expect(finishReason).toBe('end_turn')
  })

  it('ignores web_search_tool_result and other non-text content blocks', () => {
    const stream =
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] }
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'answer' }
      }) +
      frame('message_stop', { type: 'message_stop' })

    const { text, error } = fold(parseSseEvents(stream).map((e) => e.data))
    expect(text).toBe('answer')
    expect(error).toBeUndefined()
  })
})

// These tests drive the real AnthropicProvider.streamChat adapter with a mocked
// global `fetch` to assert the POST body sent to /v1/messages — specifically
// whether the native web-search tool is attached. The body is a minimal SSE
// stream so streamChat completes; we only inspect the request, not the output.
describe('AnthropicProvider.streamChat request body', () => {
  /** Build a Response whose body streams `sse` chunks (status 200). */
  function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      }
    })
    return new Response(stream, { status: 200 })
  }

  /** Drain an async iterable of chunks (we don't care about the output here). */
  async function drain(iter: AsyncIterable<StreamChunk>): Promise<void> {
    for await (const _chunk of iter) void _chunk
  }

  const provider = new AnthropicProvider()
  const okStream = [frame('message_stop', { type: 'message_stop' })]

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes supportsWebSearch = true', () => {
    expect(provider.supportsWebSearch).toBe(true)
  })

  it('attaches the native web_search_20250305 tool when webSearch is true', async () => {
    const fetchMock = vi.fn(async () => sseResponse(okStream))
    vi.stubGlobal('fetch', fetchMock)

    await drain(
      provider.streamChat({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'what happened today' }],
        webSearch: true
      })
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as { tools?: unknown[] }
    expect(sent.tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
    ])
    // Web search is GA — only the anthropic-version header, no beta header.
    const headers = init.headers as Record<string, string>
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers).not.toHaveProperty('anthropic-beta')
  })

  it('does NOT attach any tools when webSearch is omitted or false', async () => {
    const fetchMock = vi.fn(async () => sseResponse(okStream))
    vi.stubGlobal('fetch', fetchMock)

    // Omitted.
    await drain(
      provider.streamChat({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )
    // Explicit false.
    await drain(
      provider.streamChat({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        webSearch: false
      })
    )

    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit]
      const sent = JSON.parse(init.body as string) as Record<string, unknown>
      expect(sent).not.toHaveProperty('tools')
    }
  })
})

// These tests drive AnthropicProvider.streamWithTools — the agentic
// function-calling loop — with a mocked global `fetch` returning NON-STREAMING
// /v1/messages JSON. Round 1 returns a `tool_use` block (stop_reason
// 'tool_use'); round 2 returns the final `text`. We assert the request shapes
// (custom tool mapped to input_schema; native web_search tool when webSearch),
// that runTool is called with the right name+args, that round 2's messages carry
// the matching tool_result, and that the streamed output equals the final text.
describe('AnthropicProvider.streamWithTools', () => {
  /** A JSON Response (status 200) for one non-streaming /v1/messages round. */
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  /** Fold streamWithTools output into the pieces the tests assert on. */
  async function collect(iter: AsyncIterable<StreamChunk>): Promise<{
    text: string
    statuses: string[]
    finishReason?: string
    error?: string
  }> {
    let text = ''
    const statuses: string[] = []
    let finishReason: string | undefined
    let error: string | undefined
    for await (const chunk of iter) {
      if (chunk.type === 'delta') text += chunk.text
      else if (chunk.type === 'status') statuses.push(chunk.text)
      else if (chunk.type === 'done') finishReason = chunk.finishReason
      else error = chunk.message
    }
    return { text, statuses, finishReason, error }
  }

  const provider = new AnthropicProvider()

  /** A single custom tool in the OpenAI ToolSpec shape the registry produces. */
  const readFileTool: ToolSpec = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  }

  // Round 1: model asks to call read_file. Round 2: model answers with text.
  const round1 = {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }],
    stop_reason: 'tool_use'
  }
  const round2 = {
    content: [{ type: 'text', text: 'The file says hello.' }],
    stop_reason: 'end_turn'
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs the tool, feeds back the result, and streams the final text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(round1))
      .mockResolvedValueOnce(jsonResponse(round2))
    vi.stubGlobal('fetch', fetchMock)

    const runTool = vi.fn(async () => 'hello')

    const { text, statuses, finishReason, error } = await collect(
      provider.streamWithTools({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'what does a.txt say?' }],
        tools: [readFileTool],
        runTool
      })
    )

    expect(error).toBeUndefined()
    // Final answer is the round-2 text; round-1 tool_use produced no delta.
    expect(text).toBe('The file says hello.')
    expect(finishReason).toBe('end_turn')

    // A status line was emitted for the tool call.
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toContain('a.txt')

    // runTool was invoked with the right name + JSON-stringified args.
    expect(runTool).toHaveBeenCalledTimes(1)
    const call = runTool.mock.calls[0][0]
    expect(call.name).toBe('read_file')
    expect(call.id).toBe('toolu_1')
    expect(JSON.parse(call.arguments)).toEqual({ path: 'a.txt' })

    // Round 1 request: custom tool mapped to the Messages-API input_schema shape.
    const [, init1] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body1 = JSON.parse(init1.body as string) as {
      tools?: Array<Record<string, unknown>>
      stream?: boolean
      max_tokens?: number
    }
    expect(body1.stream).toBe(false)
    expect(body1.max_tokens).toBeGreaterThan(0)
    expect(body1.tools).toContainEqual({
      name: 'read_file',
      description: 'Read a file from disk.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    })

    // Round 2 request: messages include a user turn whose tool_result carries the
    // matching tool_use_id and the tool's output.
    const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit]
    const body2 = JSON.parse(init2.body as string) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
    }
    const toolResult = body2.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult).toMatchObject({ tool_use_id: 'toolu_1', content: 'hello' })

    // The assistant turn that requested the tool is echoed back verbatim.
    const echoedToolUse = body2.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_use')
    expect(echoedToolUse).toMatchObject({ id: 'toolu_1', name: 'read_file' })
  })

  it('adds the native web_search tool alongside custom tools when webSearch is true', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(round2))
    vi.stubGlobal('fetch', fetchMock)

    await collect(
      provider.streamWithTools({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [readFileTool],
        runTool: vi.fn(async () => ''),
        webSearch: true
      })
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { tools?: Array<Record<string, unknown>> }
    // Both the native web search and the mapped custom tool are present.
    expect(body.tools).toContainEqual({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5
    })
    expect(body.tools).toContainEqual(
      expect.objectContaining({ name: 'read_file', input_schema: expect.any(Object) })
    )
  })

  it('does not attach web_search when webSearch is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(round2))
    vi.stubGlobal('fetch', fetchMock)

    await collect(
      provider.streamWithTools({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [readFileTool],
        runTool: vi.fn(async () => '')
      })
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { tools?: Array<Record<string, unknown>> }
    expect(body.tools?.some((t) => t.type === 'web_search_20250305')).toBe(false)
  })

  it('surfaces cancellation as an error chunk before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    const { error } = await collect(
      provider.streamWithTools({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [readFileTool],
        runTool: vi.fn(async () => ''),
        signal: controller.signal
      })
    )

    expect(error).toBe('Cancelled.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an HTTP error as an error chunk and stops', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 529 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { error } = await collect(
      provider.streamWithTools({
        apiKey: 'k',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [readFileTool],
        runTool: vi.fn(async () => '')
      })
    )

    expect(error).toBe('Overloaded')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
