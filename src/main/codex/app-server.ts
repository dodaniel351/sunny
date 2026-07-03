// JSON-RPC client over a spawned `codex app-server` process.
//
// This module owns the child process and stdio; the wire framing/encoding is
// delegated to the pure ./jsonrpc codec so it stays unit-testable. We never log
// tokens or auth payloads here.
//
// ── Protocol, per developers.openai.com/codex (App Server) ──
// `codex app-server` is a subcommand of the Codex CLI (must be installed). It
// speaks JSON-RPC 2.0 over stdio as newline-delimited JSON (envelope field
// omitted on the wire — see ./jsonrpc).
//
// Handshake (required before any other call):
//   1. request  `initialize` { clientInfo: { name, title, version } }
//   2. notify   `initialized`
//
// Auth (server methods / notifications):
//   - `account/login/start` { type: 'chatgpt' }          → { authUrl, loginId }
//   - `account/login/start` { type: 'chatgptDeviceCode' } → { verificationUrl, userCode, loginId }
//   - `account/logout`
//   - `account/read` { refreshToken?: bool }              → { account: { type, email?, planType? } }
//   - notify (server→client): `account/login/completed` { loginId, success, error? }
//     also `account/updated`, `account/rateLimits/updated`
//   In `chatgpt` mode the App Server persists + refreshes tokens itself.
//
// Chat (shapes verified against codex-cli 0.137.0):
//   - `model/list`                                        → { data: [{ id, displayName, hidden }] }
//   - `thread/start`                                      → { thread: { id } }
//   - `turn/start` { threadId, model, input: [{ type:'text', text }] }
//   - notify (server→client): `item/agentMessage/delta` { delta } (streamed text),
//     `turn/started`, `turn/completed` { turn: { status } }
//   - `turn/interrupt` { threadId }
//
// Approval requests (server→client REQUESTS, carry an id): for a chat-only app
// we auto-reply decline/cancel so they never block:
//   - `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`
//     → reply { decision: 'denied' }   (best-effort; see NOTE below)
//   - `tool/requestUserInput` → reply { cancelled: true }
// NOTE: the exact approval RESPONSE shape is not nailed down in the public
// docs; we reply with a decline-shaped result and, if that is wrong, the worst
// case is the server ignores it — a chat-only turn never issues these anyway.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  NdjsonFramer,
  IdGenerator,
  encodeRequest,
  encodeNotification,
  classify,
  isServerRequest,
  type JsonRpcError
} from './jsonrpc'

/** The `codex` CLI binary name (resolved via PATH). */
const CODEX_BIN = 'codex'

// On Windows an npm-installed `codex` is a `codex.cmd` shim, which child_process
// `spawn` won't resolve without going through the shell. Use shell:true on win32
// so detection + launch find the CLI; the args are static and shell-safe.
const SPAWN_VIA_SHELL = process.platform === 'win32'

/** clientInfo we present in the `initialize` handshake. */
const CLIENT_INFO = { name: 'sunny', title: 'Sunny', version: '0.1.0' } as const

/** Login flow selector mirroring `account/login/start` params.type. */
export type CodexLoginType = 'chatgpt' | 'chatgptDeviceCode'

/** The `account` object returned by `account/read`. */
export interface CodexAccount {
  type?: string
  email?: string
  planType?: string
}

/** A model entry from `model/list` (kept loose — backend list is plan-dependent). */
export interface CodexModel {
  id: string
  label?: string
}

/** Device-code details surfaced to the UI for the `chatgptDeviceCode` flow. */
export interface CodexDeviceCode {
  verificationUrl: string
  userCode: string
}

export interface CodexLoginOptions {
  type: CodexLoginType
  /** Opens the browser auth URL (injected so this module stays Electron-free). */
  openUrl: (url: string) => void
  /** Called with device-code details for the `chatgptDeviceCode` flow. */
  onDeviceCode?: (code: CodexDeviceCode) => void
}

export interface StreamTurnOptions {
  model: string
  text: string
  onDelta: (text: string) => void
  signal?: AbortSignal
}

/** A notification listener; receives the raw params for a given method. */
type NotificationListener = (params: unknown) => void

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

/** Shape of a `turn/completed` notification's params we care about. 0.137.0
 *  nests the status under `turn.status`; older builds put it at the top level. */
