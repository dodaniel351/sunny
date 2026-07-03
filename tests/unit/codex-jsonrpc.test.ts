import { describe, it, expect } from 'vitest'
import {
  NdjsonFramer,
  IdGenerator,
  encodeRequest,
  encodeNotification,
  isResponse,
  isNotification,
  isServerRequest,
  classify
} from '@main/codex/jsonrpc'

// These tests exercise ONLY the pure newline-delimited JSON-RPC codec
// (src/main/codex/jsonrpc.ts) — no child_process, no spawning, no IO. They feed
// it realistic Codex App Server wire lines (JSON-RPC 2.0 with the envelope
// field omitted: `{ id, method, params }` requests, `{ id, result|error }`
// responses, `{ method, params }` notifications).

/** Frame a value the way the App Server writes it: one JSON value + '\n'. */
function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

describe('NdjsonFramer', () => {
  it('frames multiple complete messages in a single chunk', () => {
    const stream =
      line({ id: 1, result: { ok: true } }) +
      line({ method: 'turn/started', params: {} }) +
      line({ method: 'item/agentMessage/delta', params: { delta: 'Hi' } })

    const framer = new NdjsonFramer()
    const values = framer.push(stream)

    expect(values).toHaveLength(3)
    expect(values[0]).toEqual({ id: 1, result: { ok: true } })
    expect(values[2]).toEqual({
      method: 'item/agentMessage/delta',
      params: { delta: 'Hi' }
    })
  })

  it('buffers a message split across two chunks', () => {
    const full =
      line({ method: 'item/agentMessage/delta', params: { delta: 'Strea' } }) +
      line({ method: 'item/agentMessage/delta', params: { delta: 'ming' } }) +
      line({ method: 'turn/completed', params: { status: 'completed' } })

    // Cut mid-way through the second line's JSON so neither chunk is a whole
    // line on its own — the framer must buffer the partial.
    const cut = full.indexOf('ming') + 2
    const chunkA = full.slice(0, cut)
    const chunkB = full.slice(cut)

    const framer = new NdjsonFramer()
    const first = framer.push(chunkA)
    const second = framer.push(chunkB)

    // First chunk completes only the first line; the partial second line waits.
    expect(first).toHaveLength(1)
    expect(first[0]).toEqual({
      method: 'item/agentMessage/delta',
      params: { delta: 'Strea' }
    })

    // Second chunk completes the buffered line plus the third.
    expect(second).toHaveLength(2)
    expect(second[0]).toEqual({
      method: 'item/agentMessage/delta',
      params: { delta: 'ming' }
    })
    expect(second[1]).toEqual({ method: 'turn/completed', params: { status: 'completed' } })
  })

  it('reassembles many tiny single-character chunks into one message', () => {
    const framer = new NdjsonFramer()
    const msg = line({ id: 7, result: { threadId: 'abc' } })

    const collected: unknown[] = []
    for (const ch of msg) collected.push(...framer.push(ch))

    expect(collected).toHaveLength(1)
    expect(collected[0]).toEqual({ id: 7, result: { threadId: 'abc' } })
  })

  it('tolerates CRLF line endings', () => {
    const framer = new NdjsonFramer()
    const values = framer.push(JSON.stringify({ id: 2, result: 1 }) + '\r\n')
    expect(values).toEqual([{ id: 2, result: 1 }])
  })

  it('ignores blank lines and skips malformed lines without losing the stream', () => {
    const framer = new NdjsonFramer()
    const stream = '\n' + 'not json\n' + line({ id: 3, result: 'ok' })
    const values = framer.push(stream)
    expect(values).toEqual([{ id: 3, result: 'ok' }])
  })

  it('flushes a trailing line that has no terminating newline', () => {
    const framer = new NdjsonFramer()
    const pushed = framer.push(JSON.stringify({ id: 9, result: 'tail' }))
    expect(pushed).toEqual([]) // no newline yet → buffered
    expect(framer.flush()).toEqual([{ id: 9, result: 'tail' }])
    // Flush is idempotent / empties the buffer.
    expect(framer.flush()).toEqual([])
  })
})

