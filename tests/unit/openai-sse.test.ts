import { describe, it, expect, afterEach, vi } from 'vitest'
import { SseParser, parseSseEvents } from '@main/providers/sse'
import { OpenAIProvider } from '@main/providers/openai'
import type { StreamChunk, ToolCall, ToolSpec } from '@main/providers/types'

// These tests exercise ONLY the pure SSE parser (src/main/providers/sse.ts) —
// no network, no fetch, no native imports. They feed it realistic OpenAI
// Responses-API SSE text and assert that the text deltas reassemble correctly
// and that completion is detected. Event-type strings match the live docs
// confirmed 2026-06-17 (see openai.ts header comment):
//   response.output_text.delta (delta field) / response.completed.

/** Frame a Responses-API event the way the wire carries it: `data: {json}\n\n`. */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** Collect every `delta` string and whether a `response.completed` was seen. */
function extract(data: string[]): { text: string; completed: boolean } {
  let text = ''
  let completed = false
  for (const raw of data) {
    const event = JSON.parse(raw) as { type?: string; delta?: string }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta
    } else if (event.type === 'response.completed') {
      completed = true
    }
  }
  return { text, completed }
}

describe('SseParser', () => {
  it('parses a realistic Responses-API sequence in a single chunk', () => {
    const stream =
      frame({ type: 'response.created' }) +
      frame({ type: 'response.output_text.delta', delta: 'Hello' }) +
      frame({ type: 'response.output_text.delta', delta: ', ' }) +
      frame({ type: 'response.output_text.delta', delta: 'world!' }) +
      frame({ type: 'response.completed' })

    const events = parseSseEvents(stream)
    const { text, completed } = extract(events.map((e) => e.data))

    expect(text).toBe('Hello, world!')
    expect(completed).toBe(true)
  })

  it('buffers an event split across two chunks', () => {
    const parser = new SseParser()

    const full =
      frame({ type: 'response.output_text.delta', delta: 'Strea' }) +
      frame({ type: 'response.output_text.delta', delta: 'ming ' }) +
      frame({ type: 'response.output_text.delta', delta: 'works' }) +
      frame({ type: 'response.completed' })

    // Cut mid-way through the second event's JSON payload so neither chunk is a
    // whole event on its own — the parser must buffer the partial line.
    const cut = full.indexOf('Streaming') + 'Strea'.length
    const chunkA = full.slice(0, cut)
    const chunkB = full.slice(cut)

    const collected: string[] = []
    for (const e of parser.push(chunkA)) collected.push(e.data)
    for (const e of parser.push(chunkB)) collected.push(e.data)
    for (const e of parser.flush()) collected.push(e.data)

    const { text, completed } = extract(collected)
    expect(text).toBe('Streaming works')
    expect(completed).toBe(true)
  })

  it('handles multiple events arriving in one chunk and a boundary split between chunks', () => {
    const parser = new SseParser()

    // First chunk ends partway through the inter-event blank line ("\n\n").
    const chunkA = frame({ type: 'response.output_text.delta', delta: 'A' }) + 'data: '
    const chunkB =
      JSON.stringify({ type: 'response.output_text.delta', delta: 'B' }) +
      '\n\n' +
      frame({ type: 'response.completed' })

    const collected: string[] = []
    for (const e of parser.push(chunkA)) collected.push(e.data)
    for (const e of parser.push(chunkB)) collected.push(e.data)

    const { text, completed } = extract(collected)
    expect(text).toBe('AB')
    expect(completed).toBe(true)
  })

  it('ignores comment/heartbeat lines and a trailing [DONE] sentinel', () => {
    const stream =
      ': keep-alive\n\n' +
      frame({ type: 'response.output_text.delta', delta: 'Hi' }) +
      'data: [DONE]\n\n'

    const events = parseSseEvents(stream)

    // The comment yields no event; the [DONE] sentinel surfaces as raw data the
    // adapter filters — here we just assert the real delta came through.
    const deltas = events
      .filter((e) => e.data !== '[DONE]')
      .map((e) => JSON.parse(e.data) as { delta?: string })
      .map((e) => e.delta)
      .join('')
    expect(deltas).toBe('Hi')
    expect(events.some((e) => e.data === '[DONE]')).toBe(true)
  })

  it('normalizes CRLF line endings', () => {
    const stream =
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'X' })}\r\n\r\n` +
      `data: ${JSON.stringify({ type: 'response.completed' })}\r\n\r\n`

    const { text, completed } = extract(parseSseEvents(stream).map((e) => e.data))
    expect(text).toBe('X')
    expect(completed).toBe(true)
  })

  it('joins multiple data: lines within a single event with a newline', () => {
    const parser = new SseParser()
    const events = parser.push('data: line1\ndata: line2\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('line1\nline2')
  })
})

// ── OpenAI adapter: web-search request wiring ────────────────────────────────
// These stub global fetch (no network) to assert that `params.webSearch` toggles
// the hosted `web_search` tool in the Responses-API body, that the request is
// otherwise unchanged, and that text still streams as response.output_text.delta
// after the (server-side) search. Tool name verified 2026-06-17:
// https://developers.openai.com/api/docs/guides/tools-web-search

/** Build a Response whose body streams the given SSE text once, then closes. */
function sseResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Drain an async-iterable of chunks into an array. */
async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

describe('OpenAIProvider web search', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('declares supportsWebSearch', () => {
    expect(new OpenAIProvider().supportsWebSearch).toBe(true)
  })

  it('attaches the web_search tool only when webSearch is true, and still streams deltas', async () => {
    const body =
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Live ' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'answer' })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`

    const fetchMock = vi.fn(async () => sseResponse(body))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAIProvider()
    const chunks = await collect(
      provider.streamChat({
        apiKey: 'k',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'news?' }],
        webSearch: true
      })
    )

    // The hosted tool is present in the request body.
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      tools?: Array<{ type: string }>
      stream?: boolean
    }
    expect(sentBody.tools).toEqual([{ type: 'web_search' }])
    expect(sentBody.stream).toBe(true)

    // Text still arrives as response.output_text.delta after the server-side search.
    const text = chunks
      .filter((c): c is { type: 'delta'; text: string } => c.type === 'delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('Live answer')
  })

  it('omits the tools field entirely when webSearch is absent', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
    )
    vi.stubGlobal('fetch', fetchMock)

    await collect(
      new OpenAIProvider().streamChat({
        apiKey: 'k',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      tools?: unknown
    }
    expect(sentBody.tools).toBeUndefined()
  })
})