interface TurnCompletedParams {
  status?: 'completed' | 'interrupted' | 'failed'
  threadId?: string
  turn?: { status?: string }
}

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly framer = new NdjsonFramer()
  private readonly ids = new IdGenerator()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Map<string, Set<NotificationListener>>()
  private startPromise: Promise<void> | null = null
  // A cached thread reused across turns for conversational context.
  private threadId: string | null = null
  // A terminal failure (process died, stdout closed) recorded so in-flight and
  // future requests reject with a clear cause instead of hanging.
  private fatal: Error | null = null

  /**
   * Detect the `codex` CLI by spawning `codex --version`. Resolves false on
   * ENOENT (not installed / not on PATH) or a non-zero exit, true on success.
   */
  static isCliAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      try {
        const probe = spawn(CODEX_BIN, ['--version'], { stdio: 'ignore', shell: SPAWN_VIA_SHELL })
        probe.on('error', () => done(false)) // ENOENT etc.
        probe.on('exit', (code) => done(code === 0))
      } catch {
        done(false)
      }
    })
  }

  /** True once start() has spawned the process and completed the handshake. */
  get isStarted(): boolean {
    return this.child !== null && this.fatal === null
  }

  /**
   * Spawn `codex app-server`, wire stdout through the framer, and run the
   * initialize/initialized handshake. Idempotent: concurrent/repeat calls share
   * one start. Rejects clearly if the CLI is missing so callers can prompt the
   * user to install it.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart().catch((err) => {
      // Allow a later retry after a failed start.
      this.startPromise = null
      throw err
    })
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    const child = await this.spawnProcess()
    this.child = child
    this.fatal = null

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stdout.on('end', () => this.failAll(new Error('codex app-server stdout closed')))
    // stderr is captured for diagnostics but never logged verbatim (may echo
    // sensitive content); we keep only the last lines for an error message.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.recordStderr(chunk))
    child.on('error', (err) => this.failAll(err))
    child.on('exit', (code, sig) =>
      this.failAll(
        new Error(`codex app-server exited (code=${code ?? 'null'} signal=${sig ?? 'null'})`)
      )
    )

    // Handshake: initialize → initialized. (App Server requires this first.)
    await this.request('initialize', { clientInfo: CLIENT_INFO })
    this.notify('initialized')
  }

  private spawnProcess(): Promise<ChildProcessWithoutNullStreams> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(CODEX_BIN, ['app-server'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: SPAWN_VIA_SHELL
        })
      } catch (err) {
        reject(toCliError(err))
        return
      }
      let settled = false
      child.once('spawn', () => {
        if (settled) return
        settled = true
        resolve(child)
      })
      child.once('error', (err) => {
        if (settled) return
        settled = true
        reject(toCliError(err))
      })
    })
  }

  private stderrTail = ''
  private recordStderr(chunk: string): void {
    // Keep a bounded tail only — never the whole stream, never logged here.
    this.stderrTail = (this.stderrTail + chunk).slice(-2000)
  }

  /** Tear down: kill the process and reject anything still pending. */
  dispose(): void {
    const child = this.child
    this.child = null
    this.startPromise = null
    this.threadId = null
    this.failAll(new Error('CodexAppServer disposed'))
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // Best effort — the process may already be gone.
      }
    }
  }

  /** Send a request and resolve with its `result` (rejects on JSON-RPC error). */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.fatal) return Promise.reject(this.fatal)
    const child = this.child
    if (!child) return Promise.reject(new Error('CodexAppServer not started'))

    const id = this.ids.take()
    const line = encodeRequest(params === undefined ? { id, method } : { id, method, params })

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  /** Send a fire-and-forget notification. */
  notify(method: string, params?: unknown): void {
    const child = this.child
    if (!child) return
    const line = encodeNotification(params === undefined ? { method } : { method, params })
    child.stdin.write(line)
  }

  /** Subscribe to a server→client notification method. Returns an unsubscribe. */
  on(method: string, listener: NotificationListener): () => void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  /**
   * Drive `account/login/start`. For `chatgpt`, open the returned `authUrl`;
   * for `chatgptDeviceCode`, surface `verificationUrl`+`userCode`. Resolves when
   * the `account/login/completed` notification arrives (rejects on success:false).
   */
  async login(opts: CodexLoginOptions): Promise<void> {
    const started = (await this.request('account/login/start', { type: opts.type })) as {
      authUrl?: string
      loginId?: string | number
      verificationUrl?: string
      userCode?: string
    }

    if (opts.type === 'chatgpt') {
      if (started.authUrl) opts.openUrl(started.authUrl)
    } else if (started.verificationUrl && started.userCode) {
      opts.onDeviceCode?.({ verificationUrl: started.verificationUrl, userCode: started.userCode })
    }

    const expectedLoginId = started.loginId

    // Wait for the completion notification matching this loginId.
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = this.on('account/login/completed', (params) => {
        const p = (params ?? {}) as {
          loginId?: string | number
          success?: boolean
          error?: string
        }
        // If the server scopes by loginId, only react to our own login.
        if (
          expectedLoginId !== undefined &&
          p.loginId !== undefined &&
          p.loginId !== expectedLoginId
        ) {
          return
        }
        unsubscribe()
        if (p.success === false) {
          reject(new Error(p.error || 'ChatGPT login failed'))
        } else {
          resolve()
        }
      })
    })
  }

  /** Read the current account, or null if not signed in. */
  async readAccount(opts: { refreshToken?: boolean } = {}): Promise<CodexAccount | null> {
    try {
      const res = (await this.request('account/read', {
        refreshToken: opts.refreshToken ?? false
      })) as {
        account?: CodexAccount | null
      }
      return res.account ?? null
    } catch {
      // A not-signed-in state may surface as an error rather than null account.
      return null
    }
  }

  /** Log out the persisted ChatGPT session. */
  async logout(): Promise<void> {
    await this.request('account/logout')
    this.threadId = null
  }

  /** List models the backend exposes (plan-dependent). */
  async listModels(): Promise<CodexModel[]> {
    // codex-cli 0.137.0 returns { data: [{ id, displayName, hidden, … }] };
    // tolerate the older { models: [...] } and a bare array too.
    type RawModel = {
      id?: string
      label?: string
      name?: string
      displayName?: string
      hidden?: boolean
    }
    const res = (await this.request('model/list')) as
      | { data?: RawModel[]; models?: RawModel[] }
      | RawModel[]
    const raw = Array.isArray(res) ? res : (res.data ?? res.models ?? [])
    return raw
      .filter((m): m is RawModel & { id: string } => typeof m.id === 'string' && m.hidden !== true)
      .map((m) => ({ id: m.id, label: m.displayName ?? m.label ?? m.name ?? m.id }))
  }

  // ── Chat ────────────────────────────────────────────────────────────────

  /**
   * Run one turn: ensure a thread (cached/reused), send `turn/start`, forward
   * `item/agentMessage/delta` text to `onDelta`, and resolve on `turn/completed`.
   * Auto-declines any approval requests so they never block a chat-only turn.
   * Respects `signal` via `turn/interrupt`.
   */
  async streamTurn(opts: StreamTurnOptions): Promise<void> {
    const threadId = await this.ensureThread()

    if (opts.signal?.aborted) {
      throw abortError()
    }

    return new Promise<void>((resolve, reject) => {
      const cleanups: Array<() => void> = []
      let finished = false
      const finish = (err?: Error): void => {
        if (finished) return
        finished = true
        for (const c of cleanups) c()
        if (err) reject(err)
        else resolve()
      }

      // The App Server emits an `error` notification when a turn fails (e.g. a
      // backend 401). Capture it so the failure carries a real, actionable reason
      // instead of a generic "turn failed".
      let turnError: string | null = null
      cleanups.push(
        this.on('error', (params) => {
          const msg = extractErrorText(params)
          if (msg) turnError = msg
        })
      )

      // Stream text deltas. (Server→client notification: item/agentMessage/delta.)
      cleanups.push(
        this.on('item/agentMessage/delta', (params) => {
          const text = extractDeltaText(params)
          if (text) opts.onDelta(text)
        })
      )

      // Terminal: turn/completed { turn: { status } }.
      cleanups.push(
        this.on('turn/completed', (params) => {
          const p = (params ?? {}) as TurnCompletedParams
          if (p.threadId !== undefined && p.threadId !== threadId) return
          const status = p.turn?.status ?? p.status
          if (status === 'failed') finish(new Error(this.turnFailureMessage(turnError)))
          else finish() // 'completed' or 'interrupted'
        })
      )

      // Abort → turn/interrupt, then settle.
      if (opts.signal) {
        const onAbort = (): void => {
          this.notify('turn/interrupt', { threadId })
          finish(abortError())
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
        cleanups.push(() => opts.signal?.removeEventListener('abort', onAbort))
      }

      // turn/start { threadId, input:[{type:'text',text}], model }.
      this.request('turn/start', {
        threadId,
        model: opts.model,
        input: [{ type: 'text', text: opts.text }]
      }).catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))))
    })
  }

  /** Reset the cached thread so the next turn starts a fresh conversation. */
  resetThread(): void {
    this.threadId = null
  }

  /**
   * Build an actionable message for a failed turn. The App Server logs the real
   * cause to stderr (which we keep a bounded tail of); a 401/token-refresh
   * failure means the ChatGPT sign-in expired, so point the user at re-login.
   */
  private turnFailureMessage(turnError: string | null): string {
    if (/\b401\b|unauthorized|refresh token|failed to refresh/i.test(this.stderrTail)) {
      return (
        'Codex turn failed: the Codex CLI could not authorize to the ChatGPT backend (401). ' +
        'Try `codex login`. If a plain `codex exec "hi"` works in a terminal but this does not, ' +
        'it is a Codex app-server issue (not Sunny) — use an OpenAI API key in Settings instead.'
      )
    }
    if (turnError) return `Codex turn failed: ${turnError}`
    return 'Codex turn failed.'
  }

  private async ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId
    // codex-cli 0.137.0 returns { thread: { id } }; older builds used { threadId }.
    const res = (await this.request('thread/start')) as {
      thread?: { id?: string }
      threadId?: string
    }
    const id = res.thread?.id ?? res.threadId
    if (!id) throw new Error('codex thread/start returned no thread id')
    this.threadId = id
    return this.threadId
  }

  // ── Wire plumbing ─────────────────────────────────────────────────────────

  private onStdout(chunk: string): void {
    for (const value of this.framer.push(chunk)) this.dispatch(value)
  }

  private dispatch(value: unknown): void {
    // A server→client REQUEST (has both id and method) — approval prompts etc.
    // Auto-decline so a chat-only app is never blocked. Checked before classify
    // because such messages also satisfy the response-id test.
    if (isServerRequest(value)) {
      this.autoDeclineServerRequest(value)
      return
    }

    const incoming = classify(value)
    if (!incoming) return

    if (incoming.kind === 'response') {
      const { id, result, error } = incoming.message
      const waiter = this.pending.get(id)
      if (!waiter) return
      this.pending.delete(id)
      if (error) waiter.reject(toJsonRpcError(error))
      else waiter.resolve(result)
      return
    }

    // Notification: fan out to subscribers of this method.
    const set = this.listeners.get(incoming.message.method)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(incoming.message.params)
      } catch {
        // A listener throwing must not break dispatch for the rest.
      }
    }
  }

  /**
   * Reply to a server-initiated approval/input request with a decline so a
   * chat-only turn is never blocked. The decline RESPONSE shape is not firmly
   * documented (see header NOTE) — we send a denied/cancelled-shaped result.
   */
  private autoDeclineServerRequest(req: { id: number; method: string }): void {
    const child = this.child
    if (!child) return
    let result: unknown
    switch (req.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        result = { decision: 'denied' }
        break
      case 'item/tool/requestUserInput':
      case 'tool/requestUserInput':
        result = { cancelled: true }
        break
      case 'item/permissions/requestApproval':
      case 'applyPatchApproval':
      case 'execCommandApproval':
        result = { decision: 'denied' }
        break
      case 'account/chatgptAuthTokens/refresh':
        child.stdin.write(
          JSON.stringify({
            id: req.id,
            error: {
              code: -32000,
              message:
                'Sunny does not manage Codex ChatGPT tokens; sign in through the Codex CLI/App Server.'
            }
          }) + '\n'
        )
        return
      default:
        result = { decision: 'denied' }
        break
    }
    child.stdin.write(JSON.stringify({ id: req.id, result }) + '\n')
  }

  private failAll(err: Error): void {
    if (this.fatal) return
    this.fatal = err
    for (const [, waiter] of this.pending) waiter.reject(err)
    this.pending.clear()
  }
}

