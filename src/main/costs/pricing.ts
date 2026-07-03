// Approximate list prices, USD per 1M tokens, as of mid-2026 — used for budget
// estimation only, not billing. These are the public per-token list prices each
// provider publishes; Sunny has no visibility into a user's actual invoice (org
// discounts, committed-use pricing, etc.), so `costs:summary` numbers are always
// labeled as estimates in the UI.
//
// Deliberately pure (no imports beyond types) so it's trivially unit-testable
// and safe to import from both main-process cost tracking and tests without
// pulling in Electron/DB/native deps.
//
// Table sources (approximate, mid-2026 list prices):
//   openai:     gpt-4o-mini 0.15/0.60, gpt-4o 2.50/10.00, gpt-4.1-mini 0.40/1.60,
//               gpt-4.1-nano 0.10/0.40, gpt-4.1 2.00/8.00, o3-mini 1.10/4.40,
//               o3 2.00/8.00, o4-mini 1.10/4.40
//   anthropic:  claude-opus-4 15.00/75.00, claude-sonnet-4 3.00/15.00,
//               claude-haiku-4 1.00/5.00, claude-3-5-haiku 0.80/4.00
//   google:     gemini-2.5-pro 1.25/10.00, gemini-2.5-flash-lite 0.10/0.40,
//               gemini-2.5-flash 0.30/2.50, gemini-2.0-flash 0.10/0.40
//   ollama:     local inference — free (0/0)
//   opencode:   subscription-billed — no per-token cost to record (0/0)
//   codex:      subscription-billed — no per-token cost to record (0/0)
//   fake:       test/dev provider — free (0/0)
//   groq / openrouter / perplexity / xai: intentionally ABSENT — unknown pricing,
//   NOT free. Callers must treat "no match" as unknown, never as $0.

export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
}

interface PricingEntry {
  /** Matched against the model id via `model.startsWith(prefix)`; ties broken
   *  by longest prefix (so 'gpt-4o-mini' outranks 'gpt-4o'). Empty string
   *  matches every model under that provider (used for flat-rate providers). */
  prefix: string
  pricing: ModelPricing
}

const PRICING: Record<string, PricingEntry[]> = {
  openai: [
    { prefix: 'gpt-4o-mini', pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
    { prefix: 'gpt-4o', pricing: { inputPerMTok: 2.5, outputPerMTok: 10.0 } },
    { prefix: 'gpt-4.1-mini', pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 } },
    { prefix: 'gpt-4.1-nano', pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
    { prefix: 'gpt-4.1', pricing: { inputPerMTok: 2.0, outputPerMTok: 8.0 } },
    { prefix: 'o3-mini', pricing: { inputPerMTok: 1.1, outputPerMTok: 4.4 } },
    { prefix: 'o3', pricing: { inputPerMTok: 2.0, outputPerMTok: 8.0 } },
    { prefix: 'o4-mini', pricing: { inputPerMTok: 1.1, outputPerMTok: 4.4 } }
  ],
  anthropic: [
    { prefix: 'claude-opus-4', pricing: { inputPerMTok: 15.0, outputPerMTok: 75.0 } },
    { prefix: 'claude-sonnet-4', pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0 } },
    { prefix: 'claude-haiku-4', pricing: { inputPerMTok: 1.0, outputPerMTok: 5.0 } },
    { prefix: 'claude-3-5-haiku', pricing: { inputPerMTok: 0.8, outputPerMTok: 4.0 } }
  ],
  google: [
    { prefix: 'gemini-2.5-pro', pricing: { inputPerMTok: 1.25, outputPerMTok: 10.0 } },
    { prefix: 'gemini-2.5-flash-lite', pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
    { prefix: 'gemini-2.5-flash', pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 } },
    { prefix: 'gemini-2.0-flash', pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 } }
  ],
  // Local inference — no metered cost.
  ollama: [{ prefix: '', pricing: { inputPerMTok: 0, outputPerMTok: 0 } }],
  // Subscription-billed — no per-token cost to record.
  opencode: [{ prefix: '', pricing: { inputPerMTok: 0, outputPerMTok: 0 } }],
  codex: [{ prefix: '', pricing: { inputPerMTok: 0, outputPerMTok: 0 } }],
  // Test/dev provider.
  fake: [{ prefix: '', pricing: { inputPerMTok: 0, outputPerMTok: 0 } }]
  // groq / openrouter / perplexity / xai: intentionally absent — unknown, not free.
}

/** The longest-prefix pricing match for a provider+model, or null if the
 *  provider isn't in the table or no prefix matches the model id. */
function findPricing(provider: string, model: string): ModelPricing | null {
  const table = PRICING[provider]
  if (!table) return null
  let best: PricingEntry | null = null
  for (const entry of table) {
    if (model.startsWith(entry.prefix) && (best === null || entry.prefix.length > best.prefix.length)) {
      best = entry
    }
  }
  return best ? best.pricing : null
}

/**
 * Estimate USD cost for a completion from list prices. Returns null when the
 * provider or model has no pricing entry — unknown is NOT the same as free, so
 * callers must not coerce null to 0 when summing spend.
 */
export function estimateCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): number | null {
  const pricing = findPricing(provider, model)
  if (!pricing) return null
  const cost =
    (promptTokens * pricing.inputPerMTok + completionTokens * pricing.outputPerMTok) / 1e6
  return Math.round(cost * 1e6) / 1e6
}

/** Whether a provider+model has a known price (including known-free entries). */
export function hasPricing(provider: string, model: string): boolean {
  return findPricing(provider, model) !== null
}
