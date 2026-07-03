import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Memory, MemoryEntity, MemoryRelation } from '@shared/db/types'

// Knowledge-graph repository (spec §5, migration 002). Layers a Graphify-style
// graph over the existing `memories` (observations) + `memory_vectors`
// (embeddings): entities are NODES, relations are EDGES, and entity_mentions
// link observations to the entities they mention. sqlite-vec gives KNN over
// observation embeddings for retrieval, which the orchestrator expands 1-hop
// across the graph.
//
// Receives a live better-sqlite3 handle; the DB type is imported type-only so
// this module never loads the native binding (and the pure helper below can be
// unit-tested under Vitest). Fixed prepared statements are built once per
// instance; list/graph statements are built dynamically because their WHERE
// clause depends on which filters were supplied.

// --- Public helper ---------------------------------------------------------

/**
 * Canonical merge key for an entity name: trim, collapse internal whitespace to
 * single spaces, and lowercase. Pure (no DB) so extraction and dedup agree on
 * the same key and so it is unit-testable without the native binding.
 */
export function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

// --- Input shapes ----------------------------------------------------------

export interface UpsertEntityInput {
  name: string
  type?: string
  summary?: string
  scope?: string
  scopeRef?: string
  projectId?: string
}

export interface ListEntitiesInput {
  scope?: string
  projectId?: string
  limit?: number
}

export interface AddRelationInput {
  sourceId: string
  targetId: string
  relation: string
  provenance?: string
  weight?: number
  sourceMemoryId?: string
}

export interface ListRelationsInput {
  limit?: number
}

export interface GraphInput {
  scope?: string
  projectId?: string
  limit?: number
}

const DEFAULT_GRAPH_LIMIT = 200

export class MemoryGraphRepo {
  private readonly db: SunnyDatabase

  private readonly insertEntityStmt
  private readonly getEntityStmt
  private readonly findByNormalizedStmt
  private readonly findByNormalizedScopeStmt
  private readonly updateEntityOnHitStmt

  private readonly insertRelationStmt
  private readonly findRelationStmt
  private readonly bumpRelationStmt
  private readonly listRelationsStmt
  private readonly relationsForEntityStmt

  private readonly insertMentionStmt
  private readonly observationsForEntityStmt

  private readonly countEntitiesStmt
  private readonly countRelationsStmt

  private readonly deleteVectorStmt
  private readonly insertVectorStmt
  private readonly markEmbeddedStmt
  private readonly knnStmt