describe('IdGenerator + encodeRequest', () => {
  it('assigns incrementing ids', () => {
    const ids = new IdGenerator()
    expect(ids.take()).toBe(1)
    expect(ids.take()).toBe(2)
    expect(ids.take()).toBe(3)
  })

  it('encodes a request as a newline-terminated JSON line with id + method', () => {
    const wire = encodeRequest({ id: 1, method: 'initialize', params: { clientInfo: {} } })
    expect(wire.endsWith('\n')).toBe(true)
    expect(JSON.parse(wire.trimEnd())).toEqual({
      id: 1,
      method: 'initialize',
      params: { clientInfo: {} }
    })
  })

  it('always emits params (defaults to {}) — the App Server requires the field', () => {
    const wire = encodeRequest({ id: 5, method: 'account/logout' })
    const parsed = JSON.parse(wire.trimEnd()) as Record<string, unknown>
    expect(parsed).toEqual({ id: 5, method: 'account/logout', params: {} })
    expect('params' in parsed).toBe(true)
  })

  it('encodes a notification with no id but with params:{}', () => {
    const wire = encodeNotification({ method: 'initialized' })
    const parsed = JSON.parse(wire.trimEnd()) as Record<string, unknown>
    expect(parsed).toEqual({ method: 'initialized', params: {} })
    expect('id' in parsed).toBe(false)
    expect(wire.endsWith('\n')).toBe(true)
  })

  it('round-trips an encoded request back through the framer', () => {
    const ids = new IdGenerator()
    const id = ids.take()
    const wire = encodeRequest({ id, method: 'model/list' })
    const framer = new NdjsonFramer()
    const [value] = framer.push(wire)
    expect(value).toEqual({ id: 1, method: 'model/list', params: {} })
  })
})

describe('classification (response vs notification)', () => {
  it('classifies a result response', () => {
    const msg = { id: 4, result: { threadId: 't1' } }
    expect(isResponse(msg)).toBe(true)
    expect(isNotification(msg)).toBe(false)
    expect(classify(msg)).toEqual({ kind: 'response', message: msg })
  })

  it('classifies an error response', () => {
    const msg = { id: 8, error: { code: -32601, message: 'Method not found' } }
    expect(isResponse(msg)).toBe(true)
    expect(classify(msg)).toEqual({ kind: 'response', message: msg })
  })

  it('classifies a notification (method, no id)', () => {
    const msg = { method: 'account/updated', params: { account: { type: 'chatgpt' } } }
    expect(isNotification(msg)).toBe(true)
    expect(isResponse(msg)).toBe(false)
    expect(classify(msg)).toEqual({ kind: 'notification', message: msg })
  })

  it('does NOT classify a server-initiated request (has both id and method)', () => {
    // Approval prompts carry both an id and a method; classify() must leave them
    // alone (app-server.ts auto-declines them via isServerRequest).
    const msg = { id: 11, method: 'item/commandExecution/requestApproval', params: {} }
    expect(isServerRequest(msg)).toBe(true)
    expect(classify(msg)).toBeUndefined()
  })

  it('rejects non-objects and missing fields', () => {
    expect(isResponse(null)).toBe(false)
    expect(isResponse(42)).toBe(false)
    expect(isResponse({ id: 'not-a-number', result: 1 })).toBe(false)
    expect(isNotification({ params: {} })).toBe(false)
    expect(classify('garbage')).toBeUndefined()
  })
})

describe('response→request id matching', () => {
  it('matches each response back to the request id that produced it', () => {
    const ids = new IdGenerator()
    // Encode three requests, capturing their assigned ids.
    const initId = ids.take()
    const modelsId = ids.take()
    const threadId = ids.take()
    encodeRequest({ id: initId, method: 'initialize' })
    encodeRequest({ id: modelsId, method: 'model/list' })
    encodeRequest({ id: threadId, method: 'thread/start' })

    // Server replies out of order; the framer parses them, classify identifies
    // responses, and the `id` field is what a client uses to match them.
    const framer = new NdjsonFramer()
    const stream =
      line({ id: threadId, result: { threadId: 'th_1' } }) +
      line({ id: initId, result: { ok: true } }) +
      line({ method: 'turn/started', params: {} }) +
      line({ id: modelsId, result: { models: [] } })

    const byId = new Map<number, unknown>()
    for (const value of framer.push(stream)) {
      const c = classify(value)
      if (c?.kind === 'response') byId.set(c.message.id, c.message.result)
    }

    expect(byId.get(initId)).toEqual({ ok: true })
    expect(byId.get(modelsId)).toEqual({ models: [] })
    expect(byId.get(threadId)).toEqual({ threadId: 'th_1' })
    // The interleaved notification was not counted as a response.
    expect(byId.size).toBe(3)
  })
})
