import type { SunnyDatabase } from '@main/db'
import type { SettingsRepo } from '@main/repositories'

// The sqlite-vec `memory_vectors` table has a FIXED dimension (set at creation).
// Different embedders produce different dims (OpenAI text-embedding-3-small =
// 1536, Ollama nomic-embed-text = 768, …), and vectors from one model are
// meaningless in another's space — so when the active embedder's dimension
// changes we recreate the table at the new dim and mark observations for
// re-embedding. The chosen dim is persisted in `settings` under this key.

const DIM_SETTING = 'embedding_dim'
const DEFAULT_DIM = 1536

/** Validate a dimension is a sane positive integer (it's interpolated into DDL). */
function safeDim(dim: number): number {
  const n = Math.floor(dim)
  if (!Number.isFinite(n) || n < 1 || n > 16384) {
    throw new Error(`Invalid embedding dimension: ${dim}`)
  }
  return n
}

/**
 * Ensure `memory_vectors` matches `targetDim`. No-op when already aligned;
 * otherwise drop + recreate the vec0 table (the extension is loaded on this
 * connection) and reset `memories.embedded` so retrieval re-embeds lazily on the
 * next capture. Safe because switching embedding models invalidates every stored
 * vector regardless.
 */
export function reconcileVectorDimension(
  db: SunnyDatabase,
  settings: SettingsRepo,
  targetDim: number
): void {
  const target = safeDim(targetDim)
  const stored = Number(settings.get(DIM_SETTING) ?? String(DEFAULT_DIM))
  if (stored === target) return

  const tx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS memory_vectors')
    db.exec(
      `CREATE VIRTUAL TABLE memory_vectors USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[${target}])`
    )
    db.exec('UPDATE memories SET embedded = 0')
    settings.set(DIM_SETTING, String(target))
  })
  tx()
}
