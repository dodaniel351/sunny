import { describe, it, expect, afterEach, vi } from 'vitest'
import { GeminiProvider } from '@main/providers/gemini'
import type { StreamChunk, ToolCall, ToolSpec } from '@main/providers/types'

// These tests drive the real GeminiProvider adapter (src/main/providers/gemini.ts)
// with a mocked global `fetch` — no actual network, no native imports. The body
// is a ReadableStream of realistic Generative Language API `alt=sse` chunks, each
// carrying the text delta at candidates[0].content.parts[0].text. We assert that
// the streamed deltas reassemble into the full text and that a terminal `done`
// is emitted, since Gemini has no explicit end event.

/** Frame a Gemini stream chunk the way `alt=sse` carries it: `data: {json}\n\n`. */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** A GenerateContentResponse-shaped chunk carrying a single text part. */
function textChunk(text: string, finishReason?: string): unknown {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        ...(finishReason ? { finishReason } : {})
      }
    ]
  }
}

/** Build a Response whose body streams `sse`, optionally split into raw chunks. */
function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, ...init })
}

/** Drain an async iterable of chunks into an array. */
async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

/** Concatenate the text of every `delta` chunk. */
function deltaText(chunks: StreamChunk[]): string {
  return chunks
    .filter((c): c is { type: 'delta'; text: string } => c.type === 'delta')
    .map((c) => c.text)
    .join('')
}

const provider = new GeminiProvider()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GeminiProvider.streamChat', () => {
  it('reassembles deltas from a realistic alt=sse stream and ends with done', async () => {
    const sse =
      frame(textChunk('Hello')) +
      frame(textChunk(', ')) +
      frame(textChunk('world')) +
      frame(textChunk('!', 'STOP'))

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([sse]))
    )

    const chunks = await collect(
      provider.streamChat({
        apiKey: 'k',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )

    expect(deltaText(chunks)).toBe('Hello, world!')
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it('handles an event split across multiple network chunks', async () => {
    const full =
      frame(textChunk('Strea')) + frame(textChunk('ming ')) + frame(textChunk('works'))

    // Cut mid-way through the second event's JSON payload.
    const cut = full.indexOf('ming') - 'data: '.length + 1
    const sse = [full.slice(0, cut), full.slice(cut)]

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(sse))
    )

    const chunks = await collect(
      provider.streamChat({
        apiKey: 'k',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )

    expect(deltaText(chunks)).toBe('Streaming works')
    expect(chunks.at(-1)).toEqual({ type: 'done' })
  })

  it('maps system/assistant turns and posts the documented request body', async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame(textChunk('ok'))]))
    vi.stubGlobal('fetch', fetchMock)

    await collect(
      provider.streamChat({
        apiKey: 'secret',
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
          { role: 'user', content: 'Bye' }
        ]
      })
    )

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=secret')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')

    const sent = JSON.parse(init.body as string) as {
      systemInstruction?: { parts: { text: string }[] }
      contents: { role: string; parts: { text: string }[] }[]
    }
    expect(sent.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] })
    expect(sent.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ text: 'Hello' }] },
      { role: 'user', parts: [{ text: 'Bye' }] }
    ])
  })

  it('attaches the native google_search tool when webSearch is true', async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame(textChunk('ok'))]))
    vi.stubGlobal('fetch', fetchMock)

    await collect(
      provider.streamChat({
        apiKey: 'k',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'what is new today' }],
        webSearch: true
      })
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = JSON.parse(init.body as string) as { tools?: unknown[] }
    expect(sent.tools).toEqual([{ google_search: {} }])
  })

  it('does NOT attach any tools when webSearch is omitted or false', async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame(textChunk('ok'))]))
    vi.stubGlobal('fetch', fetchMock)

    // Omitted.
    await collect(
      provider.streamChat({
        apiKey: 'k',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )
    // Explicit false.
    await collect(
      provider.streamChat({
        apiKey: 'k',
        model: 'gemini-2.5-flash',
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

  it('surfaces a friendly error for a 400 API-key response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' }
            }),
            { status: 400 }
          )
      )
    )

    const chunks = await collect(
      provider.streamChat({
        apiKey: 'bad',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )

    expect(chunks).toEqual([{ type: 'error', message: 'Invalid Google API key' }])
  })
})

describe('GeminiProvider metadata and validateKey', () => {
  it('exposes the expected kind, label, default model, and model list', () => {
    expect(provider.kind).toBe('google')
    expect(provider.label).toBe('Google Gemini')
    expect(provider.defaultModel).toBe('gemini-2.5-flash')
    expect(provider.supportsWebSearch).toBe(true)

    const ids = provider.listModels().map((m) => m.id)
    expect(ids).toContain('gemini-2.5-flash')
    expect(ids).toContain('gemini-3.5-flash')
    expect(ids).toContain('gemini-2.5-flash-lite')
  })

  it('returns ok for a 200 from the models probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    )
    expect(await provider.validateKey('good')).toEqual({ ok: true })
  })

  it('returns a friendly error for a 403 from the models probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403, statusText: 'Forbidden' }))
    )
    expect(await provider.validateKey('bad')).toEqual({ ok: false, error: 'Invalid API key' })
  })
})

