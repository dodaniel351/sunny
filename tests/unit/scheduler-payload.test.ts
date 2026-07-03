import { describe, it, expect } from 'vitest'
import { mergeSchedulePayload } from '@shared/scheduler'

// mergeSchedulePayload overwrites only the fields present in the patch, so
// editing one field of a schedule never wipes the others (the 0.4.2 fix).

const parse = (json: string): unknown => JSON.parse(json)

describe('mergeSchedulePayload', () => {
  const existing = JSON.stringify({ prompt: 'do the thing', provider: 'openai', model: 'gpt-4o' })

  it('overwrites only the patched field, preserving the rest', () => {
    expect(parse(mergeSchedulePayload(existing, { prompt: 'new goal' }))).toEqual({
      prompt: 'new goal',
      provider: 'openai',
      model: 'gpt-4o'
    })
  })

  it('preserves the model override when only the prompt changes', () => {
    const merged = parse(mergeSchedulePayload(existing, { prompt: 'x' })) as { model: string }
    expect(merged.model).toBe('gpt-4o')
  })

  it('can explicitly clear the override with null', () => {
    expect(parse(mergeSchedulePayload(existing, { provider: null, model: null }))).toEqual({
      prompt: 'do the thing',
      provider: null,
      model: null
    })
  })

  it('degrades to defaults for a malformed stored payload', () => {
    expect(parse(mergeSchedulePayload('not json{', { prompt: 'hi' }))).toEqual({
      prompt: 'hi',
      provider: null,
      model: null
    })
  })

  it('starts from defaults when there is no existing payload', () => {
    expect(parse(mergeSchedulePayload(null, { provider: 'ollama', model: 'llama3' }))).toEqual({
      prompt: '',
      provider: 'ollama',
      model: 'llama3'
    })
  })
})
