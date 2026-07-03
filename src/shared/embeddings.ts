// Recommended embedding providers + models for the Memory embedding picker.
// Renderer-safe (no native/electron imports). The picker pairs this with the
// live provider connection state (which providers have a key / are reachable) to
// show only usable options. Providers marked `allowCustom` also accept a typed
// model id (e.g. any OpenRouter or Ollama embedding model).

export interface EmbeddingModelRec {
  id: string
  label: string
  /** Marked with a star in the picker as the suggested choice. */
  recommended?: boolean
}

export interface EmbeddingProviderRec {
  /** Provider kind, matches the chat provider kinds (openai | openrouter | ollama). */
  kind: string
  label: string
  /** One-line guidance shown under the provider (tradeoffs). */
  note?: string
  /** Whether the user may type a custom model id in addition to the listed ones. */
  allowCustom: boolean
  models: EmbeddingModelRec[]
}

export const EMBEDDING_PROVIDERS: EmbeddingProviderRec[] = [
  {
    kind: 'openai',
    label: 'OpenAI',
    note: 'Cloud — cheap, reliable, never touches your GPU.',
    allowCustom: false,
    models: [
      { id: 'text-embedding-3-small', label: 'text-embedding-3-small · 1536d', recommended: true },
      { id: 'text-embedding-3-large', label: 'text-embedding-3-large · 3072d' }
    ]
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    note: 'Cloud — one key, many embedding models (OpenAI-compatible).',
    allowCustom: true,
    models: [
      {
        id: 'openai/text-embedding-3-small',
        label: 'openai/text-embedding-3-small · 1536d',
        recommended: true
      },
      { id: 'openai/text-embedding-3-large', label: 'openai/text-embedding-3-large · 3072d' }
    ]
  },
  {
    kind: 'ollama',
    label: 'Ollama (local)',
    note: 'Local — shares your GPU with chat; can cause model swapping. Best with VRAM headroom or a dedicated/CPU Ollama.',
    allowCustom: true,
    models: [
      { id: 'nomic-embed-text', label: 'nomic-embed-text · 768d', recommended: true },
      { id: 'mxbai-embed-large', label: 'mxbai-embed-large · 1024d' }
    ]
  }
]
