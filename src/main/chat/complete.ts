import type { Provider, ChatTurn, StreamChunk, ToolSpec } from '@main/providers/types'
import type { ProvidersRepo } from '@main/repositories'
import type { SecretStore } from '@main/secrets'
import type { AgentToolset } from '@main/tools/types'
import { refreshXai, xaiTokensExpired, type XaiTokens } from '@main/oauth/xai'
import { WEB_TOOLS, runWebTool } from '@main/tools/web'

// Shared, non-streaming completion used outside the interactive chat path (the
// task worker, memory extraction). Resolves the bearer for a provider across all
// auth methods, then accumulates a streamed reply into a single string.

export interface BearerDeps {
  providers: ProvidersRepo
  secretStore: SecretStore
}

export type BearerResult = { apiKey: string } | { error: string }

/** Resolve the Authorization bearer for a provider kind (mirrors the chat handler). */
export async function resolveBearer(kind: string, deps: BearerDeps): Promise<BearerResult> {
  // Codex self-manages auth via the App Server; Ollama + opencode are keyless
  // local servers (opencode owns its own provider auth).
  if (kind === 'codex' || kind === 'ollama' || kind === 'opencode') return { apiKey: '' }

  const row = deps.providers.getByKind(kind)
  if (row?.auth_method === 'oauth') {
    const stored = row.secret_ref ? await deps.secretStore.get(row.secret_ref) : null
    if (!stored) return { error: 'Not connected — sign in for this provider in Settings.' }
    let tokens = JSON.parse(stored) as XaiTokens
    if (xaiTokensExpired(tokens)) {
      try {
        tokens = await refreshXai(tokens)
        if (row.secret_ref) await deps.secretStore.setWithId(row.secret_ref, JSON.stringify(tokens))
      } catch {
        return { error: 'Session expired — reconnect this provider in Settings.' }
      }
    }
    return { apiKey: tokens.accessToken }
  }

  const key = row?.secret_ref ? await deps.secretStore.get(row.secret_ref) : null
  if (!key) return { error: 'No API key configured for this provider.' }
  return { apiKey: key }
}

export interface TurnParams {
  apiKey: string
  model: string
  messages: ChatTurn[]
  signal?: AbortSignal
  /** When true, enable web access for this turn (native search or Sunny web tools). */
  webSearch?: boolean
  /** Agent fs/shell tools for this turn (from buildAgentToolset). When present and
   *  the provider supports function calling, the model can read/write files and run
   *  commands in its workspace, subject to the permission gate baked into the toolset. */
  agentTools?: AgentToolset
  /** Max model↔tool rounds for the tool loop (adapters default to 5). The worker
   *  passes a higher cap for unattended multi-step work. */
  maxToolRounds?: number
  /** Abort a stream that produces NO chunk for this long (a connected-but-stalled
   *  stream would otherwise sit until the caller's outer wall clock). On fire,
   *  `onIdleTimeout` is called — the caller aborts its controller, which the
   *  in-flight fetch/stream observes via `signal`. */
  idleTimeoutMs?: number
  onIdleTimeout?: () => void
  /** Receives the turn's token usage when the provider reports it (the worker
   *  writes it onto the run row for cost accounting). */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void
  /** Durable audit hook: fires after EVERY tool execution (fs/shell/board/MCP
   *  and Sunny's web tools) with what ran, a result preview, and timing — the
   *  callers persist it (activity log), so an unattended agent's actions are
   *  reviewable after the fact instead of evaporating with the status lines. */
  onToolEvent?: (e: {
    name: string
    args: string
    resultPreview: string
    ok: boolean
    durationMs: number
  }) => void
}

