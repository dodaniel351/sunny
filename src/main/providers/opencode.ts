// The opencode (local) provider. opencode (https://opencode.ai) runs a headless
// HTTP server (`opencode serve`, default http://localhost:4096) and OWNS its own
// auth — including a ChatGPT Plus/Pro subscription via `opencode auth login`. So
// Sunny treats it like Ollama: a keyless LOCAL provider configured by a base URL.
// Because it's a plain local HTTP call (no browser OAuth flow), it works
// UNATTENDED too — the board worker + scheduler can use a ChatGPT subscription
// through it, which Sunny's own Codex path can't do headless.
//
// Wire protocol (https://opencode.ai/docs/server, OpenAPI at {base}/doc):
//   - Models:   GET  {base}/provider → { all: Provider[], connected: string[], default }
//   - Session:  POST {base}/session  → { id, ... }
//   - Prompt:   POST {base}/session/:id/message (SYNCHRONOUS) with
//               { model:{providerID,modelID}, system?, parts:[{type:'text',text}] }
//               → { info: Message, parts: Part[] }  (assistant text is the
//               type:'text' parts).
//   - Liveness: GET {base}/session (cheap; 2xx when the server is up).
// Optional HTTP basic auth when OPENCODE_SERVER_PASSWORD is set (user 'opencode').
//
// Pure provider logic: no secret store / DB / electron imports. The base URL +
// optional password are injected as live getters so a Settings change applies
// without a restart.

import type {
  ChatTurn,
  KeyValidationResult,
  ModelInfo,
  Provider,
  StreamChatParams,
  StreamChunk
} from './types'

/** opencode serve's default loopback address; overridable in Settings. */
export const OPENCODE_DEFAULT_BASE_URL = 'http://localhost:4096'

const REACHABLE_TIMEOUT_MS = 3000
// A model call can take a while (it's a full agent turn); give it real headroom.
const MESSAGE_TIMEOUT_MS = 5 * 60_000
// Cache the (large) /provider catalog briefly so repeated provider-list calls
// don't re-download it from the local server.
const MODEL_CACHE_TTL_MS = 60_000

/** Strip a trailing slash so `${base}/path` never double-slashes. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** Basic-auth header when a server password is configured, else nothing. */
function authHeaders(password: string): Record<string, string> {
  if (!password) return {}
  const token = Buffer.from(`opencode:${password}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

/** A model in opencode's catalog: keyed by modelID under a provider's `models`. */
interface OpencodeModel {
  id?: string
  name?: string
}
interface OpencodeProviderEntry {
  id?: string
  name?: string
  models?: Record<string, OpencodeModel>
}
interface ProviderCatalog {
  all?: OpencodeProviderEntry[]
  connected?: string[]
}

/** The slice of a /session/:id/message response we read. */
interface MessageResponse {
  parts?: Array<{ type?: string; text?: string }>
}

const modelCache = new Map<string, { at: number; models: ModelInfo[] }>()

/**
 * Live model list from opencode, limited to CONNECTED providers (what the user
 * has actually authed). Each Sunny model id is `providerID/modelID` so the prompt
 * call can split it back into opencode's `{providerID, modelID}`. Cached briefly;
 * returns [] on any error so callers degrade quietly.
 */
export async function opencodeChatModels(baseUrl: string, password = ''): Promise<ModelInfo[]> {
  const root = normalizeBaseUrl(baseUrl)
  const cached = modelCache.get(root)
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.models
  try {
    const response = await fetch(`${root}/provider`, {
      method: 'GET',
      headers: authHeaders(password),
      signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS)
    })
    if (!response.ok) return []
    const json = (await response.json()) as ProviderCatalog
    const connected = new Set(Array.isArray(json.connected) ? json.connected : [])
    const all = Array.isArray(json.all) ? json.all : []
    const models: ModelInfo[] = []
    for (const provider of all) {
      const pid = provider.id
      // Only providers the user has actually authed. When the server reports
      // ZERO connected providers, that means none are usable — list nothing
      // (opencode then reads as reachable-but-no-models, the truth) rather than
      // falling through and dumping opencode's entire catalog.
      if (!pid || !connected.has(pid)) continue
      const entries = provider.models ? Object.values(provider.models) : []
      for (const m of entries) {
        if (!m.id) continue
        models.push({
          id: `${pid}/${m.id}`,
          label: `${provider.name ?? pid} · ${m.name ?? m.id}`
        })
      }
    }
    models.sort((a, b) => a.label.localeCompare(b.label))
    modelCache.set(root, { at: Date.now(), models })
    return models
  } catch {
    return []
  }
}

/** Liveness probe: a cheap GET that 2xxes when the server is up. */
export async function opencodeReachable(baseUrl: string, password = ''): Promise<boolean> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/session`, {
      method: 'GET',
      headers: authHeaders(password),
      signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS)
    })
    return response.ok
  } catch {
    return false
  }
}