  constructor(db: SunnyDatabase) {
    this.db = db

    // --- entities ---
    this.insertEntityStmt = db.prepare(
      `INSERT INTO memory_entities
         (id, name, normalized_name, type, summary, scope, scope_ref, project_id, mention_count, created_at, updated_at)
       VALUES
         (@id, @name, @normalized_name, @type, @summary, @scope, @scope_ref, @project_id, @mention_count, @created_at, @updated_at)`
    )
    this.getEntityStmt = db.prepare(`SELECT * FROM memory_entities WHERE id = ?`)
    this.findByNormalizedStmt = db.prepare(
      `SELECT * FROM memory_entities WHERE normalized_name = ? LIMIT 1`
    )
    this.findByNormalizedScopeStmt = db.prepare(
      `SELECT * FROM memory_entities WHERE normalized_name = ? AND scope = ? LIMIT 1`
    )
    this.updateEntityOnHitStmt = db.prepare(
      `UPDATE memory_entities
         SET mention_count = mention_count + 1, summary = @summary, updated_at = @updated_at
       WHERE id = @id`
    )

    // --- relations ---
    this.insertRelationStmt = db.prepare(
      `INSERT INTO memory_relations
         (id, source_id, target_id, relation, provenance, weight, source_memory_id, valid, created_at, updated_at)
       VALUES
         (@id, @source_id, @target_id, @relation, @provenance, @weight, @source_memory_id, 1, @created_at, @updated_at)`
    )
    this.findRelationStmt = db.prepare(
      `SELECT * FROM memory_relations
       WHERE source_id = ? AND target_id = ? AND relation = ? LIMIT 1`
    )
    this.bumpRelationStmt = db.prepare(
      `UPDATE memory_relations
         SET weight = weight + @increment, updated_at = @updated_at
       WHERE id = @id`
    )
    this.listRelationsStmt = db.prepare(
      `SELECT * FROM memory_relations WHERE valid = 1 ORDER BY updated_at DESC LIMIT ?`
    )
    this.relationsForEntityStmt = db.prepare(
      `SELECT * FROM memory_relations
       WHERE valid = 1 AND (source_id = @id OR target_id = @id)
       ORDER BY updated_at DESC`
    )

    // --- mentions / observations ---
    this.insertMentionStmt = db.prepare(
      `INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id, created_at)
       VALUES (@memory_id, @entity_id, @created_at)`
    )
    this.observationsForEntityStmt = db.prepare(
      `SELECT m.* FROM memories m
       JOIN memory_entity_mentions me ON me.memory_id = m.id
       WHERE me.entity_id = ?
       ORDER BY m.created_at DESC
       LIMIT ?`
    )

    // --- counts ---
    this.countEntitiesStmt = db.prepare(`SELECT COUNT(*) AS n FROM memory_entities`)
    this.countRelationsStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM memory_relations WHERE valid = 1`
    )

    // --- sqlite-vec (vec0) ---
    // memory_id is the vec0 primary key, so an upsert is delete-then-insert.
    this.deleteVectorStmt = db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`)
    this.insertVectorStmt = db.prepare(
      `INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)`
    )
    this.markEmbeddedStmt = db.prepare(`UPDATE memories SET embedded = 1 WHERE id = ?`)
    // vec0 KNN: the query vector goes through a MATCH constraint; ascending
    // distance with a LIMIT bounds k. (vec0 also accepts `k = ?`; LIMIT is the
    // supported form here.)
    this.knnStmt = db.prepare(
      `SELECT memory_id, distance, vec_to_json(embedding) AS vector FROM memory_vectors
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
  }

  // --- entities ------------------------------------------------------------

  /**
   * Insert or merge an entity, deduping by (normalized_name, scope). On a hit:
   * bump mention_count, adopt the incoming summary when it is a non-empty
   * improvement (prefer the longer / a non-null over null), and touch
   * updated_at. On a miss: insert with mention_count = 1 and default type
   * 'concept'.
   */
  upsertEntity(input: UpsertEntityInput): MemoryEntity {
    const scope = input.scope ?? 'global'
    const normalized = normalizeEntityName(input.name)
    const now = new Date().toISOString()

    const existing = this.findByNormalizedScopeStmt.get(normalized, scope) as
      | MemoryEntity
      | undefined

    if (existing) {
      const incoming = input.summary?.trim() ? input.summary : null
      const nextSummary = preferSummary(existing.summary, incoming)
      this.updateEntityOnHitStmt.run({ id: existing.id, summary: nextSummary, updated_at: now })
      return {
        ...existing,
        summary: nextSummary,
        mention_count: existing.mention_count + 1,
        updated_at: now
      }
    }

    const row: MemoryEntity = {
      id: randomUUID(),
      name: input.name,
      normalized_name: normalized,
      type: input.type ?? 'concept',
      summary: input.summary?.trim() ? input.summary : null,
      scope: scope as MemoryEntity['scope'],
      scope_ref: input.scopeRef ?? null,
      project_id: input.projectId ?? null,
      mention_count: 1,
      created_at: now,
      updated_at: now
    }
    this.insertEntityStmt.run(row)
    return row
  }

  getEntity(id: string): MemoryEntity | null {
    return (this.getEntityStmt.get(id) as MemoryEntity | undefined) ?? null
  }

  findByNormalizedName(normalizedName: string, scope?: string): MemoryEntity | null {
    const row =
      scope === undefined
        ? this.findByNormalizedStmt.get(normalizedName)
        : this.findByNormalizedScopeStmt.get(normalizedName, scope)
    return (row as MemoryEntity | undefined) ?? null
  }

  listEntities(input?: ListEntitiesInput): MemoryEntity[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}

    if (input?.scope) {
      clauses.push(`scope = @scope`)
      params.scope = input.scope
    }
    if (input?.projectId) {
      clauses.push(`project_id = @project_id`)
      params.project_id = input.projectId
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = `LIMIT ${clampLimit(input?.limit)}`
    const stmt = this.db.prepare(
      `SELECT * FROM memory_entities ${where} ORDER BY mention_count DESC, updated_at DESC ${limit}`
    )
    return stmt.all(params) as MemoryEntity[]
  }

  // --- relations -----------------------------------------------------------

  /**
   * Insert or merge an edge, deduping on (source_id, target_id, relation). On a
   * hit: add the incoming weight (default 1) and touch updated_at. On a miss:
   * insert valid = 1 with default provenance 'extracted'.
   */
  addRelation(input: AddRelationInput): MemoryRelation {
    const now = new Date().toISOString()
    const weight = input.weight ?? 1

    const existing = this.findRelationStmt.get(input.sourceId, input.targetId, input.relation) as
      | MemoryRelation
      | undefined

    if (existing) {
      this.bumpRelationStmt.run({ id: existing.id, increment: weight, updated_at: now })
      return { ...existing, weight: existing.weight + weight, updated_at: now }
    }

    const row: MemoryRelation = {
      id: randomUUID(),
      source_id: input.sourceId,
      target_id: input.targetId,
      relation: input.relation,
      provenance: input.provenance ?? 'extracted',
      weight,
      source_memory_id: input.sourceMemoryId ?? null,
      valid: 1,
      created_at: now,
      updated_at: now
    }
    this.insertRelationStmt.run(row)
    return row
  }

  listRelations(input?: ListRelationsInput): MemoryRelation[] {
    return this.listRelationsStmt.all(clampLimit(input?.limit)) as MemoryRelation[]
  }

  relationsForEntity(entityId: string): MemoryRelation[] {
    return this.relationsForEntityStmt.all({ id: entityId }) as MemoryRelation[]
  }

  // --- mentions / observations ---------------------------------------------

  linkMention(memoryId: string, entityId: string): void {
    this.insertMentionStmt.run({
      memory_id: memoryId,
      entity_id: entityId,
      created_at: new Date().toISOString()
    })
  }

  observationsForEntity(entityId: string, limit?: number): Memory[] {
    return this.observationsForEntityStmt.all(entityId, clampLimit(limit)) as Memory[]
  }

  /**
   * Fetch observation (memory) rows by id — used by retrieval to turn KNN hits
   * (which return memory_ids) into full rows. Order is not guaranteed; the
   * caller re-orders by KNN distance.
   */
  observationsByIds(ids: string[]): Memory[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    return stmt.all(...ids) as Memory[]
  }

  // --- graph view ----------------------------------------------------------

  /**
   * The graph slice the orchestrator renders/expands: the top `limit` entities
   * by mention_count (filtered by scope/project), plus every valid relation
   * whose BOTH endpoints fall inside that entity set.
   */
  graph(input?: GraphInput): { entities: MemoryEntity[]; relations: MemoryRelation[] } {
    const limit = input?.limit ?? DEFAULT_GRAPH_LIMIT
    const entities = this.listEntities({
      scope: input?.scope,
      projectId: input?.projectId,
      limit
    })

    if (entities.length === 0) {
      return { entities, relations: [] }
    }

    const ids = new Set(entities.map((e) => e.id))
    const placeholders = entities.map(() => '?').join(', ')
    const idList = entities.map((e) => e.id)
    const stmt = this.db.prepare(
      `SELECT * FROM memory_relations
       WHERE valid = 1 AND source_id IN (${placeholders}) AND target_id IN (${placeholders})
       ORDER BY weight DESC, updated_at DESC`
    )
    const relations = (stmt.all(...idList, ...idList) as MemoryRelation[]).filter(
      (r) => ids.has(r.source_id) && ids.has(r.target_id)
    )

    return { entities, relations }
  }

  counts(): { entities: number; relations: number; observations: number } {
    const entities = (this.countEntitiesStmt.get() as { n: number }).n
    const relations = (this.countRelationsStmt.get() as { n: number }).n
    const observations = (
      this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as {
        n: number
      }
    ).n
    return { entities, relations, observations }
  }

  // --- sqlite-vec embeddings ----------------------------------------------

  /**
   * Write (replace) the observation's embedding into the vec0 mirror and flag
   * the memory as embedded. The vector is passed to sqlite-vec as JSON text
   * ('[...]'), the form vec0 accepts for a FLOAT[] column. Because memory_id is
   * the vec0 primary key, any existing row is deleted first.
   */
  setObservationEmbedding(memoryId: string, embedding: number[]): void {
    const json = JSON.stringify(embedding)
    const tx = this.db.transaction(() => {
      this.deleteVectorStmt.run(memoryId)
      this.insertVectorStmt.run(memoryId, json)
      this.markEmbeddedStmt.run(memoryId)
    })
    tx()
  }

  /**
   * KNN over observation embeddings, ascending by distance. The query vector is
   * passed as JSON text through the vec0 MATCH constraint; LIMIT bounds k. Also
   * returns each hit's stored vector (as `vector`) so the caller can compute a
   * model-agnostic cosine relevance score and drop off-topic hits — vec0's raw
   * distance is L2 on unnormalized vectors, which isn't comparable across models.
   */
  knnObservations(
    embedding: number[],
    k: number
  ): Array<{ memoryId: string; distance: number; vector: number[] }> {
    const json = JSON.stringify(embedding)
    const rows = this.knnStmt.all(json, k) as Array<{
      memory_id: string
      distance: number
      vector: string
    }>
    return rows.map((r) => {
      let vector: number[] = []
      try {
        const parsed = JSON.parse(r.vector) as unknown
        if (Array.isArray(parsed)) vector = parsed as number[]
      } catch {
        // Leave empty; the caller treats an unscorable hit as "can't gate".
      }
      return { memoryId: r.memory_id, distance: r.distance, vector }
    })
  }
}

// Prefer a non-empty, more-informative summary: keep whichever of the two is
// the longer non-null string; fall back to the existing one when nothing better
// arrives.
function preferSummary(existing: string | null, incoming: string | null): string | null {
  if (!incoming) {
    return existing
  }
  if (!existing) {
    return incoming
  }
  return incoming.length > existing.length ? incoming : existing
}

// Coerce a caller limit to a safe positive integer, defaulting to 100.
function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return 100
  }
  return Math.floor(limit)
}
