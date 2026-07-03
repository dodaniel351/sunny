import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  OLLAMA_DEFAULT_BASE_URL,
  OllamaProvider,
  createOllamaEmbedder,
  isEmbedModelName,
  ollamaChatModels,
  ollamaEmbedModels
} from '@main/providers/ollama'
import type { StreamChunk } from '@main/providers/types'

// These tests exercise ONLY the pure Ollama adapter logic: the embed-model
// heuristic, how /api/tags is partitioned into chat vs embedding models, the
// /api/embed request shape, and the chat-completions SSE streaming. There is no
// network and no native import — global `fetch` is mocked throughout.

/** A Response-like object good enough for the JSON-returning helpers (ok + json/text). */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

/** Frame one chat-completions chunk the way the wire carries it: `data: {json}\n\n`. */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** A chat-completions delta chunk with text content. */
function deltaChunk(content: string): string {
  return frame({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  })
}

/** The terminal chunk: empty delta + a finish_reason. */
function finishChunk(reason: string): string {
  return frame({
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }]
  })
}

/** Wrap SSE text as a streaming Response whose body is a ReadableStream of bytes. */
function sseResponse(sse: string): Response {
  const bytes = new TextEncoder().encode(sse)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  })
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body
  } as unknown as Response
}

/** Drain a streamChat async-iterable into the collected delta text + terminal chunk. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<{
  text: string
  done: boolean
  finishReason?: string
  error?: string
}> {
  let text = ''
  let done = false
  let finishReason: string | undefined
  let error: string | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'delta') text += chunk.text
    else if (chunk.type === 'done') {
      done = true
      finishReason = chunk.finishReason
    } else error = chunk.message
  }
  return { text, done, finishReason, error }
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isEmbedModelName', () => {
  it('flags known embedding models', () => {
    expect(isEmbedModelName('nomic-embed-text')).toBe(true)
    expect(isEmbedModelName('mxbai-embed-large')).toBe(true)
    expect(isEmbedModelName('bge-m3')).toBe(true)
    expect(isEmbedModelName('snowflake-arctic-embed2')).toBe(true)
    expect(isEmbedModelName('all-minilm')).toBe(true)
  })

  it('does not flag chat models', () => {
    expect(isEmbedModelName('qwen3.5:9b')).toBe(false)
    expect(isEmbedModelName('gpt-oss:20b')).toBe(false)
    expect(isEmbedModelName('llama3')).toBe(false)
  })
})

describe('OLLAMA_DEFAULT_BASE_URL', () => {
  it('is the loopback daemon address', () => {
    expect(OLLAMA_DEFAULT_BASE_URL).toBe('http://localhost:11434')
  })
})

describe('ollamaReachable', () => {
  // Imported lazily so the heuristic tests above stay independent of fetch.
  it('is true on a 2xx /api/version and false on error', async () => {
    const { ollamaReachable } = await import('@main/providers/ollama')

    fetchMock.mockResolvedValueOnce(jsonResponse({ version: '0.1.0' }))
    expect(await ollamaReachable(OLLAMA_DEFAULT_BASE_URL)).toBe(true)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/api/version')

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(await ollamaReachable(OLLAMA_DEFAULT_BASE_URL)).toBe(false)
  })
})

describe('ollamaChatModels / ollamaEmbedModels', () => {
  const tags = {
    models: [
      { name: 'llama3' },
      { name: 'qwen3.5:9b' },
      { name: 'nomic-embed-text' },
      { name: 'gpt-oss:20b' },
      { name: 'bge-m3' }
    ]
  }

  it('returns only non-embedding models as {id,label} from /api/tags', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tags))

    const models = await ollamaChatModels(OLLAMA_DEFAULT_BASE_URL)
    expect(models).toEqual([
      { id: 'llama3', label: 'llama3' },
      { id: 'qwen3.5:9b', label: 'qwen3.5:9b' },
      { id: 'gpt-oss:20b', label: 'gpt-oss:20b' }
    ])

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/api/tags')
  })

  it('returns only embedding model names from /api/tags', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tags))

    const embeds = await ollamaEmbedModels(OLLAMA_DEFAULT_BASE_URL)
    expect(embeds).toEqual(['nomic-embed-text', 'bge-m3'])
  })

  it('returns [] on a fetch error', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    expect(await ollamaChatModels(OLLAMA_DEFAULT_BASE_URL)).toEqual([])
    expect(await ollamaEmbedModels(OLLAMA_DEFAULT_BASE_URL)).toEqual([])
  })
})

describe('createOllamaEmbedder', () => {
  it('exposes the ollama provider + the chosen model', () => {
    const embedder = createOllamaEmbedder(OLLAMA_DEFAULT_BASE_URL, 'nomic-embed-text')
    expect(embedder.provider).toBe('ollama')
    expect(embedder.model).toBe('nomic-embed-text')
  })

  it('posts {model,input} to /api/embed and returns the vectors in order', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        embeddings: [
          [1, 2, 3],
          [4, 5, 6]
        ]
      })
    )

    const embedder = createOllamaEmbedder(OLLAMA_DEFAULT_BASE_URL, 'nomic-embed-text')
    const out = await embedder.embed(['alpha', 'beta'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/api/embed')
    expect(options.method).toBe('POST')

    const headers = options.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()

    const sentBody = JSON.parse(options.body as string) as { model: string; input: string[] }
    expect(sentBody.model).toBe('nomic-embed-text')
    expect(sentBody.input).toEqual(['alpha', 'beta'])

    expect(out).toEqual([
      [1, 2, 3],
      [4, 5, 6]
    ])
  })

  it('returns [] for empty input without any network call', async () => {
    const embedder = createOllamaEmbedder(OLLAMA_DEFAULT_BASE_URL, 'nomic-embed-text')
    expect(await embedder.embed([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws a clear error on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse('model not found', { ok: false, status: 404 })
    )
    const embedder = createOllamaEmbedder(OLLAMA_DEFAULT_BASE_URL, 'missing')
    await expect(embedder.embed(['x'])).rejects.toThrow(/Ollama embeddings request failed/)
  })

  it('throws when the vector count does not match the input count', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [[1, 2, 3]] }))
    const embedder = createOllamaEmbedder(OLLAMA_DEFAULT_BASE_URL, 'nomic-embed-text')
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow(/1 vectors for 2 inputs/)
  })
})

describe('OllamaProvider', () => {
  it('has the keyless ollama identity', () => {
    const provider = new OllamaProvider(OLLAMA_DEFAULT_BASE_URL)
    expect(provider.kind).toBe('ollama')
    expect(provider.label).toBe('Ollama (local)')
    expect(provider.defaultModel).toBe('')
    expect(provider.listModels()).toEqual([])
  })

  it('validateKey is always ok (no key required)', async () => {
    const provider = new OllamaProvider(OLLAMA_DEFAULT_BASE_URL)
    expect(await provider.validateKey('ignored')).toEqual({ ok: true })
  })

  it('streamChat parses a mocked chat-completions SSE stream into deltas + done', async () => {
    const sse =
      frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) +
      deltaChunk('Hello') +
      deltaChunk(', ') +
      deltaChunk('world!') +
      finishChunk('stop') +
      'data: [DONE]\n\n'
    fetchMock.mockResolvedValueOnce(sseResponse(sse))

    const provider = new OllamaProvider(OLLAMA_DEFAULT_BASE_URL)
    const result = await drain(
      provider.streamChat({
        apiKey: '',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )

    expect(result.text).toBe('Hello, world!')
    expect(result.finishReason).toBe('stop')

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(options.method).toBe('POST')

    // Keyless: there must be NO Authorization header.
    const headers = options.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['content-type']).toBe('application/json')

    const sentBody = JSON.parse(options.body as string) as {
      model: string
      stream: boolean
      messages: Array<{ role: string; content: string }>
    }
    expect(sentBody.model).toBe('llama3')
    expect(sentBody.stream).toBe(true)
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('streamChat surfaces a non-2xx as an error chunk with a daemon hint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }))

    const provider = new OllamaProvider(OLLAMA_DEFAULT_BASE_URL)
    const result = await drain(
      provider.streamChat({ apiKey: '', model: 'llama3', messages: [] })
    )
    expect(result.text).toBe('')
    expect(result.error).toMatch(/Is Ollama running/)
  })

  it('streamChat surfaces a network failure as an error chunk with a daemon hint', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const provider = new OllamaProvider(OLLAMA_DEFAULT_BASE_URL)
    const result = await drain(
      provider.streamChat({ apiKey: '', model: 'llama3', messages: [] })
    )
    expect(result.error).toMatch(/Is Ollama running/)
  })
})
