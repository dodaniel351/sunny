// Reasoning-tag splitting for models that inline their chain of thought as
// `<think>…</think>` in the answer text (DeepSeek-R1, Qwen, and other local /
// aggregator-served models). Splitting it out lets the UI show reasoning in the
// same collapsible section used for native thinking streams, instead of the raw
// tags landing in the transcript.
//
// Pure string logic — no fetch, no natives — so it is directly unit-testable.

import type { StreamChunk } from './types'

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

/** Longest suffix of `text` that is a (proper) prefix of `tag` — the part we
 *  must hold back because the rest of the tag may arrive in the next chunk. */
function partialTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

/**
 * Stateful splitter for STREAMED text. Only an opening `<think>` at the very
 * start of the stream (leading whitespace allowed) opens a thinking section —
 * a mid-answer `<think>` mention passes through as ordinary text, so prose
 * ABOUT the tag is never swallowed. Handles tags split across chunk boundaries
 * by holding back any partial-tag suffix until the next push/flush.
 */
export class ThinkTagSplitter {
  #state: 'start' | 'thinking' | 'passthrough' = 'start'
  #buf = ''

  push(text: string): StreamChunk[] {
    if (this.#state === 'passthrough') {
      return text === '' ? [] : [{ type: 'delta', text }]
    }
    this.#buf += text
    return this.#drain()
  }

  /** Emit whatever is still buffered (end of stream). An unterminated thinking
   *  section flushes as thinking — the model simply never closed the tag. */
  flush(): StreamChunk[] {
    const out: StreamChunk[] = []
    if (this.#buf !== '') {
      out.push(
        this.#state === 'thinking'
          ? { type: 'thinking', text: this.#buf }
          : { type: 'delta', text: this.#buf }
      )
      this.#buf = ''
    }
    this.#state = 'passthrough'
    return out
  }

  #drain(): StreamChunk[] {
    const out: StreamChunk[] = []

    if (this.#state === 'start') {
      const lead = this.#buf.match(/^\s*/)?.[0] ?? ''
      const rest = this.#buf.slice(lead.length)
      if (rest === '' || OPEN_TAG.startsWith(rest)) return out // could still become the tag
      if (rest.startsWith(OPEN_TAG)) {
        this.#state = 'thinking'
        this.#buf = rest.slice(OPEN_TAG.length)
      } else {
        this.#state = 'passthrough'
        const text = this.#buf
        this.#buf = ''
        if (text !== '') out.push({ type: 'delta', text })
        return out
      }
    }

    if (this.#state === 'thinking') {
      const close = this.#buf.indexOf(CLOSE_TAG)
      if (close >= 0) {
        const thought = this.#buf.slice(0, close)
        if (thought !== '') out.push({ type: 'thinking', text: thought })
        // The answer follows the tag; drop the blank lines models put after it.
        const answer = this.#buf.slice(close + CLOSE_TAG.length).replace(/^\s+/, '')
        this.#state = 'passthrough'
        this.#buf = ''
        if (answer !== '') out.push({ type: 'delta', text: answer })
      } else {
        // Emit what cannot be part of a split close tag; hold the rest back.
        const hold = partialTagSuffix(this.#buf, CLOSE_TAG)
        const emit = this.#buf.slice(0, this.#buf.length - hold)
        this.#buf = this.#buf.slice(this.#buf.length - hold)
        if (emit !== '') out.push({ type: 'thinking', text: emit })
      }
    }

    return out
  }
}

/**
 * Whole-string variant for NON-streaming paths (tool loops emit the final
 * answer as one string): split a leading `<think>…</think>` block off the
 * answer. No tags → the input comes back unchanged as `answer`.
 */
export function splitThinkTag(text: string): { thinking: string; answer: string } {
  const lead = text.match(/^\s*/)?.[0] ?? ''
  const rest = text.slice(lead.length)
  if (!rest.startsWith(OPEN_TAG)) return { thinking: '', answer: text }
  const close = rest.indexOf(CLOSE_TAG)
  if (close < 0) return { thinking: rest.slice(OPEN_TAG.length), answer: '' }
  return {
    thinking: rest.slice(OPEN_TAG.length, close),
    answer: rest.slice(close + CLOSE_TAG.length).replace(/^\s+/, '')
  }
}
