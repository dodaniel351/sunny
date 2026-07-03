import { describe, it, expect } from 'vitest'
import {
  MAX_AGENT_TURNS,
  capChatHistory,
  parseStatusMarker,
  parseVerdict
} from '@main/worker/loop-policy'
import type { ChatTurn } from '@main/providers/types'

// Pure decision logic for the iterative worker loop: the agent's self-reported
// STATUS marker, the reviewer's VERDICT, and resumed-history capping.

describe('parseStatusMarker', () => {
  it('parses DONE and strips the marker line from the saved reply', () => {
    const parsed = parseStatusMarker('Here is the result.\n\nSTATUS: DONE')
    expect(parsed.status).toBe('done')
    expect(parsed.cleaned).toBe('Here is the result.')
  })

  it('parses CONTINUE', () => {
    expect(parseStatusMarker('Partial work…\nSTATUS: CONTINUE').status).toBe('continue')
  })

  it('parses BLOCKED with its reason', () => {
    const parsed = parseStatusMarker('Cannot proceed.\nSTATUS: BLOCKED: missing the API key')
    expect(parsed.status).toBe('blocked')
    expect(parsed.reason).toBe('missing the API key')
  })

  it('treats a missing marker as DONE (old single-shot behavior for weak models)', () => {
    const parsed = parseStatusMarker('Just an answer with no marker.')
    expect(parsed.status).toBe('done')
    expect(parsed.cleaned).toBe('Just an answer with no marker.')
  })

  it('uses the LAST marker when a reply restates the instruction earlier', () => {
    const text = 'I will end with STATUS: CONTINUE as instructed.\n\nWork...\n\nSTATUS: DONE'
    expect(parseStatusMarker(text).status).toBe('done')
  })

  it('is case-insensitive and tolerates list/quote prefixes', () => {
    expect(parseStatusMarker('done!\n> status: done').status).toBe('done')
    expect(parseStatusMarker('x\n- STATUS: Blocked — need input').status).toBe('blocked')
  })
})

describe('parseVerdict', () => {
  it('parses PASS', () => {
    expect(parseVerdict('VERDICT: PASS')).toEqual({ pass: true, critique: '' })
  })

  it('parses FAIL with the critique', () => {
    const v = parseVerdict('VERDICT: FAIL: the summary is missing section 3')
    expect(v.pass).toBe(false)
    expect(v.critique).toBe('the summary is missing section 3')
  })

  it('fails OPEN on a missing/malformed verdict (never trap a finished task)', () => {
    expect(parseVerdict('I think it looks fine overall.').pass).toBe(true)
    expect(parseVerdict('').pass).toBe(true)
  })
})

describe('capChatHistory', () => {
  const turn = (role: 'user' | 'assistant', content: string): ChatTurn => ({ role, content })

  it('keeps everything when under the cap', () => {
    const turns = [turn('user', 'a'), turn('assistant', 'b')]
    expect(capChatHistory(turns, 100)).toEqual(turns)
  })

  it('drops the OLDEST messages first when over the cap', () => {
    const turns = [
      turn('user', 'x'.repeat(60)),
      turn('assistant', 'y'.repeat(60)),
      turn('user', 'z'.repeat(60))
    ]
    const capped = capChatHistory(turns, 130)
    expect(capped.length).toBe(2)
    expect(capped[0].content[0]).toBe('y')
    expect(capped[1].content[0]).toBe('z')
  })

  it('truncates rather than drops a single over-cap newest message', () => {
    const capped = capChatHistory([turn('assistant', 'a'.repeat(500))], 100)
    expect(capped.length).toBe(1)
    expect(capped[0].content.length).toBe(100)
  })

  it('exports a sane turn cap', () => {
    expect(MAX_AGENT_TURNS).toBeGreaterThanOrEqual(2)
  })
})
