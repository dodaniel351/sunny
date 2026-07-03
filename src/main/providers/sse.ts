// A pure, network-free Server-Sent Events (SSE) parser.
//
// Why this is its own module: keeping the framing logic free of `fetch`, native
// modules, and TextDecoder makes it trivially unit-testable (see
// tests/unit/openai-sse.test.ts). The OpenAI adapter feeds it already-decoded
// text; this file only understands the wire framing, not HTTP.
//
// SSE framing recap (https://html.spec.whatwg.org/multipage/server-sent-events.html):
//   - An event is a block of lines terminated by a blank line.
//   - Lines beginning `data:` carry the payload; multiple `data:` lines in one
//     event are joined with '\n'.
//   - Lines beginning `event:` set the event name (the OpenAI Responses API does
//     NOT use this — it puts the discriminating `type` inside the JSON payload —
//     but we parse it anyway so the module is a general SSE parser).
//   - Lines beginning `:` are comments and are ignored.
// Across a chunked HTTP stream an event can be split mid-line, so we buffer
// whatever is left after the last event boundary and prepend it to the next
// chunk.

/** One decoded SSE event: its optional `event:` name and joined `data` payload. */
export interface SseEvent {
  /** The `event:` field value, or undefined when the stream omits it. */
  event?: string
  /** The joined `data:` payload (multiple data lines joined with '\n'). */
  data: string
}

/**
 * Incremental SSE parser. Feed it decoded text chunks in arrival order; it
 * returns the events completed by each chunk and buffers any partial trailing
 * event until more text arrives.
 */
export class SseParser {
  // Holds bytes seen so far that have not yet formed a complete event.
  private buffer = ''

  /**
   * Push a decoded text chunk and return every event whose terminating blank
   * line is now present. Partial events stay buffered for the next call.
   */
  push(chunk: string): SseEvent[] {
    // Normalize CRLF/CR to LF so boundary detection is uniform across servers.
    this.buffer += chunk.replace(/\r\n?/g, '\n')

    const events: SseEvent[] = []

    // Events are separated by a blank line, i.e. a double newline. Everything up
    // to the last boundary is complete; the remainder is a partial event.
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const rawEvent = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)

      const parsed = parseEventBlock(rawEvent)
      if (parsed) events.push(parsed)

      boundary = this.buffer.indexOf('\n\n')
    }

    return events
  }

  /**
   * Flush any buffered text as a final event. Most well-behaved streams end with
   * a blank line so nothing remains, but a server may close the connection right
   * after the last `data:` line without the trailing boundary.
   */
  flush(): SseEvent[] {
    const remaining = this.buffer.trim()
    this.buffer = ''
    if (remaining === '') return []
    const parsed = parseEventBlock(remaining)
    return parsed ? [parsed] : []
  }
}

/**
 * Parse one event block (the text between two blank-line boundaries) into its
 * `event` name and joined `data`. Returns undefined for comment-only or empty
 * blocks (e.g. heartbeat `:` lines) that carry no data.
 */
function parseEventBlock(block: string): SseEvent | undefined {
  let eventName: string | undefined
  const dataLines: string[] = []

  for (const line of block.split('\n')) {
    // Comment lines (and the SSE heartbeat) start with ':' — ignore them.
    if (line === '' || line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // Per spec, a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
    // Other fields (id, retry) are irrelevant to the Responses API; skip them.
  }

  if (dataLines.length === 0) return undefined
  return eventName === undefined
    ? { data: dataLines.join('\n') }
    : { event: eventName, data: dataLines.join('\n') }
}

/**
 * Convenience helper for tests and simple callers: parse a complete SSE payload
 * (already fully buffered) into its events in one shot.
 */
export function parseSseEvents(text: string): SseEvent[] {
  const parser = new SseParser()
  return [...parser.push(text), ...parser.flush()]
}
