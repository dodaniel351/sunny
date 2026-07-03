import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  handleData,
  createPerplexityProvider,
  createOpenRouterProvider,
  createGroqProvider
} from '@main/providers/openai-compatible'
import { parseSseEvents, SseParser } from '@main/providers/sse'

// These tests exercise ONLY the pure pieces of the OpenAI-compatible adapter —
// the shared SseParser framing plus the adapter's `handleData` delta-extraction.
// No network, no fetch, no native imports. They feed a realistic OpenAI
// chat-completions SSE stream (the OLDER /chat/completions shape used by
// OpenRouter and Groq) and assert the deltas reassemble correctly and the
// terminal events are detected.

/** Frame one chat-completions chunk the way the wire carries it: `data: {json}\n\n`. */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** A chat-completions delta chunk with text content. */
function delta(content: string): string {
  return frame({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  })
}

/** The terminal chunk: empty delta + a finish_reason. */
function finish(reason: string): string {
  return frame({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }]
  })
}

/** Run decoded SSE event data lines through handleData and collect the result. */
function run(dataLines: string[]): { text: string; finishReason?: string } {
  let text = ''
  let finishReason: string | undefined
  for (const data of dataLines) {
    const chunk = handleData(data)
    if (!chunk) continue
    if (chunk.type === 'delta') text += chunk.text
    else if (chunk.type === 'done') finishReason = chunk.finishReason
  }
  return { text, finishReason }
}

describe('openai-compatible chat-completions stream', () => {
  it('reassembles deltas from a realistic stream and reads finish_reason', () => {
    const stream =
      // First chunk often carries the assistant role with no content.
      frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) +
      delta('Hello') +
      delta(', ') +
      delta('world!') +
      finish('stop') +
      'data: [DONE]\n\n'

    const events = parseSseEvents(stream)
    const { text, finishReason } = run(events.map((e) => e.data))

    expect(text).toBe('Hello, world!')
    expect(finishReason).toBe('stop')
  })

  it('handles an event split across two chunks via the SseParser', () => {
    const parser = new SseParser()
    const full = delta('Strea') + delta('ming ') + delta('works') + finish('stop')

    // Cut mid-way through the second chunk's JSON so neither half is a whole event.
    const cut = full.indexOf('ming ')
    const collected: string[] = []
    for (const e of parser.push(full.slice(0, cut))) collected.push(e.data)
    for (const e of parser.push(full.slice(cut))) collected.push(e.data)
    for (const e of parser.flush()) collected.push(e.data)

    const { text, finishReason } = run(collected)
    expect(text).toBe('Streaming works')
    expect(finishReason).toBe('stop')
  })

  it('ignores the [DONE] sentinel, empty deltas, and non-JSON lines', () => {
    expect(handleData('[DONE]')).toBeUndefined()
    expect(handleData('not json')).toBeUndefined()
    expect(
      handleData(JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: null }] }))
    ).toBeUndefined()
  })

  it('extracts a single delta and a terminal done independently', () => {
    expect(handleData(JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }))).toEqual({
      type: 'delta',
      text: 'Hi'
    })
    expect(
      handleData(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }))
    ).toEqual({ type: 'done', finishReason: 'length' })
  })
})

// ── Perplexity preset + supportsWebSearch wiring ─────────────────────────────
// Base URL + model ids verified 2026-06-17 (live 401 probe on
// https://api.perplexity.ai/chat/completions; ids from
// https://docs.perplexity.ai/getting-started/models).

describe('createPerplexityProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is a web-native provider with the verified base/models/default', () => {
    const p = createPerplexityProvider()
    expect(p.kind).toBe('perplexity')
    expect(p.label).toBe('Perplexity')
    expect(p.supportsWebSearch).toBe(true)
    expect(p.defaultModel).toBe('sonar-pro')
    const ids = p.listModels().map((m) => m.id)
    expect(ids).toContain('sonar')
    expect(ids).toContain('sonar-pro')
    expect(ids).toContain('sonar-reasoning-pro')
    expect(ids).toContain('sonar-deep-research')
    // The default must be one of the listed models.
    expect(ids).toContain(p.defaultModel)
  })

  it('leaves the OpenRouter/Groq aggregator presets non-web-search', () => {
    expect(createOpenRouterProvider().supportsWebSearch).toBe(false)
    expect(createGroqProvider().supportsWebSearch).toBe(false)
  })

  it('validates a key via a POST /chat/completions probe (no GET /models)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPerplexityProvider().validateKey('pplx-key')
    expect(result.ok).toBe(true)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.perplexity.ai/chat/completions')
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body as string) as { model: string; stream: boolean }
    expect(sent.model).toBe('sonar')
    expect(sent.stream).toBe(false)
  })

  it('maps a 401 from the probe to an invalid-key result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    )
    const result = await createPerplexityProvider().validateKey('bad')
    expect(result).toEqual({ ok: false, error: 'Invalid API key' })
  })

  it('aggregator presets still validate via GET /models', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await createGroqProvider().validateKey('groq-key')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.groq.com/openai/v1/models')
    expect(init.method).toBe('GET')
  })
})

// ── OpenRouter live model catalog (fetchModels) ──────────────────────────────
// OpenRouter exposes 300+ models via GET /models; the adapter pulls the live
// list once connected and falls back to the static set on failure.

describe('OpenRouter live model catalog (fetchModels)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes fetchModels only when liveModels is enabled', () => {
    expect(typeof createOpenRouterProvider().fetchModels).toBe('function')
    expect(createGroqProvider().fetchModels).toBeUndefined()
    expect(createPerplexityProvider().fetchModels).toBeUndefined()
  })

  it('parses GET /models into sorted ModelInfo, mapping name + context_length', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'z/noname' }, // no name → label falls back to id; no contextWindow
              { id: 'a/model', name: 'Alpha', context_length: 200000 },
              { id: 'm/model', name: 'Mid', context_length: 8000 },
              { id: 42 } // invalid id → dropped
            ]
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetchMock)

    const models = await createOpenRouterProvider().fetchModels!('or-key')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/models')
    expect(init.method).toBe('GET')

    // Invalid row dropped; remaining sorted by label (Alpha, Mid, z/noname).
    expect(models.map((m) => m.id)).toEqual(['a/model', 'm/model', 'z/noname'])
    expect(models[0]).toEqual({ id: 'a/model', label: 'Alpha', contextWindow: 200000 })
    expect(models.find((m) => m.id === 'z/noname')).toEqual({ id: 'z/noname', label: 'z/noname' })
  })

  it('throws on a non-OK /models response so the caller can fall back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    )
    await expect(createOpenRouterProvider().fetchModels!('k')).rejects.toThrow()
  })
})
