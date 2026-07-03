// A deterministic, network-free Provider for tests and offline development.
//
// It never touches the network or native modules, so it is safe to use in unit
// tests (which run under system Node, not Electron) and in the registry behind
// an opt-in flag. It echoes the last user message back as a few streamed deltas,
// which is enough to exercise the IPC streaming path end-to-end without a key.

import type {
  KeyValidationResult,
  ModelInfo,
  Provider,
  StreamChatParams,
  StreamChunk,
  StreamWithToolsParams
} from './types'

export class FakeProvider implements Provider {
  readonly kind = 'fake'
  readonly label = 'Fake Provider'
  readonly defaultModel = 'fake-1'

  listModels(): ModelInfo[] {
    return [{ id: 'fake-1', label: 'Fake Model' }]
  }

  // Always "valid" — there is no real credential to check.
  async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    void _apiKey
    return { ok: true }
  }

  /**
   * Echo the last user turn as a handful of `delta` chunks, then `done`. Splitting
   * the reply into multiple deltas mirrors how a real stream arrives, so tests of
   * the consumer see realistic chunking.
   */
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamChunk> {
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user')
    const content = lastUser?.content ?? ''

    // Test hook: a real model returns JSON when asked (e.g. manager decomposition,
    // memory extraction). The fake can't reason, so if the prompt embeds
    // `@@JSON@@ {…}`, it returns exactly that JSON object as the reply. Uses a
    // balanced-brace scan (not a greedy regex) so trailing prompt text after the
    // directive isn't swept into the captured object.
    const directive = extractDirectiveJson(content)
    const reply = directive ?? `Echo: ${content}`

    for (const piece of splitIntoChunks(reply, 4)) {
      yield { type: 'delta', text: piece }
    }
    yield { type: 'done', finishReason: 'stop' }
  }

  /**
   * Function-calling path for tests. A real model decides when to call a tool;
   * the fake uses a deterministic directive instead: if the latest user turn
   * contains `@@TOOL@@ {json}` (json = { name, arguments }), it invokes that one
   * tool via `runTool` and returns the result as the answer. Without a directive
   * it behaves like `streamChat`. This lets the e2e exercise the real tool
   * registry (permission gate, workspace rooting, fs/shell) end-to-end.
   */
  async *streamWithTools(params: StreamWithToolsParams): AsyncIterable<StreamChunk> {
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user')
    const match = lastUser?.content.match(/@@TOOL@@\s*(\{[\s\S]*\})/)
    if (match) {
      try {
        const directive = JSON.parse(match[1]) as { name: string; arguments?: unknown }
        const call = {
          id: 'fake_call_1',
          name: directive.name,
          arguments: JSON.stringify(directive.arguments ?? {})
        }
        yield { type: 'status', text: `Running ${call.name}` }
        const result = await params.runTool(call)
        for (const piece of splitIntoChunks(`Tool(${call.name}): ${result}`, 4)) {
          yield { type: 'delta', text: piece }
        }
        yield { type: 'done', finishReason: 'stop' }
        return
      } catch {
        // Malformed directive — fall through to a plain echo.
      }
    }
    yield* this.streamChat(params)
  }
}

/**
 * Extract the first balanced `{…}` JSON object following an `@@JSON@@` marker, or
 * null if absent. A balanced-brace scan (not a regex) so instructions appended
 * after the directive aren't captured. Brace-counting ignores strings, which is
 * fine for the simple test payloads this hook handles.
 */
function extractDirectiveJson(content: string): string | null {
  const marker = content.indexOf('@@JSON@@')
  if (marker === -1) return null
  const start = content.indexOf('{', marker)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < content.length; i++) {
    if (content[i] === '{') depth++
    else if (content[i] === '}') {
      depth--
      if (depth === 0) return content.slice(start, i + 1)
    }
  }
  return null
}

/** Split `text` into at most `count` contiguous, roughly-even pieces (>=1). */
function splitIntoChunks(text: string, count: number): string[] {
  if (text.length === 0) return ['']
  const parts = Math.max(1, Math.min(count, text.length))
  const size = Math.ceil(text.length / parts)
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}
