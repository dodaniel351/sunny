// Pure retry policy for autonomous runs (unattended resilience). When a worker
// run fails, the failure is classified as TRANSIENT (provider blip — worth an
// automatic retry with backoff) or PERMANENT (config/auth problem or a user
// abort — retrying burns calls without fixing anything). Kept native-free and
// side-effect-free so it's unit-testable without a DB (mirrors approval-policy).
//
// The worker maps the decision onto the board: a transient failure under the
// attempt cap re-queues the task to Planned with `wake_at = now + backoff`
// (the DB-backed wakeup queue `workableNow` already honors); a permanent or
// exhausted failure parks Blocked with the reason, exactly as before.

export type FailureKind = 'transient' | 'permanent'

/** Total runs allowed per failure streak (initial + retries) before parking. */
export const MAX_RUN_ATTEMPTS = 3

// Failures that indicate the PROVIDER (not the task) had a moment: network
// errors, rate limits, overload, 5xx. These deserve a retry.
const TRANSIENT_PATTERNS =
  /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket|stream|429|too many requests|rate.?limit|overloaded|busy|try again|unavailable|bad gateway|gateway timeout|internal server error|5\d\d/i

// Failures that will not fix themselves: auth/key problems, a model the account
// can't use, malformed requests, and deliberate aborts (user stop/disable).
const PERMANENT_PATTERNS =
  /401|403|unauthorized|forbidden|invalid|api key|no api key|not connected|expired|revoked|model.*not (found|available)|unknown model|unsupported|400|aborted|user did not approve/i

/**
 * Classify a failed run. `timedOut` is the worker's own wall-clock abort — a
 * slow/hung provider, so always transient. Otherwise permanent patterns win
 * over transient ones (e.g. "401 unauthorized" must not retry even though the
 * message also mentions the network). Unmatched errors default to TRANSIENT:
 * the retry cap bounds the cost of a wrong guess at two extra calls, while
 * defaulting to permanent would park every unknown blip — the exact failure
 * mode this policy exists to remove.
 */
export function classifyRunFailure(message: string, timedOut: boolean): FailureKind {
  if (timedOut) return 'transient'
  if (PERMANENT_PATTERNS.test(message)) return 'permanent'
  if (TRANSIENT_PATTERNS.test(message)) return 'transient'
  return 'transient'
}

/**
 * Backoff before retry `attempt` (1-based count of failures so far):
 * 1 minute after the first failure, 5 minutes after the second. Attempts at or
 * past MAX_RUN_ATTEMPTS never retry (the caller parks the task instead).
 */
export function retryBackoffMs(attempt: number): number {
  return attempt <= 1 ? 60_000 : 5 * 60_000
}

/**
 * The full retry decision: retry (with delay) or park. `consecutiveFailures`
 * INCLUDES the failure being decided (so the first failure passes 1).
 */
export function retryDecision(
  message: string,
  timedOut: boolean,
  consecutiveFailures: number
): { retry: true; delayMs: number } | { retry: false; kind: FailureKind } {
  const kind = classifyRunFailure(message, timedOut)
  if (kind === 'transient' && consecutiveFailures < MAX_RUN_ATTEMPTS) {
    return { retry: true, delayMs: retryBackoffMs(consecutiveFailures) }
  }
  return { retry: false, kind }
}
