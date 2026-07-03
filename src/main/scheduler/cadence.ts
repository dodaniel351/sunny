// Interval math for the scheduler's cadence presets. The preset list + labels are
// in @shared/scheduler (renderer-safe); this module adds the main-process timing
// logic. Pure functions (the caller passes the current epoch ms) so they're
// unit-testable without touching the clock.

import { CADENCES, type Cadence } from '@shared/scheduler'

const INTERVAL_MS: Record<Cadence, number> = {
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000
}

export function isCadence(value: string): value is Cadence {
  return (CADENCES as readonly string[]).includes(value)
}

/** The interval in ms for a cadence, or null if it isn't a known preset. */
export function cadenceIntervalMs(cadence: string): number | null {
  return isCadence(cadence) ? INTERVAL_MS[cadence] : null
}

/** Next fire time (epoch ms) for a cadence measured from `fromMs`, or null if the
 *  cadence is unknown (caller should treat that as "never auto-fire"). */
export function nextRunMs(cadence: string, fromMs: number): number | null {
  const interval = cadenceIntervalMs(cadence)
  return interval === null ? null : fromMs + interval
}

/** Next fire time as an ISO string, or null. */
export function nextRunIso(cadence: string, fromMs: number): string | null {
  const ms = nextRunMs(cadence, fromMs)
  return ms === null ? null : new Date(ms).toISOString()
}