// ── streamWithTools: the agentic function-calling loop ──
// Unlike streamChat, this path uses NON-streaming generateContent. We mock fetch
// to return a JSON body per round: round 1 a candidate whose content.parts[]
// carries a `functionCall`, round 2 a candidate carrying a final `text` part.
// We assert the request maps ToolSpec → functionDeclarations, runTool gets the
// right name+args, round 2's request echoes the model turn AND a `functionResponse`,
// and the streamed answer equals the final text.

/** A non-streamed generateContent Response carrying one candidate. */
function jsonResponse(obj: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(obj), { status: 200, ...init })
}

/** A generateContent body whose single candidate emits a functionCall part. */
function functionCallResponse(name: string, args: Record<string, unknown>): unknown {
  return {
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }]
  }
}

/** A generateContent body whose single candidate emits a final text part. */
function finalTextResponse(text: string, finishReason = 'STOP'): unknown {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }]
  }
}

const webSearchTool: ToolSpec = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query']
    }
  }
}

describe('GeminiProvider.streamWithTools', () => {
  it('runs a tool round then streams the final answer', async () => {
    const fetchMock = vi
      .fn<(...args: unknown[]) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(functionCallResponse('web_search', { query: 'sunny day' })))
      .mockResolvedValueOnce(jsonResponse(finalTextResponse('It is sunny.')))
    vi.stubGlobal('fetch', fetchMock)

    const calls: ToolCall[] = []
    const runTool = vi.fn(async (call: ToolCall) => {
      calls.push(call)
      return 'Search result: clear skies'
    })

    const chunks = await collect(
      provider.streamWithTools({
        apiKey: 'secret',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'is it sunny?' }],
        tools: [webSearchTool],
        runTool
      })
    )

    // Two rounds → two generateContent calls (NOT streamGenerateContent).
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url1, init1] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url1).toContain('/models/gemini-2.5-flash:generateContent?key=secret')
    expect(url1).not.toContain('streamGenerateContent')

    // Round 1 request maps the ToolSpec into Gemini functionDeclarations and
    // does NOT attach google_search alongside the agent tools.
    const sent1 = JSON.parse(init1.body as string) as {
      tools?: { functionDeclarations?: unknown[]; google_search?: unknown }[]
      contents: { role: string; parts: unknown[] }[]
    }
    expect(sent1.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'web_search',
            description: 'Search the web for current information.',
            parameters: webSearchTool.function.parameters
          }
        ]
      }
    ])
    expect(sent1.tools?.[0]).not.toHaveProperty('google_search')

    // runTool was invoked with the model-emitted name + args (JSON-encoded).
    expect(runTool).toHaveBeenCalledTimes(1)
    expect(calls[0].name).toBe('web_search')
    expect(JSON.parse(calls[0].arguments)).toEqual({ query: 'sunny day' })

    // Round 2's contents echo the model's functionCall turn and append a
    // functionResponse (role 'user') carrying the tool result.
    const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit]
    const sent2 = JSON.parse(init2.body as string) as {
      contents: { role: string; parts: Record<string, unknown>[] }[]
    }
    const echoed = sent2.contents.find((c) =>
      c.parts.some((p) => 'functionCall' in p)
    )
    expect(echoed?.role).toBe('model')
    const responseTurn = sent2.contents.find((c) =>
      c.parts.some((p) => 'functionResponse' in p)
    )
    expect(responseTurn?.role).toBe('user')
    expect(responseTurn?.parts[0].functionResponse).toEqual({
      name: 'web_search',
      response: { result: 'Search result: clear skies' }
    })

    // A status chunk is emitted for the tool call, and the final answer is the
    // round-2 text with a terminal done.
    expect(chunks.some((c) => c.type === 'status')).toBe(true)
    expect(deltaText(chunks)).toBe('It is sunny.')
    expect(chunks.at(-1)).toEqual({ type: 'done', finishReason: 'STOP' })
  })

  it('surfaces a friendly error for a 400 API-key response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT'
            }
          },
          { status: 400 }
        )
      )
    )

    const chunks = await collect(
      provider.streamWithTools({
        apiKey: 'bad',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [webSearchTool],
        runTool: async () => 'unused'
      })
    )

    expect(chunks).toEqual([{ type: 'error', message: 'Invalid Google API key' }])
  })

  it('honors an already-aborted signal without calling fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(finalTextResponse('nope')))
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      provider.streamWithTools({
        apiKey: 'k',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [webSearchTool],
        runTool: async () => 'unused',
        signal: controller.signal
      })
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(chunks).toEqual([{ type: 'error', message: 'Cancelled.' }])
  })
})
