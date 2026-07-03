import { describe, it, expect } from 'vitest'
import {
  MAX_RUN_ATTEMPTS,
  classifyRunFailure,
  retryBackoffMs,
  retryDecision
} from '@main/worker/run-policy'

// Pure retry policy for autonomous runs: transient provider blips retry with
// backoff (bounded); auth/config errors and user aborts park immediately.

describe('classifyRunFailure', () => {
  it('treats the worker wall-clock timeout as transient', () => {
    expect(classifyRunFailure('Timed out after 5 minutes on openai/gpt-4o — …', true)).toBe(
      'transient'
    )
  })

  it('classifies network / rate-limit / 5xx errors as transient', () => {
    expect(classifyRunFailure('Run failed on ollama/llama3: fetch failed', false)).toBe('transient')
    expect(classifyRunFailure('429 Too Many Requests', false)).toBe('transient')
    expect(classifyRunFailure('Anthropic is overloaded, try again shortly', false)).toBe(
      'transient'
    )
    expect(classifyRunFailure('502 Bad Gateway', false)).toBe('transient')
    expect(classifyRunFailure('read ECONNRESET', false)).toBe('transient')
  })

  it('classifies auth/config errors as permanent — even with network words present', () => {
    expect(classifyRunFailure('401 Unauthorized', false)).toBe('permanent')
    expect(classifyRunFailure('Invalid or unauthorized API key', false)).toBe('permanent')
    expect(classifyRunFailure('No API key configured for this provider.', false)).toBe('permanent')
    expect(classifyRunFailure('model gpt-9 not found', false)).toBe('permanent')
    // "network" is a transient word, but the 403 makes it permanent.
    expect(classifyRunFailure('403 Forbidden from network gateway', false)).toBe('permanent')
  })

  it('treats a deliberate abort (user stop/disable) as permanent — no retry loop', () => {
    expect(classifyRunFailure('This operation was aborted', false)).toBe('permanent')
  })

  it('defaults unknown errors to transient (the cap bounds a wrong guess)', () => {
    expect(classifyRunFailure('something inexplicable happened', false)).toBe('transient')
  })
})

describe('retryDecision', () => {
  it('retries a transient failure under the cap with growing backoff', () => {
    const first = retryDecision('fetch failed', false, 1)
    const second = retryDecision('fetch failed', false, 2)
    expect(first).toEqual({ retry: true, delayMs: retryBackoffMs(1) })
    expect(second).toEqual({ retry: true, delayMs: retryBackoffMs(2) })
    expect(retryBackoffMs(2)).toBeGreaterThan(retryBackoffMs(1))
  })

  it('parks after MAX_RUN_ATTEMPTS consecutive failures', () => {
    expect(retryDecision('fetch failed', false, MAX_RUN_ATTEMPTS)).toEqual({
      retry: false,
      kind: 'transient'
    })
  })

  it('never retries a permanent failure, even on the first attempt', () => {
    expect(retryDecision('401 Unauthorized', false, 1)).toEqual({
      retry: false,
      kind: 'permanent'
    })
  })
})
