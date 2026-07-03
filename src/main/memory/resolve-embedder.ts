import type { ProvidersRepo, SettingsRepo } from '@main/repositories'
import type { SecretStore } from '@main/secrets'
import { createOpenAiCompatibleEmbedder, EMBEDDING_DIM, type Embedder } from './embeddings'
import {
  createOllamaEmbedder,
  ollamaEmbedModels,
  ollamaReachable
} from '@main/providers'

// Resolve the active memory embedder from settings (structure of choice, not
// auto-magic). When the user has explicitly picked a provider+model, build that;
// otherwise fall back to the legacy auto chain (local Ollama embed model → the
// OpenAI key → off). Reused at startup AND when the picker changes it live, so
// both paths build the embedder identically.

const PROVIDER_SETTING = 'embedding_provider'
const MODEL_SETTING = 'embedding_model'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export interface ResolveEmbedderDeps {
  settings: SettingsRepo
  providers: ProvidersRepo
  secretStore: SecretStore
  /** The live Ollama base URL (already resolved from settings). */
  ollamaBaseUrl: string
}

export interface ResolvedEmbedder {
  embedder: Embedder
  available: boolean
  /** The probed embedding dimension (only meaningful when `available`). */
  dim: number
}

/** Probe an embedder for its dimension; null if it can't embed right now. */
async function probeDim(embedder: Embedder): Promise<number | null> {
  try {
    const [vec] = await embedder.embed(['dimension probe'])
    return vec && vec.length > 0 ? vec.length : null
  } catch {
    return null
  }
}

/** A fresh-key getter for an api_key provider (openai/openrouter). */
function keyGetter(kind: string, deps: ResolveEmbedderDeps): () => Promise<string | null> {
  return async () => {
    const row = deps.providers.getByKind(kind)
    if (!row || !row.secret_ref) return null
    return deps.secretStore.get(row.secret_ref)
  }
}

/**
 * Build the embedder for an explicit (provider, model) choice, or null if the
 * kind is unknown. `expectDim`, when given, makes the OpenAI-compatible embedder
 * self-check every returned vector's length — passed only for the ACTIVE
 * embedder (after the dim is probed), never during probing itself.
 */
function buildExplicit(
  kind: string,
  model: string,
  deps: ResolveEmbedderDeps,
  expectDim?: number
): Embedder | null {
  if (kind === 'openai') {
    return createOpenAiCompatibleEmbedder({
      provider: 'openai',
      baseUrl: OPENAI_BASE_URL,
      model,
      getKey: keyGetter('openai', deps),
      expectDim
    })
  }
  if (kind === 'openrouter') {
    const row = deps.providers.getByKind('openrouter')
    return createOpenAiCompatibleEmbedder({
      provider: 'openrouter',
      baseUrl: row?.base_url || OPENROUTER_BASE_URL,
      model,
      getKey: keyGetter('openrouter', deps),
      expectDim
    })
  }
  if (kind === 'ollama') {
    return createOllamaEmbedder(deps.ollamaBaseUrl, model)
  }
  return null
}

export async function resolveEmbedder(deps: ResolveEmbedderDeps): Promise<ResolvedEmbedder> {
  const chosenProvider = deps.settings.get(PROVIDER_SETTING)
  const chosenModel = deps.settings.get(MODEL_SETTING)

  // Explicit user choice — use it or report it unavailable (no silent fallback,
  // so the picker + status reflect exactly what the user selected).
  if (chosenProvider && chosenModel) {
    const probe = buildExplicit(chosenProvider, chosenModel, deps)
    if (probe) {
      const dim = await probeDim(probe)
      if (dim) {
        // Rebuild the ACTIVE embedder with the probed dim so a later dimension
        // drift throws a clear error instead of dying at the vec0 INSERT.
        const embedder = buildExplicit(chosenProvider, chosenModel, deps, dim) ?? probe
        return { embedder, available: true, dim }
      }
      return { embedder: probe, available: false, dim: 0 }
    }
  }

  // Auto (legacy default): local Ollama embed model, then the OpenAI key, else off.
  if (await ollamaReachable(deps.ollamaBaseUrl)) {
    const models = await ollamaEmbedModels(deps.ollamaBaseUrl)
    if (models.length > 0) {
      const model = models.find((m) => m.includes('nomic-embed-text')) ?? models[0]
      const embedder = createOllamaEmbedder(deps.ollamaBaseUrl, model)
      const dim = await probeDim(embedder)
      if (dim) return { embedder, available: true, dim }
    }
  }

  const openai = deps.providers.getByKind('openai')
  const openAiEmbedder = createOpenAiCompatibleEmbedder({
    provider: 'openai',
    baseUrl: OPENAI_BASE_URL,
    model: 'text-embedding-3-small',
    getKey: keyGetter('openai', deps),
    // text-embedding-3-small is fixed at 1536; self-check against it.
    expectDim: EMBEDDING_DIM
  })
  if (openai && openai.auth_method === 'api_key' && openai.secret_ref) {
    return { embedder: openAiEmbedder, available: true, dim: EMBEDDING_DIM }
  }

  // Nothing configured — capture + graph still work; semantic recall is off.
  return { embedder: openAiEmbedder, available: false, dim: 0 }
}
