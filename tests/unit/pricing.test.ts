import { describe, it, expect } from 'vitest'
import { estimateCostUsd, hasPricing } from '@main/costs/pricing'

// Pure pricing-table lookup for budget estimation — no DB, no clock (mirrors
// cadence.test.ts / approval-policy.test.ts).

describe('estimateCostUsd — longest-prefix matching', () => {
  it('does not let a shorter prefix shadow a more specific one (gpt-4o vs gpt-4o-mini)', () => {
    const mini = estimateCostUsd('openai', 'gpt-4o-mini', 1_000_000, 1_000_000)
    const full = estimateCostUsd('openai', 'gpt-4o', 1_000_000, 1_000_000)
    expect(mini).toBe(0.75) // 0.15 + 0.60
    expect(full).toBe(12.5) // 2.50 + 10.00
    expect(mini).not.toBe(full)
  })

  it('does not let a shorter prefix shadow a more specific one (gemini-2.5-flash vs -lite)', () => {
    const lite = estimateCostUsd('google', 'gemini-2.5-flash-lite', 1_000_000, 1_000_000)
    const flash = estimateCostUsd('google', 'gemini-2.5-flash', 1_000_000, 1_000_000)
    expect(lite).toBe(0.5) // 0.10 + 0.40
    expect(flash).toBe(2.8) // 0.30 + 2.50
    expect(lite).not.toBe(flash)
  })

  it('matches a dated/suffixed model id against its family prefix', () => {
    expect(estimateCostUsd('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000)).toBe(18.0)
    expect(estimateCostUsd('anthropic', 'claude-opus-4-20260101', 1_000_000, 1_000_000)).toBe(90.0)
  })
})

describe('estimateCostUsd — local / subscription providers are free, not unknown', () => {
  it('returns 0 for ollama regardless of model id', () => {
    expect(estimateCostUsd('ollama', 'llama3.3', 1_000_000, 1_000_000)).toBe(0)
    expect(estimateCostUsd('ollama', 'anything-at-all', 500, 500)).toBe(0)
  })

  it('returns 0 for opencode and codex (subscription-billed)', () => {
    expect(estimateCostUsd('opencode', 'whatever-model', 1_000_000, 1_000_000)).toBe(0)
    expect(estimateCostUsd('codex', 'whatever-model', 1_000_000, 1_000_000)).toBe(0)
  })

  it('returns 0 for the fake test/dev provider', () => {
    expect(estimateCostUsd('fake', 'fake-model', 1_000_000, 1_000_000)).toBe(0)
  })
})

describe('estimateCostUsd — unknown provider/model is null, not 0', () => {
  it('returns null for a provider with no pricing table at all', () => {
    expect(estimateCostUsd('groq', 'llama-3.3-70b', 1000, 1000)).toBeNull()
    expect(estimateCostUsd('openrouter', 'anything', 1000, 1000)).toBeNull()
    expect(estimateCostUsd('perplexity', 'anything', 1000, 1000)).toBeNull()
    expect(estimateCostUsd('xai', 'grok-4', 1000, 1000)).toBeNull()
  })

  it('returns null for an unrecognized model under a known provider', () => {
    expect(estimateCostUsd('openai', 'some-future-model', 1000, 1000)).toBeNull()
    expect(estimateCostUsd('anthropic', 'claude-99', 1000, 1000)).toBeNull()
  })

  it('returns null for a totally unknown provider kind', () => {
    expect(estimateCostUsd('made-up-provider', 'x', 1000, 1000)).toBeNull()
  })
})

describe('estimateCostUsd — arithmetic + rounding', () => {
  it('computes prompt/completion at their own rates', () => {
    // gpt-4o-mini: 0.15 in / 0.60 out per 1M tok.
    expect(estimateCostUsd('openai', 'gpt-4o-mini', 2_000_000, 0)).toBe(0.3)
    expect(estimateCostUsd('openai', 'gpt-4o-mini', 0, 2_000_000)).toBe(1.2)
  })

  it('handles zero tokens', () => {
    expect(estimateCostUsd('openai', 'gpt-4o', 0, 0)).toBe(0)
  })

  it('rounds to 6 decimal places', () => {
    // 1234 * 0.15 / 1e6 = 0.0001851
    const cost = estimateCostUsd('openai', 'gpt-4o-mini', 1234, 0)
    expect(cost).toBe(0.000185)
  })
})

describe('hasPricing', () => {
  it('is true for a matched model', () => {
    expect(hasPricing('openai', 'gpt-4o')).toBe(true)
    expect(hasPricing('anthropic', 'claude-haiku-4-1')).toBe(true)
  })

  it('is true for known-free local/subscription providers', () => {
    expect(hasPricing('ollama', 'anything')).toBe(true)
    expect(hasPricing('opencode', 'anything')).toBe(true)
  })

  it('is false for unknown providers and unmatched models', () => {
    expect(hasPricing('groq', 'llama-3.3-70b')).toBe(false)
    expect(hasPricing('openai', 'some-future-model')).toBe(false)
  })
})
