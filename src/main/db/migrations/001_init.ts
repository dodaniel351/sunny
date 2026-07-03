import type { Migration, MigrationDb } from '../migrate'

// Default embedding dimension for memory_vectors. 1536 = OpenAI
// text-embedding-3-small (spec §5). Configurable later via a setting; changing
// it requires re-embedding, so it lives here as the v1 baseline.
export const DEFAULT_EMBEDDING_DIM = 1536

// The initial v1 schema (spec §10). One migration so a fresh install lands at a
// coherent baseline; future shape changes get their own numbered migrations.
//
// Note on virtual tables: the FTS5 (messages_fts) and sqlite-vec (memory_vectors)
// statements only ever execute against the REAL better-sqlite3 connection where
// the sqlite-vec extension is loaded. The unit test exercises the runner with
// fake migrations, so this SQL never runs under Vitest.
function up(db: MigrationDb): void {
  // --- projects ------------------------------------------------------------
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      columns TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_projects_archived ON projects(archived)`)
  db.exec(`CREATE INDEX idx_projects_updated_at ON projects(updated_at)`)

  // --- agents --------------------------------------------------------------
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      system_prompt TEXT,
      provider TEXT,
      model TEXT,
      allowed_tools TEXT,
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      is_preset INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_agents_is_preset ON agents(is_preset)`)

  // --- chats ---------------------------------------------------------------
  db.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT,
      provider TEXT,
      model TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_chats_project_id ON chats(project_id)`)
  db.exec(`CREATE INDEX idx_chats_updated_at ON chats(updated_at)`)

  // --- runs (declared before messages: messages.run_id references it) ------
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      task_id TEXT,
      parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      input TEXT,
      output TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_runs_agent_id ON runs(agent_id)`)
  db.exec(`CREATE INDEX idx_runs_project_id ON runs(project_id)`)
  db.exec(`CREATE INDEX idx_runs_chat_id ON runs(chat_id)`)
  db.exec(`CREATE INDEX idx_runs_parent_run_id ON runs(parent_run_id)`)
  db.exec(`CREATE INDEX idx_runs_status ON runs(status)`)

  // --- messages ------------------------------------------------------------
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      tool_calls TEXT,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_messages_chat_id ON messages(chat_id)`)
  db.exec(`CREATE INDEX idx_messages_run_id ON messages(run_id)`)
  db.exec(`CREATE INDEX idx_messages_created_at ON messages(created_at)`)

  // Full-text search over transcripts (spec §8). External-content FTS5 table
  // mirrors messages.content; triggers keep it in sync so history search stays
  // current without duplicating storage semantics in app code.
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid'
    )
  `)
  db.exec(`
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `)

  // --- tasks (the Kanban store, spec §6) -----------------------------------
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'Backlog',
      assignee TEXT,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_tasks_project_id ON tasks(project_id)`)
  db.exec(`CREATE INDEX idx_tasks_status ON tasks(status)`)
  db.exec(`CREATE INDEX idx_tasks_parent_task_id ON tasks(parent_task_id)`)
  db.exec(`CREATE INDEX idx_tasks_assignee ON tasks(assignee)`)
  db.exec(`CREATE INDEX idx_tasks_updated_at ON tasks(updated_at)`)

  // --- task_events (transitions, spec §6/§10) ------------------------------
  db.exec(`
    CREATE TABLE task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_task_events_task_id ON task_events(task_id)`)
  db.exec(`CREATE INDEX idx_task_events_created_at ON task_events(created_at)`)

  // --- memories (spec §5) --------------------------------------------------
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'session',
      kind TEXT NOT NULL DEFAULT 'semantic',
      scope_ref TEXT,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      embedded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_memories_scope ON memories(scope)`)
  db.exec(`CREATE INDEX idx_memories_kind ON memories(kind)`)
  db.exec(`CREATE INDEX idx_memories_scope_ref ON memories(scope_ref)`)
  db.exec(`CREATE INDEX idx_memories_project_id ON memories(project_id)`)

  // Semantic retrieval vectors (spec §5). vec0 is provided by the sqlite-vec
  // extension loaded in database.ts. `memory_id` joins back to memories.id;
  // the float[N] column holds the embedding at the default dimension.
  db.exec(`
    CREATE VIRTUAL TABLE memory_vectors USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding FLOAT[${DEFAULT_EMBEDDING_DIM}]
    )
  `)

  // --- providers (config/state ONLY — no secrets, spec §2/§10) -------------
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      auth_method TEXT,
      secret_ref TEXT,
      base_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_providers_kind ON providers(kind)`)
  db.exec(`CREATE INDEX idx_providers_enabled ON providers(enabled)`)

  // --- schedules (spec §7) -------------------------------------------------
  db.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron TEXT,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      payload TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_schedules_enabled ON schedules(enabled)`)
  db.exec(`CREATE INDEX idx_schedules_next_run_at ON schedules(next_run_at)`)

  // --- settings (key/value, spec §10) --------------------------------------
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}

export const migration001: Migration = {
  version: 1,
  name: 'init',
  up
}