// ── OpenAI adapter: function-calling tool loop (streamWithTools) ──────────────
// These stub global fetch with a two-round NON-streaming /v1/responses sequence:
// round 1 returns a `function_call` item, round 2 returns the final text. They
// assert the Responses FLAT custom-function tool shape is sent (plus the hosted
// {type:'web_search'} when webSearch:true), that runTool is invoked with the
// right name+arguments, that round 2's `input` carries the function_call_output,
// and that the streamed result equals the final text. Shapes verified 2026-06-18:
// https://developers.openai.com/api/docs/guides/function-calling

/** A non-streaming /v1/responses JSON body. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** Round-1 body: the model asks to call a custom function. */
function functionCallBody(call: { call_id: string; name: string; arguments: string }): unknown {
  return {
    output: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments
      }
    ]
  }
}

/** Round-2 body: a final assistant text message item. */
function messageBody(text: string): unknown {
  return {
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      }
    ]
  }
}

const READ_FILE_TOOL: ToolSpec = {
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

describe('OpenAIProvider streamWithTools', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs a tool round then streams the final text; sends flat tools + web_search', async () => {
    const args = JSON.stringify({ path: 'src/index.ts' })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(functionCallBody({ call_id: 'call_abc', name: 'read_file', arguments: args }))
      )
      .mockResolvedValueOnce(jsonResponse(messageBody('All done.')))
    vi.stubGlobal('fetch', fetchMock)

    const runTool = vi.fn(async (_call: ToolCall) => 'file contents')

    const provider = new OpenAIProvider()
    const chunks = await collect(
      provider.streamWithTools!({
        apiKey: 'k',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'read the file' }],
        tools: [READ_FILE_TOOL],
        runTool,
        webSearch: true
      })
    )

    // Round 1 request: custom function declared in the FLAT Responses shape, plus
    // the hosted web_search tool. Each round is non-streaming.
    const round1 = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      tools?: Array<Record<string, unknown>>
      stream?: boolean
    }
    expect(round1.stream).toBe(false)
    expect(round1.tools).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      },
      { type: 'web_search' }
    ])

    // runTool was invoked with the model's name + raw JSON arguments.
    expect(runTool).toHaveBeenCalledTimes(1)
    const passedCall = runTool.mock.calls[0][0]
    expect(passedCall.name).toBe('read_file')
    expect(passedCall.arguments).toBe(args)
    expect(passedCall.id).toBe('call_abc')

    // Round 2 request: `input` carries the echoed function_call AND its output.
    const round2 = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      input?: Array<Record<string, unknown>>
    }
    const outputItem = round2.input?.find((i) => i.type === 'function_call_output')
    expect(outputItem).toEqual({
      type: 'function_call_output',
      call_id: 'call_abc',
      output: 'file contents'
    })
    const callItem = round2.input?.find((i) => i.type === 'function_call')
    expect(callItem).toMatchObject({ call_id: 'call_abc', name: 'read_file', arguments: args })

    // A status line was surfaced for the tool call.
    expect(chunks.some((c) => c.type === 'status')).toBe(true)

    // The streamed answer equals the final-round text.
    const text = chunks
      .filter((c): c is { type: 'delta'; text: string } => c.type === 'delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('All done.')
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'stop' })
  })

  it('omits the web_search tool when webSearch is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(messageBody('Hi.')))
    vi.stubGlobal('fetch', fetchMock)

    await collect(
      new OpenAIProvider().streamWithTools!({
        apiKey: 'k',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [READ_FILE_TOOL],
        runTool: async () => '',
        webSearch: false
      })
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      tools?: Array<{ type: string }>
    }
    expect(sent.tools?.some((t) => t.type === 'web_search')).toBe(false)
    expect(sent.tools).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    ])
  })

  it('surfaces cancellation as an error chunk without throwing', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const chunks = await collect(
      new OpenAIProvider().streamWithTools!({
        apiKey: 'k',
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [READ_FILE_TOOL],
        runTool: async () => '',
        signal: controller.signal
      })
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(chunks).toEqual([{ type: 'error', message: 'Cancelled.' }])
  })
})