// ── Helpers (pure) ──────────────────────────────────────────────────────────

/** Map the App Server `item/agentMessage/delta` params to its text payload. */
function extractDeltaText(params: unknown): string {
  if (typeof params === 'string') return params
  if (typeof params !== 'object' || params === null) return ''
  const p = params as { delta?: unknown; text?: unknown }
  if (typeof p.delta === 'string') return p.delta
  if (typeof p.text === 'string') return p.text
  return ''
}

/** Pull a human-readable message out of an `error` notification's params. */
function extractErrorText(params: unknown): string {
  if (typeof params === 'string') return params
  if (typeof params !== 'object' || params === null) return ''
  const p = params as { message?: unknown; error?: unknown; reason?: unknown }
  if (typeof p.message === 'string') return p.message
  if (typeof p.error === 'string') return p.error
  if (typeof p.error === 'object' && p.error !== null) {
    const nested = p.error as { message?: unknown; reason?: unknown; additionalDetails?: unknown }
    if (typeof nested.message === 'string') return nested.message
    if (typeof nested.reason === 'string') return nested.reason
    if (typeof nested.additionalDetails === 'string') return nested.additionalDetails
  }
  if (typeof p.reason === 'string') return p.reason
  return ''
}

function toJsonRpcError(error: JsonRpcError): Error {
  const code = error.code !== undefined ? ` (code ${error.code})` : ''
  return new Error(`${error.message}${code}`)
}

function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

/** Turn a spawn failure into a clear, actionable error (ENOENT = CLI missing). */
function toCliError(err: unknown): Error {
  if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') {
    return new Error('Codex CLI not found — install it and ensure `codex` is on your PATH.')
  }
  return err instanceof Error ? err : new Error(String(err))
}
