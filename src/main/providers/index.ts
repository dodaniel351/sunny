// Provider registry: the single place the runtime resolves a `kind` (stored on
// a `providers` row) to its adapter. Phase 2 ships OpenAI; the FakeProvider is
// opt-in so it never appears in production but is available to tests and dev.

import type { Provider } from './types'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import {
  createOpenRouterProvider,
  createGroqProvider,
  createPerplexityProvider
} from './openai-compatible'
import { createXaiProvider } from './xai'
import { CodexProvider } from './codex'
import { OllamaProvider, OLLAMA_DEFAULT_BASE_URL } from './ollama'
import { OpencodeProvider, OPENCODE_DEFAULT_BASE_URL } from './opencode'
import { FakeProvider } from './fake'

export type { Provider } from './types'
export { OpenAIProvider } from './openai'
export { AnthropicProvider } from './anthropic'
export { GeminiProvider } from './gemini'
export {
  OpenAICompatibleProvider,
  createOpenRouterProvider,
  createGroqProvider,
  createPerplexityProvider
} from './openai-compatible'
export { createXaiProvider } from './xai'
export { CodexProvider } from './codex'
export {
  OllamaProvider,
  OLLAMA_DEFAULT_BASE_URL,
  ollamaReachable,
  ollamaChatModels,
  ollamaEmbedModels,
  createOllamaEmbedder
} from './ollama'
export {
  OpencodeProvider,
  OPENCODE_DEFAULT_BASE_URL,
  opencodeReachable,
  opencodeChatModels
} from './opencode'
export { FakeProvider } from './fake'

export interface ProviderRegistry {
  /** Resolve an adapter by its stable `kind`, or undefined if unregistered. */
  get(kind: string): Provider | undefined
  /** All registered adapters, in registration order. */
  list(): Provider[]
}

export interface CreateProviderRegistryOptions {
  /** Include the network-free FakeProvider (tests / offline dev). Default false. */
  includeFake?: boolean
  /** Base URL for the local Ollama daemon (default http://localhost:11434).
   *  Pass a getter to resolve it live (so a Settings change applies without a
   *  restart) — the chat path reads it on each call. */
  ollamaBaseUrl?: string | (() => string)
  /** Base URL for the local opencode server (default http://localhost:4096), and
   *  an optional server password — both live getters, like ollamaBaseUrl. */
  opencodeBaseUrl?: string | (() => string)
  opencodePassword?: string | (() => string)
}

/**
 * Build the registry. OpenAIProvider is always present; FakeProvider is added
 * only when `includeFake` is set, keeping the test double out of production.
 */
export function createProviderRegistry(opts: CreateProviderRegistryOptions = {}): ProviderRegistry {
  // Phase 3 key providers (spec §4a) + Phase 4 OAuth providers (spec §4b/§4c):
  // xAI Grok (OAuth subscription OR API key) and OpenAI Codex (ChatGPT OAuth).
  const providers: Provider[] = [
    new OpenAIProvider(),
    new AnthropicProvider(),
    new GeminiProvider(),
    createOpenRouterProvider(),
    createGroqProvider(),
    createPerplexityProvider(),
    createXaiProvider(),
    new CodexProvider(),
    new OllamaProvider(opts.ollamaBaseUrl ?? OLLAMA_DEFAULT_BASE_URL),
    new OpencodeProvider(opts.opencodeBaseUrl ?? OPENCODE_DEFAULT_BASE_URL, opts.opencodePassword)
  ]
  if (opts.includeFake) providers.push(new FakeProvider())

  const byKind = new Map<string, Provider>(providers.map((p) => [p.kind, p]))

  return {
    get(kind: string): Provider | undefined {
      return byKind.get(kind)
    },
    list(): Provider[] {
      return [...providers]
    }
  }
}
