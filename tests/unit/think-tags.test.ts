import { describe, it, expect } from 'vitest'
import { ThinkTagSplitter, splitThinkTag } from '@main/providers/think-tags'
import type { StreamChunk } from '@main/providers/types'

// Pure string logic: the streaming <think>…</think> splitter used by the
// Ollama / openai-compatible adapters, and the whole-string variant used by
// the shared tool loop. No fetch, no natives.

/** Push a sequence of deltas through a fresh splitter and fold the output. */
function run(chunks: string[]): { thinking: string; answer: string; order: string[] } {
  const splitter = new ThinkTagSplitter()
  const out: StreamChunk[] = []
  for (const text of chunks) out.push(...splitter.push(text))
  out.push(...splitter.flush())
  let thinking = ''
  let answer = ''
  const order: string[] = []
  for (const c of out) {
    order.push(c.type)
    if (c.type === 'thinking') thinking += c.text
    else if (c.type === 'delta') answer += c.text
  }
  return { thinking, answer, order }
}

describe('ThinkTagSplitter', () => {
  it('passes text without tags through unchanged', () => {
    const r = run(['Hello ', 'world'])
    expect(r.thinking).toBe('')
    expect(r.answer).toBe('Hello world')
  })

  it('splits a leading think block from the answer', () => {
    const r = run(['<think>let me reason</think>\n\nThe answer is 42.'])
    expect(r.thinking).toBe('let me reason')
    expect(r.answer).toBe('The answer is 42.')
  })

  it('handles the open tag split across chunk boundaries', () => {
    const r = run(['<th', 'ink>rea', 'soning</think>answer'])
    expect(r.thinking).toBe('reasoning')
    expect(r.answer).toBe('answer')
  })

  it('handles the close tag split across chunk boundaries', () => {
    const r = run(['<think>abc</th', 'ink>def'])
    expect(r.thinking).toBe('abc')
    expect(r.answer).toBe('def')
  })

  it('allows leading whitespace before the open tag', () => {
    const r = run(['\n\n<think>x</think>y'])
    expect(r.thinking).toBe('x')
    expect(r.answer).toBe('y')
  })

  it('does NOT treat a mid-answer <think> mention as reasoning', () => {
    const r = run(['The tag ', '<think> is used by some models.'])
    expect(r.thinking).toBe('')
    expect(r.answer).toBe('The tag <think> is used by some models.')
  })

  it('flushes an unterminated think block as thinking', () => {
    const r = run(['<think>never closed'])
    expect(r.thinking).toBe('never closed')
    expect(r.answer).toBe('')
  })

  it('streams thinking incrementally instead of buffering it whole', () => {
    const splitter = new ThinkTagSplitter()
    const first = splitter.push('<think>a long stretch of reasoning ')
    // Everything that cannot be part of a split </think> should already be out.
    expect(first.some((c) => c.type === 'thinking')).toBe(true)
  })

  it('emits thinking before the answer in order', () => {
    const r = run(['<think>a</think>b'])
    expect(r.order[0]).toBe('thinking')
    expect(r.order[r.order.length - 1]).toBe('delta')
  })
})

describe('splitThinkTag', () => {
  it('returns the input unchanged when there is no tag', () => {
    expect(splitThinkTag('plain answer')).toEqual({ thinking: '', answer: 'plain answer' })
  })

  it('splits a leading think block', () => {
    expect(splitThinkTag('<think>why</think>\n\nbecause')).toEqual({
      thinking: 'why',
      answer: 'because'
    })
  })

  it('treats an unterminated block as all thinking', () => {
    expect(splitThinkTag('<think>oops')).toEqual({ thinking: 'oops', answer: '' })
  })

  it('leaves a mid-answer tag alone', () => {
    expect(splitThinkTag('about <think> tags')).toEqual({
      thinking: '',
      answer: 'about <think> tags'
    })
  })
})
