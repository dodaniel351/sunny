import { createHash } from 'node:crypto'
import type { ApprovalStatus } from '@shared/db/types'

// Pure decision logic for the autonomous worker's approval gate (structure layer,
// Phase 4). Kept native-free and side-effect-free so it's unit-testable without a
// DB (mirrors lib/goals.ts) — the worker maps the outcome to a ConfirmFn result
// and the approval/activity writes.
//
// When a tool's permission gate (registry.ts) asks the worker to confirm a
// side-effecting action, there's no human watching, so instead of a modal we
// consult the most recent approval recorded for this (task, gate) and decide:
//
//   - request → no prior decision exists: create a PENDING approval and deny the
//               action this run (the task is parked until the user decides).
//   - wait    → an approval is already pending: deny again WITHOUT duplicating it.
//   - allow   → the user approved this gate: let the action proceed.
//   - deny    → the user rejected this gate: refuse permanently (no re-ask).
//
// An `expired` approval is treated like none — ask again.

export type ApprovalGateOutcome = 'request' | 'wait' | 'allow' | 'deny'

/** The slice of an approval the gate decision depends on (just its status). */
export interface ApprovalGateInput {
  status: ApprovalStatus
}

/**
 * Decide what the worker's confirm should do for a (task, gate), given the most
 * recent approval recorded for it (or null when none exists yet).
 */
export function approvalGateOutcome(latest: ApprovalGateInput | null): ApprovalGateOutcome {
  if (!latest) return 'request'
  switch (latest.status) {
    case 'approved':
      return 'allow'
    case 'pending':
      return 'wait'
    case 'rejected':
      return 'deny'
    case 'expired':
      return 'request'
    default:
      return 'request'
  }
}

/** Whether the gate outcome lets the action proceed (the ConfirmFn return value). */
export function outcomeAllows(outcome: ApprovalGateOutcome): boolean {
  return outcome === 'allow'
}

/**
 * Build the gate key for an approval, scoped to the SPECIFIC action rather than
 * just the tool, so approving one command never blanket-allows a different one.
 * Key = `tool:<tool>:<digest>` where digest is the first 12 hex chars of the
 * SHA-256 of the normalized detail (which the registry makes deterministic per
 * action — it names the command/path). A re-run of the SAME action yields the
 * same key (so it matches its approval); a DIFFERENT command yields a new key →
 * a fresh request. Old `tool:<tool>` rows simply never match again → re-ask
 * (safe; no migration needed).
 */
export function approvalGateKey(tool: string, detail?: string | null): string {
  const normalized = (detail ?? '').trim()
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return `tool:${tool}:${digest}`
}

/**
 * Decide what to do with a task after a run that hit one or more approval gates,
 * given the CURRENT status of each gate that was denied this run. Extracted pure
 * for testing (the worker maps the disposition to run/lock/board writes).
 *
 *   done     — no gate was denied this run (the normal success path).
 *   park     — at least one gate is still pending (awaiting the user's decision).
 *   requeue  — none pending and at least one was approved (the user approved
 *              mid-run): re-run the task to apply it (its gate then consumes it).
 *   rejected — none pending and all were decided otherwise (rejected/expired):
 *              stay Blocked.
 */
export function postRunDisposition(
  gateStatuses: ApprovalStatus[]
): 'done' | 'park' | 'requeue' | 'rejected' {
  if (gateStatuses.length === 0) return 'done'
  if (gateStatuses.some((s) => s === 'pending')) return 'park'
  if (gateStatuses.some((s) => s === 'approved')) return 'requeue'
  return 'rejected'
}