/** Split a Sunny model id (`providerID/modelID`) into opencode's pair. The
 *  modelID itself may contain '/', so split on the FIRST separator only. */
function splitModel(model: string): { providerID: string; modelID: string } {
  const i = model.indexOf('/')
  if (i === -1) return { providerID: 'openai', modelID: model }
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
}

/** Build opencode's prompt input from Sunny turns: system turns → `system`, the
 *  rest → one text part (a labelled transcript, since Sunny owns the history and
 *  each call uses a fresh session). */
function toPrompt(messages: ChatTurn[]): { system?: string; text: string } {
  const systemParts: string[] = []
  const convo: string[] = []
  for (const turn of messages) {
    if (turn.role === 'system') {
      systemParts.push(turn.content)
    } else if (turn.role === 'assistant') {
      convo.push(`Assistant: ${turn.content}`)
    } else {
      convo.push(turn.content.length > 0 ? `User: ${turn.content}` : '')
    }
  }
  // A single user turn is sent verbatim; a multi-turn chat as a transcript.
  const nonSystem = messages.filter((m) => m.role !== 'system')
  const text =
    nonSystem.length === 1 && nonSystem[0].role === 'user'
      ? nonSystem[0].content
      : convo.filter(Boolean).join('\n\n')
  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  return system === undefined ? { text } : { system, text }
}

export class OpencodeProvider implements Provider {
  readonly kind = 'opencode'
  readonly label = 'opencode (local)'
  // Models are dynamic (whatever opencode has authed), like Ollama.
  readonly defaultModel = ''
  readonly #resolveBaseUrl: () => string
  readonly #resolvePassword: () => string

  constructor(baseUrl: string | (() => string), password?: string | (() => string)) {
    this.#resolveBaseUrl = typeof baseUrl === 'function' ? baseUrl : (): string => baseUrl
    const pw = password ?? ''
    this.#resolvePassword = typeof pw === 'function' ? pw : (): string => pw
  }

  private get baseUrl(): string {
    return normalizeBaseUrl(this.#resolveBaseUrl())
  }
  private get password(): string {
    return this.#resolvePassword()
  }

  /** Live listing is done by the registry/IPC via opencodeChatModels — not here. */
  listModels(): ModelInfo[] {
    return []
  }

  /** Keyless from Sunny's side (opencode owns auth) — nothing to validate. */
  async validateKey(): Promise<KeyValidationResult> {
    return { ok: true }
  }

  /**
   * Run one turn against opencode's SYNCHRONOUS message endpoint: open a session,
   * post the prompt, read the assistant text from the returned parts, and emit it
   * as a single `delta` + `done`. Never throws — failures surface as an `error`
   * chunk (with a hint to check that `opencode serve` is running).
   */
  async *streamChat(params: StreamChatParams): AsyncIterable<StreamChunk> {
    const { model, messages, signal } = params
    const headers = { 'content-type': 'application/json', ...authHeaders(this.password) }
    const base = this.baseUrl

    // 1) Open a session.
    let sessionId: string
    try {
      const res = await fetch(`${base}/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Sunny' }),
        signal
      })
      if (!res.ok) {
        yield { type: 'error', message: await this.readError(res) }
        return
      }
      const json = (await res.json()) as { id?: string }
      if (!json.id) {
        yield { type: 'error', message: 'opencode did not return a session id.' }
        return
      }
      sessionId = json.id
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      yield {
        type: 'error',
        message: `Could not reach opencode at ${base} (${detail}). Is \`opencode serve\` running?`
      }
      return
    }

    // 2) Send the prompt synchronously and read the assistant text.
    try {
      const { system, text } = toPrompt(messages)
      const body: Record<string, unknown> = {
        model: splitModel(model),
        parts: [{ type: 'text', text }]
      }
      if (system) body.system = system

      const res = await fetch(`${base}/session/${sessionId}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(MESSAGE_TIMEOUT_MS)
      })
      if (!res.ok) {
        yield { type: 'error', message: await this.readError(res) }
        return
      }
      const json = (await res.json()) as MessageResponse
      const out = (json.parts ?? [])
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('')
      if (out) yield { type: 'delta', text: out }
      yield { type: 'done', finishReason: 'stop' }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  private async readError(response: Response): Promise<string> {
    let detail = `${response.status} ${response.statusText}`
    try {
      const text = await response.text()
      if (text.trim() !== '') detail = text.trim().slice(0, 300)
    } catch {
      // keep the status line
    }
    return `opencode request failed: ${detail}`
  }
}
