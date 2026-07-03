import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runToolLoop } from '@main/providers/tool-loop'
import type { StreamChunk, ToolCall, ToolSpec } from '@main/providers/types'

// Tests the shared OpenAI-style function-calling loop with a mocked
// chat/completions endpoint (non-streaming JSON rounds). No network, no native.

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

/** A chat-completions response that requests one tool call. */
function toolCallResponse(name: string, args: object): unknown {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: 'tool_calls'
      }
    ]
  }
}

/** A chat-completions response with a final text answer. */
function answerResponse(text: string): unknown {
  return { choices: [{ message: { content: text }, finish_reason: 'stop' }] }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<{
  deltas: string
  statuses: string[]
  done: boolean
  error?: string
}> {
  let deltas = ''
  const statuses: string[] = []
  let done = false
  let error: string | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'delta') deltas += chunk.text
    else if (chunk.type === 'status') statuses.push(chunk.text)
    else if (chunk.type === 'done') done = true
    else error = chunk.message
  }
  return { deltas, statuses, done, error }
}

const TOOLS: ToolSpec[] = [
  { type: 'function', function: { name: 'web_search', description: 'search', parameters: {} } }
]

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runToolLoop', () => {
  it('answers directly when the model requests no tools', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(answerResponse('Hi there')))

    const result = await drain(
      runToolLoop({
        url: 'http://x/v1/chat/completions',
        headers: {},
        model: 'qwen',
        messages: [{ role: 'user', content: 'hello' }],
        tools: TOOLS,
        runTool: async () => 'unused'
      })
    )

    expect(result.deltas).toBe('Hi there')
    expect(result.done).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // First round offers the tools.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.tools).toHaveLength(1)
    expect(body.tool_choice).toBe('auto')
    expect(body.stream).toBe(false)
  })

  it('runs a requested tool, feeds the result back, then returns the final answer', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(toolCallResponse('web_search', { query: 'cats' })))
      .mockResolvedValueOnce(jsonResponse(answerResponse('Cats are great.')))

    const calls: ToolCall[] = []
    const result = await drain(
      runToolLoop({
        url: 'http://x/v1/chat/completions',
        headers: { Authorization: 'Bearer k' },
        model: 'qwen',
        messages: [{ role: 'user', content: 'tell me about cats' }],
        tools: TOOLS,
        runTool: async (c) => {
          calls.push(c)
          return 'search results: cats meow'
        }
      })
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('web_search')
    expect(result.statuses.length).toBeGreaterThanOrEqual(1) // a status per tool call
    expect(result.deltas).toBe('Cats are great.')
    expect(result.done).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Round 2 must include the assistant tool_call turn + the tool result message.
    const round2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    const roles = round2.messages.map((m: { role: string }) => m.role)
    expect(roles).toContain('assistant')
    expect(roles).toContain('tool')
    const toolMsg = round2.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg.content).toBe('search results: cats meow')
    expect(toolMsg.tool_call_id).toBe('call_1')
  })

  it('continues when a tool executor throws (result becomes an error string)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(toolCallResponse('web_search', { query: 'x' })))
      .mockResolvedValueOnce(jsonResponse(answerResponse('done anyway')))

    const result = await drain(
      runToolLoop({
        url: 'http://x/v1/chat/completions',
        headers: {},
        model: 'qwen',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOLS,
        runTool: async () => {
          throw new Error('tool blew up')
        }
      })
    )

    expect(result.deltas).toBe('done anyway')
    const round2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    const toolMsg = round2.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg.content).toMatch(/Error: tool blew up/)
  })

  it('withholds tools on the final round to force a text answer', async () => {
    // maxRounds=2, and the model keeps asking for tools — round 2 must omit tools.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(toolCallResponse('web_search', { query: 'a' })))
      .mockResolvedValueOnce(jsonResponse(answerResponse('final')))

    await drain(
      runToolLoop({
        url: 'http://x/v1/chat/completions',
        headers: {},
        model: 'qwen',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOLS,
        runTool: async () => 'r',
        maxRounds: 2
      })
    )

    const round2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(round2.tools).toBeUndefined()
    expect(round2.tool_choice).toBeUndefined()
  })

  it('surfaces a non-2xx as an error chunk', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'bad' } }, { ok: false, status: 500 }))
    const result = await drain(
      runToolLoop({
        url: 'http://x/v1/chat/completions',
        headers: {},
        model: 'qwen',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOLS,
        runTool: async () => 'r'
      })
    )
    expect(result.error).toBe('bad')
    expect(result.done).toBe(false)
  })

  it('accumulates token usage across rounds and emits one usage chunk before done', async () => {
    const withUsage = (body: Record<string, unknown>, prompt: number, completion: number): unknown => ({
      ...body,
      usage: { prompt_tokens: prompt, completion_tokens: completion }
    })
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(withUsage(toolCallResponse('web_search', { query: 'a' }) as Record<string, unknown>, 100, 20))
      )
      .mockResolvedValueOnce(
        jsonResponse(withUsage(answerResponse('final') as Record<string, unknown>, 150, 30))
      )

    const chunks: StreamChunk[] = []
    for await (const chunk of runToolLoop({
      url: 'http://x/v1/chat/completions',
      headers: {},
      model: 'qwen',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
      runTool: async () => 'r'
    })) {
      chunks.push(chunk)
    }

    const usage = chunks.filter((c) => c.type === 'usage')
    expect(usage).toEqual([{ type: 'usage', promptTokens: 250, completionTokens: 50 }])
    // Usage arrives before the terminal done.
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done', finishReason: 'stop' })
  })

  it('emits no usage chunk when the provider reports none', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(answerResponse('Hi')))
    const chunks: StreamChunk[] = []
    for await (const chunk of runToolLoop({
      url: 'http://x/v1/chat/completions',
      headers: {},
      model: 'qwen',
      messages: [{ role: 'user', content: 'hello' }],
      tools: TOOLS,
      runTool: async () => 'r'
    })) {
      chunks.push(chunk)
    }
    expect(chunks.some((c) => c.type === 'usage')).toBe(false)
  })
})
