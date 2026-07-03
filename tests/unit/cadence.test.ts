import { describe, it, expect } from 'vitest'
import {
  isCadence,
  cadenceIntervalMs,
  nextRunMs,
  nextRunIso
} from '@main/scheduler/cadence'
import { CADENCES } from '@shared/scheduler'

// Pure interval math for the scheduler — no clock, no DB.

describe('isCadence', () => {
  it('accepts every known preset', () => {
    for (const c of CADENCES) expect(isCadence(c)).toBe(true)
  })
  it('rejects unknown strings', () => {
    expect(isCadence('yearly')).toBe(false)
    expect(isCadence('* * * * *')).toBe(false)
    expect(isCadence('')).toBe(false)
  })
})

describe('cadenceIntervalMs', () => {
  it('maps presets to their interval', () => {
    expect(cadenceIntervalMs('15m')).toBe(15 * 60_000)
    expect(cadenceIntervalMs('30m')).toBe(30 * 60_000)
    expect(cadenceIntervalMs('hourly')).toBe(60 * 60_000)
    expect(cadenceIntervalMs('daily')).toBe(24 * 60 * 60_000)
    expect(cadenceIntervalMs('weekly')).toBe(7 * 24 * 60 * 60_000)
  })
  it('returns null for an unknown cadence', () => {
    expect(cadenceIntervalMs('nope')).toBeNull()
  })
})

describe('nextRunMs / nextRunIso', () => {
  const base = Date.UTC(2026, 5, 18, 12, 0, 0) // 2026-06-18T12:00:00Z

  it('adds the interval to the from time', () => {
    expect(nextRunMs('hourly', base)).toBe(base + 60 * 60_000)
    expect(nextRunMs('daily', base)).toBe(base + 24 * 60 * 60_000)
  })
  it('returns null for an unknown cadence', () => {
    expect(nextRunMs('nope', base)).toBeNull()
    expect(nextRunIso('nope', base)).toBeNull()
  })
  it('formats the next run as an ISO string', () => {
    expect(nextRunIso('daily', base)).toBe(new Date(base + 24 * 60 * 60_000).toISOString())
  })
})
