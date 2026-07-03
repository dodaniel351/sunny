import type { Migration, MigrationDb } from '../migrate'

// The "structure layer" (a Paperclip-inspired org/governance model on top of the
// existing agents + board). One additive migration: every change is a new table
// or a nullable/defaulted column, so existing rows migrate cleanly and a half-
// applied state is impossible (the runner wraps each migration in a transaction).
//
// ORDER MATTERS inside up(): a CREATE TABLE that an ALTER … ADD COLUMN references
// (budgets, goals) must run BEFORE that ALTER. SQLite allows ADD COLUMN with a
// REFERENCES clause only when the new column's default is NULL — all our added
// FK columns are nullable with no default, so they satisfy that rule.
//
// Phase 1 actively uses: runs.* (execution records + locks), tasks lock columns,
// and activity_events. The remaining tables/columns (goals, budgets,
// task_dependencies, cost_events, approvals, agent hierarchy) are created here so
// later phases are pure code — no second schema migration.
function up(db: MigrationDb): void {
  // --- budgets (no FK to new tables; created first) ------------------------
  db.exec(`
    CREATE TABLE budgets (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,              -- global | project | goal | agent | task
      scope_ref TEXT,                   -- id of the scoped entity; NULL for global
      limit_usd REAL,                   -- hard stop
      warn_usd REAL,                    -- warning threshold
      period TEXT NOT NULL DEFAULT 'total',  -- total | daily | monthly
      spent_usd REAL NOT NULL DEFAULT 0,     -- denormalized running total (reconciled from cost_events)
      state TEXT NOT NULL DEFAULT 'ok',      -- ok | warned | exceeded
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_budgets_scope ON budgets(scope, scope_ref)`)

  // --- goals (objective → goal ancestry above the board) -------------------
  db.exec(`
    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      parent_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,  -- objective→goal chain
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',  -- active | achieved | abandoned
      owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      budget_id TEXT REFERENCES budgets(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_goals_parent ON goals(parent_goal_id)`)
  db.exec(`CREATE INDEX idx_goals_project ON goals(project_id)`)

  // --- agents: reporting lines + scoped budget + lifecycle -----------------
  db.exec(`ALTER TABLE agents ADD COLUMN manager_id TEXT REFERENCES agents(id) ON DELETE SET NULL`)
  db.exec(`ALTER TABLE agents ADD COLUMN title TEXT`)
  db.exec(`ALTER TABLE agents ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'`)
  db.exec(`ALTER TABLE agents ADD COLUMN budget_id TEXT REFERENCES budgets(id) ON DELETE SET NULL`)
  db.exec(`CREATE INDEX idx_agents_manager_id ON agents(manager_id)`)

  // --- tasks: goal link + execution-lock / wakeup-queue columns ------------
  db.exec(`ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL`)
  db.exec(`ALTER TABLE tasks ADD COLUMN locked_by TEXT`) // run id holding the checkout lock; NULL = free
  db.exec(`ALTER TABLE tasks ADD COLUMN locked_at TEXT`) // ISO; lets a stale lock be reclaimed
  db.exec(`ALTER TABLE tasks ADD COLUMN wake_at TEXT`) // ISO; DB-backed wakeup queue (heartbeat)
  db.exec(`ALTER TABLE tasks ADD COLUMN context_ref TEXT`) // chat id the agent resumes across heartbeats
  db.exec(`CREATE INDEX idx_tasks_goal_id ON tasks(goal_id)`)
  db.exec(`CREATE INDEX idx_tasks_wake_at ON tasks(wake_at)`)
  db.exec(`CREATE INDEX idx_tasks_locked_by ON tasks(locked_by)`)

  // --- runs: the (until now unwritten) execution record + cost anchor ------
  db.exec(`ALTER TABLE runs ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL`)
  db.exec(`ALTER TABLE runs ADD COLUMN heartbeat_seq INTEGER NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE runs ADD COLUMN prompt_tokens INTEGER`)
  db.exec(`ALTER TABLE runs ADD COLUMN completion_tokens INTEGER`)
  db.exec(`ALTER TABLE runs ADD COLUMN cost_usd REAL`)
  db.exec(`ALTER TABLE runs ADD COLUMN provider TEXT`)
  db.exec(`ALTER TABLE runs ADD COLUMN model TEXT`)

  // --- task_dependencies (first-class blocker edges) -----------------------
  db.exec(`
    CREATE TABLE task_dependencies (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,            -- the blocked task
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, -- the blocker
      kind TEXT NOT NULL DEFAULT 'blocks',  -- blocks | relates
      created_at TEXT NOT NULL,
      UNIQUE(task_id, depends_on_task_id)
    )
  `)
  db.exec(`CREATE INDEX idx_taskdeps_task ON task_dependencies(task_id)`)
  db.exec(`CREATE INDEX idx_taskdeps_dep ON task_dependencies(depends_on_task_id)`)

  // --- cost_events (append-only spend ledger, every dimension) -------------
  db.exec(`
    CREATE TABLE cost_events (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_cost_run ON cost_events(run_id)`)
  db.exec(`CREATE INDEX idx_cost_agent ON cost_events(agent_id)`)
  db.exec(`CREATE INDEX idx_cost_task ON cost_events(task_id)`)
  db.exec(`CREATE INDEX idx_cost_created ON cost_events(created_at)`)

  // --- activity_events (durable, generalized audit log) --------------------
  // Generalizes task_events: every mutating action, run state change, cost
  // event, and approval lands here so the Activity view can replay what
  // happened and why. task_events stays for the existing Live Activity pane.
  db.exec(`
    CREATE TABLE activity_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,            -- task.created | task.moved | task.claimed | run.started | run.finished | run.failed | ...
      actor TEXT,                    -- user id or agent name
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      payload TEXT,                  -- JSON detail blob (carries a denormalized summary for the feed)
      created_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_activity_kind ON activity_events(kind)`)
  db.exec(`CREATE INDEX idx_activity_created ON activity_events(created_at)`)
  db.exec(`CREATE INDEX idx_activity_task ON activity_events(task_id)`)
  db.exec(`CREATE INDEX idx_activity_project ON activity_events(project_id)`)

  // --- approvals (gates before side-effects ship; decision tracking) -------
  db.exec(`
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      gate TEXT NOT NULL,            -- tool:write_file | stage:review | budget_override | ...
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX idx_approvals_status ON approvals(status)`)
  db.exec(`CREATE INDEX idx_approvals_task ON approvals(task_id)`)
}

export const migration006: Migration = {
  version: 6,
  name: 'org_layer',
  up
}
