// The uniform provider abstraction (spec §4). The UI selects a provider/model;
// the runtime resolves the credential from the keychain and calls `streamChat`,
// forwarding chunks to the renderer over IPC. Phase 2 ships the OpenAI adapter
// plus a fake (test-only) adapter behind this interface; later phases add
// Anthropic, Gemini, the OpenAI-compatible adapter, and the OAuth providers.
//
// Adapters are credential-agnostic: `streamChat`/`validateKey` receive the
// resolved `apiKey` as a parameter and never touch the keychain themselves, so
// they stay pure and unit-testable.

/** An image attached to a turn, sent to vision-capable providers. */
export interface ImagePart {
  /** MIME type, e.g. 'image/png'. */
  mediaType: string
  /** Self-contained data URL: `data:<mediaType>;base64,<data>`. */
  dataUrl: string
}

/** A single conversation turn handed to a provider. */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Images on this turn (user turns). Vision adapters render these as image
   *  parts; non-vision adapters ignore them. */
  images?: ImagePart[]
}

/** A tool the model may call, in the OpenAI function-calling shape. Used to give
 *  models Sunny's OWN tools (e.g. the keyless web search/fetch in tools/web.ts)
 *  when the provider has no native web search of its own. */
export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON-Schema for the tool's arguments. */
    parameters: Record<string, unknown>
  }
}

/** A tool invocation the model requested. `arguments` is a JSON string (the model
 *  emits it as text; the executor parses it). */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** Streamed output from a provider, normalized across adapters. A `status` chunk
 *  is transient progress (e.g. "searching the web") that the UI shows live but is
 *  NOT part of the saved answer — only `delta` text is accumulated. */
export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  /** Token usage for the turn (emitted once, before `done`, by adapters that
   *  report it). Tool-loop adapters accumulate across rounds. Consumers that
   *  don't care (the renderer transcript) simply ignore it. */
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string }

export interface StreamChatParams {
  apiKey: string
  model: string
  messages: ChatTurn[]
  /** Aborts the underlying HTTP request when the user cancels. */
  signal?: AbortSignal
  /** Enable the provider's built-in web search (native-web providers only). */
  webSearch?: boolean
}

/** Params for an agentic tool loop (OpenAI-style function calling). Extends a
 *  normal chat with the tools the model may call and an executor the loop runs
 *  whenever the model requests a tool. Used to give web search to providers that
 *  lack it natively (local Ollama, and chat/completions providers like Grok). */
export interface StreamWithToolsParams extends StreamChatParams {
  tools: ToolSpec[]
  /** Execute a tool the model requested; resolves to the tool's result text
   *  (which is fed back to the model as a tool message). */
  runTool(call: ToolCall): Promise<string>
  /** Max model↔tool rounds before tools are withheld to force a final answer.
   *  Adapters default to 5 (interactive chats); the autonomous worker passes a
   *  higher cap so multi-step unattended work isn't truncated mid-plan. */
  maxToolRounds?: number
}

export interface ModelInfo {
  id: string
  label: string
  contextWindow?: number
}

export interface KeyValidationResult {
  ok: boolean
  error?: string
}

/** A provider adapter. `kind` is the stable id stored on the `providers` row. */
export interface Provider {
  kind: string
  label: string
  defaultModel: string
  /** True when this provider answers with its OWN built-in web search (OpenAI
   *  Responses `web_search`, Gemini grounding, Anthropic `web_search`, Perplexity
   *  Sonar). When the web toggle is on, the runtime sets `webSearch: true` on
   *  `streamChat` for these. Providers WITHOUT this but WITH `streamWithTools`
   *  instead get Sunny's own web tools (see tools/web.ts). */
  supportsWebSearch?: boolean
  /** Static, known-good models for this provider (Phase 2 — no live listing). */
  listModels(): ModelInfo[]
  /** Optional: fetch the provider's LIVE model catalog (e.g. OpenRouter's 300+).
   *  When present, the IPC layer prefers this over `listModels()` once the
   *  provider is connected, falling back to the static list on any failure. The
   *  resolved apiKey is passed (may be '' for providers whose /models is public). */
  fetchModels?(apiKey: string): Promise<ModelInfo[]>
  /** Cheap auth check used when a key is saved in Settings (spec §4a). */
  validateKey(apiKey: string): Promise<KeyValidationResult>
  /** Stream a completion as normalized chunks. */
  streamChat(params: StreamChatParams): AsyncIterable<StreamChunk>
  /** Optional: run an OpenAI-style function-calling loop so the model can invoke
   *  Sunny-provided tools. Implemented by chat/completions providers (Ollama,
   *  OpenRouter, Groq, xAI Grok) — it's how a local model gets web access. The
   *  runtime prefers native `webSearch` when `supportsWebSearch` is set and only
   *  falls back to this for providers that lack native web. */
  streamWithTools?(params: StreamWithToolsParams): AsyncIterable<StreamChunk>
}
