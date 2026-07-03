import type { ChatTurn } from '@main/providers/types'

// Pure decision logic for the worker's ITERATIVE agent loop (0.5.0). A task run
// is no longer one LLM call: the agent works in TURNS, self-reports whether it
// is finished via a STATUS marker, gets a verification pass when it claims
// completion, and can resume a prior run's conversation (context_ref). Kept
// native-free and side-effect-free so it's unit-testable without a DB
// (mirrors approval-policy / run-policy).

/** Max agent turns per run. Bounds cost/runaway; each turn also has the tool
 *  loop's own round cap inside it, so real depth = turns × rounds. */
export const MAX_AGENT_TURNS = 4

/** Char budget when replaying a prior run's conversation into a resumed run —
 *  newest messages win. Bounds the context of long multi-attempt tasks. */
export const RESUME_HISTORY_CHAR_CAP = 12_000

/** Appended to the worker's system prompt so the model reports its own state. */
export const STATUS_INSTRUCTIONS =
  'End EVERY reply with exactly one status line:\n' +
  '  STATUS: DONE — the task is fully complete (your reply above is the final result)\n' +
  '  STATUS: CONTINUE — you made progress but need another working turn to finish\n' +
  '  STATUS: BLOCKED: <reason> — you cannot proceed without something you lack\n' +
  'Never claim DONE if work remains.'

/** The reviewer persona for the verification pass. */
export const VERIFICATION_SYSTEM =
  'You are a strict reviewer. Judge ONLY whether the submitted result actually accomplishes ' +
  'the task — completeness, correctness, and whether it does what was asked (not style). ' +
  'Reply with exactly one line: "VERDICT: PASS" if it accomplishes the task, or ' +
  '"VERDICT: FAIL: <one short sentence naming what is missing or wrong>" if it does not.'

export type AgentTurnStatus = 'done' | 'continue' | 'blocked'

export interface ParsedStatus {
  status: AgentTurnStatus
  /** The BLOCKED reason (empty otherwise). */
  reason: string
  /** The reply with the status line removed (what gets saved/shown). */
  cleaned: string
}

const STATUS_RE = /^[ \t>*-]*STATUS:\s*(DONE|CONTINUE|BLOCKED)\b[:\s—-]*(.*)$/gim

/**
 * Pull the agent's self-reported status out of a reply. The LAST marker wins
 * (models sometimes restate instructions early in a reply). A missing marker is
 * treated as DONE — identical to the old single-shot behavior, so small local
 * models that ignore the instruction degrade gracefully instead of looping.
 */
export function parseStatusMarker(text: string): ParsedStatus {
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  STATUS_RE.lastIndex = 0
  while ((match = STATUS_RE.exec(text)) !== null) last = match
  if (!last) return { status: 'done', reason: '', cleaned: text.trim() }
  const status = last[1].toLowerCase() as AgentTurnStatus
  const reason = (last[2] ?? '').trim()
  // Remove ONLY the matched marker line from the saved reply.
  const cleaned = (text.slice(0, last.index) + text.slice(last.index + last[0].length))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { status, reason, cleaned }
}

export interface ParsedVerdict {
  pass: boolean
  critique: string
}

const VERDICT_RE = /^[ \t>*-]*VERDICT:\s*(PASS|FAIL)\b[:\s—-]*(.*)$/im

/**
 * Parse the reviewer's verdict. A missing/malformed verdict counts as PASS
 * (fail-open): a weak reviewer model must never trap a finished task in an
 * endless rework loop.
 */
export function parseVerdict(text: string): ParsedVerdict {
  const match = VERDICT_RE.exec(text)
  if (!match) return { pass: true, critique: '' }
  return { pass: match[1].toUpperCase() === 'PASS', critique: (match[2] ?? '').trim() }
}

/** The user turn asking for the verification pass. */
export function buildVerificationPrompt(
  title: string,
  description: string | null,
  finalOutput: string
): string {
  return (
    `Task: ${title}` +
    (description ? `\n\nTask details: ${description}` : '') +
    `\n\nSubmitted result:\n${finalOutput}\n\nDoes the result accomplish the task? One line: VERDICT: PASS or VERDICT: FAIL: <why>.`
  )
}

/** The continuation nudge appended between working turns. */
export function buildContinuePrompt(): string {
  return 'Continue working on the task. When it is fully complete, end with STATUS: DONE.'
}

/** The rework nudge after a failed verification. */
export function buildReworkPrompt(critique: string): string {
  return (
    `A reviewer checked your result and found it incomplete: ${critique || 'it does not fully accomplish the task.'}` +
    ' Address this and produce the corrected, complete result. End with STATUS: DONE when finished.'
  )
}

/**
 * Cap a resumed conversation to the newest messages within `maxChars`
 * (whole-message granularity, order preserved). System turns are excluded by
 * the caller; this just bounds size.
 */
export function capChatHistory(turns: ChatTurn[], maxChars = RESUME_HISTORY_CHAR_CAP): ChatTurn[] {
  const kept: ChatTurn[] = []
  let total = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = turns[i].content.length
    if (total + len > maxChars && kept.length > 0) break
    // A single over-cap message is truncated rather than dropped entirely.
    const content =
      total + len > maxChars ? turns[i].content.slice(-(maxChars - total)) : turns[i].content
    kept.unshift({ ...turns[i], content })
    total += content.length
    if (total >= maxChars) break
  }
  return kept
}