/** Cap a string for audit payloads (args/results can be huge). */
function preview(text: string, max = 400): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * Run one turn, choosing the execution path from what's requested + what the
 * provider supports:
 *   - agent tools requested (and/or web on a non-native provider) + function-calling
 *     provider → `streamWithTools` loop running Sunny's tools (fs/shell + web).
 *   - web on + native-web provider, no agent tools → `streamChat({ webSearch:true })`.
 *   - otherwise → plain `streamChat`.
 * Every provider implements `streamWithTools` now (chat/completions providers run
 * Sunny's web tools via the loop; OpenAI/Anthropic/Gemini run custom function tools
 * AND their own native web search together — `webSearch` is forwarded so they can
 * attach it). Single place this decision is made — shared by chat + the worker.
 */
export function streamTurn(provider: Provider, params: TurnParams): AsyncIterable<StreamChunk> {
  const agentTools = params.agentTools
  const agentSpecs = agentTools?.tools ?? []
  const wantsWeb = Boolean(params.webSearch)
  const nativeWeb = wantsWeb && Boolean(provider.supportsWebSearch)
  const webViaTools = wantsWeb && !provider.supportsWebSearch
  const useToolLoop = Boolean(provider.streamWithTools) && (agentSpecs.length > 0 || webViaTools)

  if (useToolLoop && provider.streamWithTools) {
    const tools: ToolSpec[] = [...agentSpecs]
    // Non-native providers get Sunny's own web tools in the function list; native
    // providers instead enable their built-in web search via the webSearch flag.
    if (webViaTools) tools.push(...WEB_TOOLS)
    return provider.streamWithTools({
      apiKey: params.apiKey,
      model: params.model,
      messages: params.messages,
      signal: params.signal,
      webSearch: nativeWeb,
      tools,
      maxToolRounds: params.maxToolRounds,
      runTool: async (call) => {
        const started = Date.now()
        const exec = (): Promise<string> => {
          if (call.name === 'web_search' || call.name === 'web_fetch') return runWebTool(call)
          if (agentTools) return agentTools.runTool(call)
          return Promise.resolve(`Tool "${call.name}" is not available.`)
        }
        try {
          const result = await exec()
          params.onToolEvent?.({
            name: call.name,
            args: preview(call.arguments),
            resultPreview: preview(result),
            ok: true,
            durationMs: Date.now() - started
          })
          return result
        } catch (err) {
          params.onToolEvent?.({
            name: call.name,
            args: preview(call.arguments),
            resultPreview: preview(err instanceof Error ? err.message : String(err)),
            ok: false,
            durationMs: Date.now() - started
          })
          throw err
        }
      }
    })
  }

  // No tool loop: native web when supported+requested, else a plain stream.
  return provider.streamChat({
    apiKey: params.apiKey,
    model: params.model,
    messages: params.messages,
    signal: params.signal,
    webSearch: nativeWeb
  })
}

/** Accumulate a turn's reply into one string (throws on error). Routes through
 *  `streamTurn`, so the worker gets web + agent tools for free, and ignores
 *  transient `status` chunks (tool-activity progress lines).
 *
 *  Inactivity watchdog: when `idleTimeoutMs` is set, a timer resets on EVERY
 *  chunk (deltas AND status lines — tool rounds emit status, so long tool work
 *  counts as liveness). If no chunk arrives in the window, `onIdleTimeout`
 *  fires so the caller can abort its controller — a connected-but-stalled
 *  stream then fails in ~idleTimeoutMs instead of pinning the serial worker
 *  for its full outer wall clock. */
export async function completeText(provider: Provider, params: TurnParams): Promise<string> {
  let out = ''
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    if (!params.idleTimeoutMs || !params.onIdleTimeout) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => params.onIdleTimeout?.(), params.idleTimeoutMs)
  }
  try {
    armIdle()
    for await (const chunk of streamTurn(provider, params)) {
      armIdle()
      if (chunk.type === 'delta') out += chunk.text
      else if (chunk.type === 'status') continue
      else if (chunk.type === 'usage')
        params.onUsage?.({
          promptTokens: chunk.promptTokens,
          completionTokens: chunk.completionTokens
        })
      else if (chunk.type === 'error') throw new Error(chunk.message)
      else break // 'done'
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
  return out
}
