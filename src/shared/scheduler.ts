// Scheduler cadence presets, shared by the contract (validation), the main
// scheduler runtime (interval math), and the renderer (the cadence dropdown).
// Renderer-safe: plain constants, no native/electron imports. The scheduler is
// "minimal" (spec §7) — fixed rolling intervals, not full cron.

export const CADENCES = ['15m', '30m', 'hourly', 'daily', 'weekly'] as const
export type Cadence = (typeof CADENCES)[number]

export const CADENCE_LABELS: Record<Cadence, string> = {
  '15m': 'Every 15 minutes',
  '30m': 'Every 30 minutes',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly'
}

// A schedule's stored `payload` JSON: the goal prompt plus an optional
// provider+model override the run should use.
export interface SchedulePayload {
  prompt: string
  provider: string | null
  model: string | null
}

/** A partial payload update — only the present fields overwrite the stored ones. */
export type SchedulePayloadPatch = Partial<SchedulePayload>

/**
 * Merge a partial payload update into the existing stored payload, overwriting
 * ONLY the fields present in the patch (a field left `undefined` is preserved).
 * Guards JSON.parse so a malformed stored value degrades to defaults instead of
 * throwing. Returns the re-stringified payload. This is what stops editing (say)
 * just the prompt from wiping a saved provider/model override.
 */
export function mergeSchedulePayload(
  existing: string | null,
  patch: SchedulePayloadPatch
): string {
  let base: SchedulePayload = { prompt: '', provider: null, model: null }
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Partial<SchedulePayload>
      base = {
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
        provider: typeof parsed.provider === 'string' ? parsed.provider : null,
        model: typeof parsed.model === 'string' ? parsed.model : null
      }
    } catch {
      // malformed stored payload — start from defaults
    }
  }
  return JSON.stringify({
    prompt: patch.prompt !== undefined ? patch.prompt : base.prompt,
    provider: patch.provider !== undefined ? patch.provider : base.provider,
    model: patch.model !== undefined ? patch.model : base.model
  })
}
