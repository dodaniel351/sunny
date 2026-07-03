// xAI Grok provider (Phase 4).
//
// The xAI inference API is OpenAI-compatible at https://api.x.ai/v1 — same
// /chat/completions streaming shape, same GET /models probe. So Grok chat is
// just another preset over the shared OpenAICompatibleProvider; there is no
// bespoke chat code here.
//
// What makes xAI different is auth: the `Authorization: Bearer` value can be
// EITHER a raw API key OR a subscription OAuth access token (see oauth/xai.ts).
// The adapter is credential-agnostic — it takes whatever resolved string is
// passed as `apiKey` — so the same provider object serves both auth methods.
//
// Model ids web-verified against docs.x.ai/developers/models on 2026-06-17. xAI
// iterates model names quickly; these are the stable canonical chat ids.
// grok-4.3 is the current flagship (1M context) and the default.

import { OpenAICompatibleProvider } from './openai-compatible'

/**
 * Build the xAI Grok provider. Chat reuses the OpenAI-compatible adapter; the
 * resolved credential (API key or OAuth access token) is supplied per call.
 */
export function createXaiProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    kind: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.3',
    models: [
      { id: 'grok-4.3', label: 'Grok 4.3', contextWindow: 1000000 },
      { id: 'grok-4-fast-reasoning', label: 'Grok 4 Fast', contextWindow: 2000000 },
      { id: 'grok-4', label: 'Grok 4', contextWindow: 256000 },
      { id: 'grok-3', label: 'Grok 3', contextWindow: 131072 },
      { id: 'grok-3-mini', label: 'Grok 3 Mini', contextWindow: 131072 }
    ]
  })
}
