import { memoryKindValues, memoryScopeValues } from '@shared/db/types'
import type { MemoryKind, MemoryScope } from '@shared/db/types'

// Presentation metadata for memory scopes and kinds — single source of truth for
// the labels, ordering, and theme accent classes used by the badges and the
// add/edit forms. Keeping it here means a new kind/scope is styled in one place.

/** Human label for each scope tier. */
export const scopeLabels: Record<MemoryScope, string> = {
  session: 'Session',
  project: 'Project',
  global: 'Global'
}

/** Human label for each memory kind. */
export const kindLabels: Record<MemoryKind, string> = {
  working: 'Working',
  episodic: 'Episodic',
  semantic: 'Semantic',
  fact: 'Fact',
  instruction: 'Instruction'
}

/**
 * Badge tint per scope, drawn from the theme's status accents so each tier reads
 * at a glance. Soft fills (15% alpha) keep them legible on the dark panels.
 */
export const scopeBadgeClass: Record<MemoryScope, string> = {
  session: 'bg-status-queued/15 text-status-queued',
  project: 'bg-status-info/15 text-status-info',
  global: 'bg-amber-400/15 text-amber-300'
}

/** Badge tint per kind — muted by default; the amber accent marks instructions. */
export const kindBadgeClass: Record<MemoryKind, string> = {
  working: 'bg-ink-750 text-fg-muted',
  episodic: 'bg-ink-750 text-fg-muted',
  semantic: 'bg-ink-750 text-fg-muted',
  fact: 'bg-status-success/15 text-status-success',
  instruction: 'bg-amber-400/15 text-amber-300'
}

/** Ordered scope options for selects/filters (matches the db enum order). */
export const scopeOptions: readonly MemoryScope[] = memoryScopeValues

/** Ordered kind options for selects (matches the db enum order). */
export const kindOptions: readonly MemoryKind[] = memoryKindValues

// --- Knowledge-graph presentation ------------------------------------------
//
// Entity `type` is free TEXT (extraction can coin new kinds without a
// migration), so we map a known palette and fall back to a deterministic pick
// for anything unrecognized — colors are resolved hex (not Tailwind classes) so
// they can drive SVG `fill`/`stroke` directly. All values are pulled from the
// theme tokens in tailwind.config.cjs.

/** Theme-token hexes reused for SVG fills/strokes in the graph. */
export const graphColors = {
  amber: '#f5a623',
  amberDim: '#3a2e16',
  success: '#34d399',
  blocked: '#f87171',
  queued: '#60a5fa',
  info: '#a78bfa',
  fg: '#e8eaf0',
  fgMuted: '#9aa3b4',
  fgSubtle: '#6b7385',
  ink700: '#262d3b',
  ink850: '#12161f'
} as const

// Curated color per well-known entity type; lowercase keys for case-insensitive
// lookup. Unknown types hash onto the same palette so they stay stable + legible.
const entityTypeColors: Record<string, string> = {
  person: graphColors.amber,
  org: graphColors.info,
  organization: graphColors.info,
  project: graphColors.queued,
  concept: graphColors.success,
  topic: graphColors.success,
  tool: '#f7c25a',
  technology: '#f7c25a',
  place: '#f5c469',
  location: '#f5c469',
  event: graphColors.blocked,
  preference: graphColors.amber,
  fact: graphColors.success
}

const fallbackPalette: readonly string[] = [
  graphColors.amber,
  graphColors.info,
  graphColors.queued,
  graphColors.success,
  graphColors.blocked,
  '#f7c25a'
]

/** Deterministic color for an entity type — curated first, hashed fallback. */
export function entityColor(type: string): string {
  const key = type.trim().toLowerCase()
  const known = entityTypeColors[key]
  if (known) return known
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return fallbackPalette[Math.abs(hash) % fallbackPalette.length]
}

/** Human label for a relation provenance, defensive against unknown strings. */
export const provenanceLabels: Record<string, string> = {
  extracted: 'Extracted',
  inferred: 'Inferred',
  ambiguous: 'Ambiguous'
}

/** Badge tint per provenance — solid green for stated facts, dimmer for derived. */
export const provenanceBadgeClass: Record<string, string> = {
  extracted: 'bg-status-success/15 text-status-success',
  inferred: 'bg-status-info/15 text-status-info',
  ambiguous: 'bg-ink-750 text-fg-muted'
}

/**
 * SVG stroke dash pattern per provenance: solid for `extracted` (stated
 * outright), dashed for derived/uncertain edges (`inferred` / `ambiguous`).
 */
export function provenanceDash(provenance: string): string | undefined {
  return provenance === 'extracted' ? undefined : '5 4'
}
