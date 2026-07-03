import type { Migration, MigrationDb } from '../migrate'

// Knowledge-graph memory (spec §5, Graphify-inspired). Layers a graph on top of
// the existing `memories` (observations/facts) + `memory_vectors` (embeddings):
//
//   memory_entities       — graph NODES (people, projects, tech, concepts, …)
//   memory_relations      — graph EDGES (subject -relation-> object), with a
//                           provenance tag (extracted | inferred | ambiguous),
//                           mirroring Graphify's EXTRACTED/INFERRED labelling
//   memory_entity_mentions — links an observation (memories row) to the entities
//                           it mentions, so semantic hits on observations can be
//                           expanded across the graph during retrieval
//
// Extraction (LLM, your own model) populates these from chat turns; retrieval
// does vector KNN over observations + 1-hop graph expansion and injects the
// result into the next turn. All local — nothing leaves the machine except the
// model calls the user already configured.
function up(db: MigrationDb): void {
  db.exec(`
    CREATE TABLE memory_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      -- Lowercased/trimmed name for dedup + fast lookup (entity merge key).
      normalized_name TEXT NOT NULL,
      -- Free-form kind, e.g. person | project | technology | concept |
      -- preference | organization | task. Kept as TEXT so extraction can add
      -- kinds without a migration.
      type TEXT NOT NULL DEFAULT 'concept',
      summary TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      scope_ref TEXT,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      -- How many observations have mentioned this entity (salience signal).
      mention_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_memory_entities_normalized ON memory_entities(normalized_name)`)
  db.exec(`CREATE INDEX idx_memory_entities_type ON memory_entities(type)`)
  db.exec(`CREATE INDEX idx_memory_entities_project_id ON memory_entities(project_id)`)
  db.exec(`CREATE INDEX idx_memory_entities_scope ON memory_entities(scope)`)

  db.exec(`
    CREATE TABLE memory_relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
      -- The predicate, e.g. 'works_on', 'uses', 'prefers', 'depends_on'.
      relation TEXT NOT NULL,
      -- Provenance (Graphify-style): 'extracted' (from explicit statement),
      -- 'inferred' (model-derived), or 'ambiguous'.
      provenance TEXT NOT NULL DEFAULT 'extracted',
      weight REAL NOT NULL DEFAULT 1,
      -- The observation this edge was derived from (audit trail).
      source_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
      -- Soft-invalidation so superseded facts can be retired without deletion.
      valid INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_memory_relations_source ON memory_relations(source_id)`)
  db.exec(`CREATE INDEX idx_memory_relations_target ON memory_relations(target_id)`)
  db.exec(`CREATE INDEX idx_memory_relations_valid ON memory_relations(valid)`)

  db.exec(`
    CREATE TABLE memory_entity_mentions (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, entity_id)
    )
  `)
  db.exec(`CREATE INDEX idx_memory_mentions_entity ON memory_entity_mentions(entity_id)`)
}

export const migration002: Migration = {
  version: 2,
  name: 'memory_graph',
  up
}
