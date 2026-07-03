// A pure, IO-free codec for the Codex App Server's wire protocol.
//
// Why this is its own module: keeping the framing/encoding logic free of
// `child_process`, sockets, and process stdio makes it trivially unit-testable
// (see tests/unit/codex-jsonrpc.test.ts). `app-server.ts` owns the spawned
// process and feeds this module the already-read stdout text.
//
// ── Wire format, per developers.openai.com/codex (App Server) ──
// `codex app-server` speaks JSON-RPC 2.0 over stdio as newline-delimited JSON
// (one JSON value per line, '\n' terminated). On the wire the `"jsonrpc":"2.0"`
// envelope field is omitted — each line is just `{ id, method, params }` for a
// request, `{ id, result | error }` for a response, or `{ method, params }`
// (no `id`) for a notification.

/** A JSON-RPC request we send to the server (id-bearing, expects a response). */
export interface JsonRpcRequest {
  id: number
  method: string
  params?: unknown
}

/** A JSON-RPC notification we send to the server (no id, no response). */
export interface JsonRpcNotification {
  method: string
  params?: unknown
}

/** The error shape carried by a JSON-RPC error response. */
export interface JsonRpcError {
  code?: number
  message: string
  data?: unknown
}

/** A response from the server, matched back to a request by `id`. */
export interface JsonRpcResponse {
  id: number
  result?: unknown
  error?: JsonRpcError
}

/** Any message parsed off the wire: a response (has `id`) or a notification. */
export type JsonRpcIncoming =
  | { kind: 'response'; message: JsonRpcResponse }
  | { kind: 'notification'; message: JsonRpcNotification }

/**
 * Incremental newline-delimited JSON framer. Feed it stdout text chunks in
 * arrival order; it returns every complete line decoded as a JSON value and
 * buffers any partial trailing line until the rest arrives. A single logical
 * message can be split across multiple `read()` chunks, so the partial line
 * must survive between calls.
 */
export class NdjsonFramer {
  // Text seen so far that has not yet been terminated by a newline.
  private buffer = ''

  /**
   * Push a decoded text chunk and return every JSON value whose terminating
   * newline is now present. Lines that fail to parse as JSON are skipped (a
   * malformed line must not corrupt the rest of the stream). Blank lines are
   * ignored.
   */
  push(chunk: string): unknown[] {
    this.buffer += chunk

    const values: unknown[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      // Tolerate CRLF as well as LF by trimming a trailing '\r'.
      const rawLine = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)

      if (rawLine.trim() !== '') {
        const parsed = tryParse(rawLine)
        if (parsed !== undefined) values.push(parsed)
      }

      newline = this.buffer.indexOf('\n')
    }

    return values
  }

  /**
   * Flush any buffered text as a final line. Well-behaved servers newline-
   * terminate every message so nothing remains, but a process may write a last
   * line without a trailing newline before its stdout closes.
   */
  flush(): unknown[] {
    const remaining = this.buffer.trim()
    this.buffer = ''
    if (remaining === '') return []
    const parsed = tryParse(remaining)
    return parsed === undefined ? [] : [parsed]
  }
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Assigns incrementing request ids. App Server JSON-RPC ids are unique per
 * connection; a simple monotonic counter satisfies that.
 */
export class IdGenerator {
  private next = 1

  take(): number {
    return this.next++
  }
}

/**
 * Encode a request to its wire line (newline-terminated). The `id` is assigned
 * by the caller (via IdGenerator) so the caller can register the pending
 * promise under that id before writing.
 *
 * `params` is ALWAYS emitted (defaulting to `{}`): the Codex App Server's
 * deserializer treats `params` as a required field and rejects a message that
 * omits it with `-32600 "missing field \`params\`"`. JSON-RPC 2.0 permits
 * omitting it, but this server does not — so methods like `thread/start`,
 * `model/list`, and `account/logout` (which take no arguments) still send `{}`.
 */
export function encodeRequest(req: JsonRpcRequest): string {
  const wire = { id: req.id, method: req.method, params: req.params ?? {} }
  return JSON.stringify(wire) + '\n'
}

/**
 * Encode a notification to its wire line (newline-terminated, no `id`). As with
 * requests, `params` is always present — the `initialized` handshake
 * notification must carry `params: {}` or the server rejects it.
 */
export function encodeNotification(note: JsonRpcNotification): string {
  const wire = { method: note.method, params: note.params ?? {} }
  return JSON.stringify(wire) + '\n'
}

/** True when a parsed message is a response: it carries a numeric `id`. */
export function isResponse(message: unknown): message is JsonRpcResponse {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return typeof m.id === 'number' && ('result' in m || 'error' in m)
}

/** True when a parsed message is a notification: it has `method` and no `id`. */
export function isNotification(message: unknown): message is JsonRpcNotification {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return typeof m.method === 'string' && m.id === undefined
}

/**
 * Classify a parsed wire value as a response or a notification, or undefined
 * when it is neither (e.g. a server-initiated request — which carries both an
 * `id` and a `method`; the App Server uses these for approval prompts that
 * app-server.ts handles separately, so they are intentionally not classified
 * here).
 */
export function classify(message: unknown): JsonRpcIncoming | undefined {
  if (isResponse(message)) return { kind: 'response', message }
  if (isNotification(message)) return { kind: 'notification', message }
  return undefined
}

/**
 * True when a parsed message is a server-initiated request: it carries BOTH an
 * `id` (so it expects a reply) and a `method` (so it is not a response). The
 * App Server uses these for approval prompts (item/commandExecution/
 * requestApproval, item/fileChange/requestApproval, tool/requestUserInput).
 */
export function isServerRequest(
  message: unknown
): message is { id: number; method: string; params?: unknown } {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return typeof m.id === 'number' && typeof m.method === 'string'
}
