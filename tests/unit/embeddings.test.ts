import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createOpenAiEmbedder, EMBEDDING_DIM } from '@main/memory/embeddings'

// These tests exercise ONLY the pure embedder logic: the request shape it POSTs
// and how it orders the returned vectors. There is no network and no native
// import — global `fetch` is mocked. The key is supplied via the injected
// `getKey` resolver, mirroring how the caller wires it in production.

/** Build a deterministic 1536-dim vector whose first element marks it (for ordering asserts). */
function vec(marker: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[0] = marker
  return v
}

/** A Response-like object good enough for the embedder (ok + json()). */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createOpenAiEmbedder', () => {
  it('exposes the v1 OpenAI provider + model', () => {
    const embedder = createOpenAiEmbedder(async () => 'sk-test')
    expect(embedder.provider).toBe('openai')
    expect(embedder.model).toBe('text-embedding-3-small')
  })

  it('posts the model + input to the embeddings endpoint with a bearer key', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { index: 0, embedding: vec(10) },
          { index: 1, embedding: vec(20) }
        ]
      })
    )

    const embedder = createOpenAiEmbedder(async () => 'sk-secret')
    const out = await embedder.embed(['alpha', 'beta'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    expect(options.method).toBe('POST')

    const headers = options.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-secret')

    const sentBody = JSON.parse(options.body as string) as { model: string; input: string[] }
    expect(sentBody.model).toBe('text-embedding-3-small')
    expect(sentBody.input).toEqual(['alpha', 'beta'])

    expect(out).toHaveLength(2)
    expect(out[0][0]).toBe(10)
    expect(out[1][0]).toBe(20)
  })

  it('returns vectors in input order even when the response is out of order', async () => {
    // Response lists index 1 BEFORE index 0 — the embedder must sort by `index`.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { index: 1, embedding: vec(99) },
          { index: 0, embedding: vec(11) }
        ]
      })
    )

    const embedder = createOpenAiEmbedder(async () => 'sk-test')
    const out = await embedder.embed(['first', 'second'])

    expect(out[0][0]).toBe(11) // input position 0
    expect(out[1][0]).toBe(99) // input position 1
  })

  it('rejects with a clear error when getKey returns null', async () => {
    const embedder = createOpenAiEmbedder(async () => null)
    await expect(embedder.embed(['x'])).rejects.toThrow('No API key for openai embeddings')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns [] for empty input without any network call', async () => {
    const embedder = createOpenAiEmbedder(async () => 'sk-test')
    const out = await embedder.embed([])
    expect(out).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws a clear error on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'rate limited' } }, { ok: false, status: 429 })
    )

    const embedder = createOpenAiEmbedder(async () => 'sk-test')
    await expect(embedder.embed(['x'])).rejects.toThrow('rate limited')
  })

  it('resolves the key fresh on every embed call', async () => {
    const getKey = vi
      .fn<[], Promise<string | null>>()
      .mockResolvedValueOnce('sk-one')
      .mockResolvedValueOnce('sk-two')
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: vec(1) }] }))

    const embedder = createOpenAiEmbedder(getKey)
    await embedder.embed(['a'])
    await embedder.embed(['b'])

    expect(getKey).toHaveBeenCalledTimes(2)
    const first = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(first.input).toEqual(['a'])
    expect(second.input).toEqual(['b'])
  })
})
