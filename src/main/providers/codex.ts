// OpenAI Codex provider (ChatGPT-subscription OAuth, no API key) for Phase 4.
//
// Unlike the HTTP providers, this adapter does NOT call fetch with an apiKey —
// it drives the official `codex app-server` process over JSON-RPC (see
// ../codex/app-server.ts). Auth is via a ChatGPT login the App Server persists
// and refreshes itself; the `apiKey` param of the Provider interface is unused.
//
// The interface (types.ts) is otherwise honored exactly: `streamChat` yields
// normalized `delta`/`done`/`error` chunks and never throws to the caller.
//
// A single shared CodexAppServer is used per process so login state and the
// cached thread are reused across the IPC layer (Settings login/logout) and
// chat turns. The Settings layer can drive login/logout and read connection
// state via the exported `loginCodex` / `codexStatus` / `logoutCodex` helpers.

import type {
  KeyValidationResult,
  ModelInfo,
  Provider,
  StreamChatParams,
  StreamChunk,
  ChatTurn
} from './types'
import { CodexAppServer, type CodexLoginOptions, type CodexAccount } from '../codex/app-server'

export type { CodexAccount } from '../codex/app-server'

/**
 * Static fallback models. The real list comes from the App Server at runtime
 * (`model/list`) and is plan-dependent; these are reasonable Codex-supported
 * ids to seed the UI before/if a live list is unavailable.
 */
// Static fallback used only until the live `model/list` from the App Server is
// available (the real, plan-dependent set is fetched when signed in). Default is
// the small/cheap tier, which is broadly available on a ChatGPT subscription —
// gpt-5.5 isn't usable on every plan, so it must not be the default.
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
]

const DEFAULT_MODEL = 'gpt-5.4-mini'

/**
 * Process-wide singleton App Server. Lazily created; shared so a login from
 * Settings is visible to chat turns and vice-versa.
 */
let sharedServer: CodexAppServer | null = null
function getServer(): CodexAppServer {
  if (!sharedServer) sharedServer = new CodexAppServer()
  return sharedServer
}

export interface CodexRuntimeServer {
  readonly isStarted: boolean
  start(): Promise<void>
  readAccount(opts?: { refreshToken?: boolean }): Promise<CodexAccount | null>
  login(opts: CodexLoginOptions): Promise<void>
}

export interface CodexRuntime {
  isCliAvailable(): Promise<boolean>
  server: CodexRuntimeServer
}

function defaultRuntime(): CodexRuntime {
  return {
    isCliAvailable: () => CodexAppServer.isCliAvailable(),
    server: getServer()
  }
}

/**
 * Flatten chat turns into a single prompt string. Codex `turn/start` input is
 * text, so prior turns are included as labeled context. (System turns become a
 * leading instruction block; user/assistant turns are labeled so the model can
 * follow the exchange.)
 */
function flattenMessages(messages: ChatTurn[]): string {
  const parts: string[] = []
  for (const turn of messages) {
    if (turn.role === 'system') parts.push(turn.content)
    else if (turn.role === 'user') parts.push(`User: ${turn.content}`)
    else parts.push(`Assistant: ${turn.content}`)
  }
  return parts.join('\n\n')
}

export class CodexProvider implements Provider {
  readonly kind = 'codex'
  readonly label = 'OpenAI Codex (ChatGPT)'
  readonly defaultModel = DEFAULT_MODEL

  /** Static fallback; the live list comes from the App Server (`model/list`). */
  listModels(): ModelInfo[] {
    return [...FALLBACK_MODELS]
  }

  /**
   * Not used for Codex — auth is via ChatGPT login, not a saved key. Returns ok
   * so the Settings save flow does not reject a (blank) key for this provider.
   */
  async validateKey(): Promise<KeyValidationResult> {
    return { ok: true }
  }

  /**
   * Stream a completion as normalized chunks. Lazily ensures the App Server is
   * started and signed in; if not signed in, yields a single `error` chunk that
   * points the user at Settings. Never throws — failures surface as `error`.
   */
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamChunk> {
    // apiKey is intentionally ignored (Codex auth is OAuth via login).
    const { model, messages, signal } = params
    const server = getServer()

    // 1. Ensure the App Server is up (CLI must be installed).
    try {
      if (!server.isStarted) await server.start()
    } catch (err) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err)
      }
      return
    }

    // 2. Ensure we are signed in to ChatGPT.
    const account = await server.readAccount({ refreshToken: true })
    if (!account) {
      yield {
        type: 'error',
        message: 'Not signed in to ChatGPT — connect Codex in Settings.'
      }
      return
    }

    // 3. Run the turn, forwarding deltas.
    const text = flattenMessages(messages)
    try {
      const queue = new DeltaQueue()
      const turn = server
        .streamTurn({
          model: model || this.defaultModel,
          text,
          onDelta: (t) => queue.push(t),
          ...(signal ? { signal } : {})
        })
        .then(
          () => queue.close(),
          (err: unknown) => queue.fail(err instanceof Error ? err : new Error(String(err)))
        )

      for await (const delta of queue) {
        yield { type: 'delta', text: delta }
      }
      await turn
      yield { type: 'done', finishReason: 'stop' }
    } catch (err) {
      // Includes AbortError when `signal` fires mid-turn — surface uniformly.
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}

/**
 * An async queue bridging the callback-style `onDelta` of streamTurn into the
 * async-generator `streamChat`. Deltas pushed before the consumer pulls are
 * buffered; the consumer awaits when the buffer is empty.
 */
class DeltaQueue implements AsyncIterable<string> {
  private buffer: string[] = []
  private resolveNext: ((r: IteratorResult<string>) => void) | null = null
  private rejectNext: ((err: Error) => void) | null = null
  private closed = false
  private error: Error | null = null

  push(text: string): void {
    if (this.closed) return
    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = null
      this.rejectNext = null
      resolve({ value: text, done: false })
    } else {
      this.buffer.push(text)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolveNext) {
      const resolve = this.resolveNext
      this.resolveNext = null
      this.rejectNext = null
      resolve({ value: undefined, done: true })
    }
  }

  fail(err: Error): void {
    this.error = err
    this.closed = true
    if (this.rejectNext) {
      const reject = this.rejectNext
      this.resolveNext = null
      this.rejectNext = null
      reject(err)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as string, done: false })
        }
        if (this.error) return Promise.reject(this.error)
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<string>>((resolve, reject) => {
          this.resolveNext = resolve
          this.rejectNext = reject
        })
      }
    }
  }
}

// ── IPC convenience surface (Settings drives login/logout + status) ──────────

export interface CodexStatus {
  /** Whether the `codex` CLI is installed/on PATH. */
  cliAvailable: boolean
  /** Whether a ChatGPT account is currently signed in. */
  signedIn: boolean
  /** The signed-in account details (email/plan), if available. */
  account: CodexAccount | null
}

/** Options for the IPC-facing login helper (forwarded to CodexAppServer.login). */
export type LoginCodexOptions = CodexLoginOptions

/**
 * Start (if needed) and drive a ChatGPT login. Throws a clear error if the CLI
 * is missing so Settings can prompt the user to install it.
 */
export async function loginCodex(opts: LoginCodexOptions): Promise<CodexStatus> {
  return loginCodexWithRuntime(opts, defaultRuntime())
}

export async function loginCodexWithRuntime(
  opts: LoginCodexOptions,
  runtime: CodexRuntime
): Promise<CodexStatus> {
  if (!(await runtime.isCliAvailable())) {
    throw new Error('Codex CLI not found — install it and ensure `codex` is on your PATH.')
  }
  const server = runtime.server
  if (!server.isStarted) await server.start()

  const existing = await server.readAccount({ refreshToken: true })
  if (existing) return { cliAvailable: true, signedIn: true, account: existing }

  await server.login(opts)
  const account = await server.readAccount({ refreshToken: true })
  return { cliAvailable: true, signedIn: account !== null, account }
}

/** Log out the persisted ChatGPT session. */
export async function logoutCodex(): Promise<CodexStatus> {
  const server = getServer()
  if (server.isStarted) await server.logout()
  return codexStatus()
}

/**
 * Report connection state for Settings: CLI availability + sign-in status.
 * Starts the App Server when the CLI is available so a cached Codex CLI
 * ChatGPT session is reflected in Sunny after app restart.
 */
export async function codexStatus(): Promise<CodexStatus> {
  return codexStatusWithRuntime(defaultRuntime())
}

export async function codexStatusWithRuntime(runtime: CodexRuntime): Promise<CodexStatus> {
  const cliAvailable = await runtime.isCliAvailable()
  if (!cliAvailable) {
    return { cliAvailable, signedIn: false, account: null }
  }
  const server = runtime.server
  try {
    if (!server.isStarted) await server.start()
  } catch {
    return { cliAvailable, signedIn: false, account: null }
  }
  const account = await server.readAccount({ refreshToken: true })
  return { cliAvailable, signedIn: account !== null, account }
}

/** List models live from the App Server, falling back to the static list. */
export async function listCodexModels(): Promise<ModelInfo[]> {
  const server = getServer()
  try {
    if (!server.isStarted) await server.start()
    const models = await server.listModels()
    if (models.length > 0) return models.map((m) => ({ id: m.id, label: m.label ?? m.id }))
  } catch {
    // Fall through to the static fallback below.
  }
  return [...FALLBACK_MODELS]
}

/** Tear down the shared App Server (e.g. on app quit). */
export function disposeCodex(): void {
  if (sharedServer) {
    sharedServer.dispose()
    sharedServer = null
  }
}
