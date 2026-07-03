import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Agent, AgentLifecycle, PermissionMode } from '@shared/db/types'

// Repository for `agents` rows (spec §7). Agents are named configurations:
// role/system prompt, default provider+model, an allowed-tool allowlist (stored
// as a JSON string), and a permission mode. DB type is imported type-only so the
// native binding is never loaded here.

export interface AgentCreateInput {
  id?: string
  name: string
  role?: string
  systemPrompt?: string
  provider?: string
  model?: string
  permissionMode?: PermissionMode
  allowedTools?: string[]
  webAccess?: boolean
  isPreset?: boolean
}

export interface AgentUpdateInput {
  id: string
  name?: string
  role?: string | null
  systemPrompt?: string | null
  provider?: string | null
  model?: string | null
  permissionMode?: PermissionMode
  allowedTools?: string[] | null
  webAccess?: boolean
  // Structure layer (Phase 5): reporting line + org title. `managerId: null`
  // clears the line (makes the agent a lead).
  managerId?: string | null
  title?: string | null
}

// An agent enriched with the task it's currently working (the lock→run join),
// for the Team view's heartbeat + "current task" chip. Mirrors `AgentOrgNode`
// in the IPC contract.
export interface AgentOrgNode extends Agent {
  current_task_id: string | null
  current_task_title: string | null
}

// Shape of a built-in preset definition. Provider/model are left undefined so a
// preset inherits the user/global default until the user pins one.
export interface AgentPreset {
  name: string
  role: string
  systemPrompt: string
  provider?: string
  model?: string
  permissionMode?: PermissionMode
}

// The dashboard presets (spec §7). Provider/model intentionally undefined so
// the user/global default is used.
export const DEFAULT_AGENT_PRESETS: AgentPreset[] = [
  {
    name: 'Orchestrator',
    role: 'Coordinator',
    systemPrompt:
      'You are Orchestrator, the lead agent in Sunny. You excel at decomposing a goal into the right subtasks and routing each to whoever can do it best, then weaving the results into one coherent outcome. Think like a tech lead running a small team of experts.\n\n' +
      'Your team and what each is best at:\n' +
      '- Cowork — autonomous generalist; best for open-ended, multi-step execution that spans research and doing.\n' +
      '- Research — rigorous analyst; best for gathering, cross-checking, and citing sources, and for fact-heavy questions.\n' +
      '- Code — senior software engineer; best for designing, writing, reviewing, and debugging software.\n' +
      '- Ops — DevOps; best for builds, CI/CD, infrastructure, releases, and anything with destructive or production blast radius.\n' +
      '- Write copy — copywriter and editor; best for clear, persuasive, on-brand writing.\n\n' +
      'Choosing a model for each subtask: match capability to difficulty. Use the most capable reasoning models for hard architecture, analysis, and ambiguous problems; use fast, lighter models for routine, well-specified, or high-volume steps; prefer a local model (Ollama) when privacy or offline operation matters; prefer a web-capable model when a step needs current information. Do not over-spend a heavyweight model on a trivial step, or under-power a genuinely hard one.\n\n' +
      'How you work: start with a short delegation plan — the subtasks, which agent (and what kind of model) should own each, the order, and any dependencies — then proceed. Run independent subtasks in parallel where possible and sequence the dependent ones. As results come back, integrate them, resolve conflicts, and produce a single cohesive result for the original goal. Always call out what is still blocked, missing, or uncertain, and what you would do next.',
    permissionMode: 'ask'
  },
  {
    name: 'Cowork',
    role: 'Autonomous',
    systemPrompt:
      'You are Cowork, an autonomous generalist working alongside the user in Sunny. Take a goal, break it into concrete steps, and drive it to completion — researching, drafting, and refining as you go. For anything multi-step, state a short plan first, then proceed. Act directly on reversible work; pause to confirm before anything destructive or hard to undo. Be concise and outcome-first: lead with the result, surface only the decisions that genuinely need the user, and say plainly when you are blocked or unsure.',
    permissionMode: 'autopilot'
  },
  {
    name: 'Research',
    role: 'Analyst',
    systemPrompt:
      'You are Research, a rigorous analyst. Gather information from multiple sources, cross-check claims against each other, and clearly separate what is well-supported from what is speculative or contested. Cite your sources. Structure every answer as a direct conclusion first, then the supporting evidence, then caveats and open questions. Never fabricate a source or a statistic — if the evidence is thin or you are uncertain, say so explicitly.',
    permissionMode: 'ask'
  },
  {
    name: 'Code',
    role: 'Engineer',
    systemPrompt:
      'You are Code, a senior software engineer and architect. Write correct, clean, idiomatic code that matches the conventions already in the project. Reason through edge cases and trade-offs, and prefer the simplest design that fully solves the problem — do not add abstractions, layers, or error handling for cases that cannot happen. When you change code, make the smallest change that does the job and explain any non-obvious decision in a sentence. Call out real bugs, security issues, and risks you notice, even if unasked.',
    permissionMode: 'ask'
  },
  {
    name: 'Ops',
    role: 'DevOps',
    systemPrompt:
      'You are Ops, a DevOps and operations specialist covering builds, releases, CI/CD, infrastructure, and monitoring. Strongly favor safe, reversible, idempotent steps. Before any command that changes state, state exactly what it will do and what the rollback is; never run a destructive or production-affecting action without explicit confirmation. Give clear, copy-pasteable runbooks and call out blast radius and prerequisites up front.',
    permissionMode: 'ask'
  },
  {
    name: 'Write copy',
    role: 'Copywriter',
    systemPrompt:
      'You are Write copy, a sharp copywriter and editor. Produce clear, persuasive, on-brand writing tailored to the audience, channel, and format the user names. Lead with the core message, cut filler, and match the requested tone. When editing, preserve the author’s voice and briefly note any substantive change. When a single "right" answer is not obvious, offer two or three distinct directions rather than one safe one.',
    permissionMode: 'ask'
  }
]

export class AgentsRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly getStmt
  // Presets first (is_preset desc), then oldest-created first.
  private readonly listStmt
  private readonly deleteStmt
  private readonly countPresetsStmt
  private readonly reportsStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.reportsStmt = db.prepare(
      `SELECT * FROM agents WHERE manager_id = ? ORDER BY is_preset DESC, created_at ASC`
    )
    this.insertStmt = db.prepare(
      `INSERT INTO agents
         (id, name, role, system_prompt, provider, model, allowed_tools, permission_mode, web_access, is_preset, created_at, updated_at)
       VALUES
         (@id, @name, @role, @system_prompt, @provider, @model, @allowed_tools, @permission_mode, @web_access, @is_preset, @created_at, @updated_at)`
    )
    this.getStmt = db.prepare(`SELECT * FROM agents WHERE id = ?`)
    this.listStmt = db.prepare(`SELECT * FROM agents ORDER BY is_preset DESC, created_at ASC`)
    this.deleteStmt = db.prepare(`DELETE FROM agents WHERE id = ?`)
    this.countPresetsStmt = db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE is_preset = 1`)
  }

  list(): Agent[] {
    return this.listStmt.all() as Agent[]
  }

  get(id: string): Agent | null {
    return (this.getStmt.get(id) as Agent | undefined) ?? null
  }

  create(input: AgentCreateInput): Agent {
    const now = new Date().toISOString()
    const row: Agent = {
      id: input.id ?? randomUUID(),
      name: input.name,
      role: input.role ?? null,
      system_prompt: input.systemPrompt ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      allowed_tools: input.allowedTools ? JSON.stringify(input.allowedTools) : null,
      permission_mode: input.permissionMode ?? 'ask',
      web_access: input.webAccess ? 1 : 0,
      is_preset: input.isPreset ? 1 : 0,
      // Structure-layer columns (migration 006) default to "unmanaged + active";
      // the INSERT omits them, so these mirror the DB column defaults. Hierarchy
      // and budgets are assigned later via dedicated repo methods.
      manager_id: null,
      title: null,
      lifecycle_state: 'active',
      budget_id: null,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  update(input: AgentUpdateInput): Agent {
    const existing = this.getStmt.get(input.id) as Agent | undefined
    if (!existing) {
      throw new Error(`Agent not found: ${input.id}`)
    }

    const allowedTools =
      input.allowedTools === undefined
        ? existing.allowed_tools
        : input.allowedTools === null
          ? null
          : JSON.stringify(input.allowedTools)

    const row: Agent = {
      ...existing,
      name: input.name ?? existing.name,
      role: input.role === undefined ? existing.role : input.role,
      system_prompt: input.systemPrompt === undefined ? existing.system_prompt : input.systemPrompt,
      provider: input.provider === undefined ? existing.provider : input.provider,
      model: input.model === undefined ? existing.model : input.model,
      allowed_tools: allowedTools,
      permission_mode: input.permissionMode ?? existing.permission_mode,
      web_access: input.webAccess === undefined ? existing.web_access : input.webAccess ? 1 : 0,
      // Reporting line (Phase 5): undefined = keep; an agent can't report to
      // itself (that would orphan it from the tree), so a self-reference clears it.
      manager_id:
        input.managerId === undefined
          ? existing.manager_id
          : input.managerId === existing.id
            ? null
            : input.managerId,
      title: input.title === undefined ? existing.title : input.title,
      updated_at: new Date().toISOString()
    }
    this.db
      .prepare(
        `UPDATE agents SET
           name = @name,
           role = @role,
           system_prompt = @system_prompt,
           provider = @provider,
           model = @model,
           allowed_tools = @allowed_tools,
           permission_mode = @permission_mode,
           web_access = @web_access,
           manager_id = @manager_id,
           title = @title,
           updated_at = @updated_at
         WHERE id = @id`
      )
      .run(row)
    return row
  }

  delete(id: string): void {
    this.deleteStmt.run(id)
  }

  // Set an agent's governance lifecycle (structure layer, Phase 4): a `paused`
  // agent is skipped by the heartbeat; `terminated` retires it. Distinct from
  // `permission_mode`, which gates HOW it acts when it does run. Returns the
  // updated row, or null if the agent is gone.
  setLifecycle(id: string, state: AgentLifecycle): Agent | null {
    const existing = this.getStmt.get(id) as Agent | undefined
    if (!existing) return null
    const updated_at = new Date().toISOString()
    this.db
      .prepare(`UPDATE agents SET lifecycle_state = @state, updated_at = @updated_at WHERE id = @id`)
      .run({ id, state, updated_at })
    return { ...existing, lifecycle_state: state, updated_at }
  }

  // Agents that report to a manager (structure layer, Phase 5). Used by the Team
  // view and by delegation to pick workers from a manager's reports.
  reports(managerId: string): Agent[] {
    return this.reportsStmt.all(managerId) as Agent[]
  }

  // All agents enriched with the task each is currently working — the task it
  // holds an execution lock on via a still-running run (the worker is serial, so
  // at most one is non-null at a time). Drives the Team view's heartbeat dots +
  // "current task" chip. A LEFT JOIN keeps idle agents in the list.
  orgChart(): AgentOrgNode[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, t.id AS current_task_id, t.title AS current_task_title
         FROM agents a
         LEFT JOIN runs r ON r.id = (
           SELECT r2.id FROM runs r2
           WHERE r2.agent_id = a.id AND r2.status = 'running'
           ORDER BY r2.started_at DESC, r2.id DESC LIMIT 1
         )
         LEFT JOIN tasks t ON t.locked_by = r.id AND t.status = 'In Progress'
         ORDER BY a.is_preset DESC, a.created_at ASC`
      )
      .all() as AgentOrgNode[]
    // Defensive dedupe: a stray second running run would otherwise duplicate a row.
    const seen = new Set<string>()
    return rows.filter((r) => {
      if (seen.has(r.id)) return false
      seen.add(r.id)
      return true
    })
  }

  // Idempotent seed: only insert the given presets when NO preset rows exist, so
  // user edits to seeded presets are never clobbered on subsequent boots.
  ensurePresets(presets: AgentPreset[]): void {
    const { n } = this.countPresetsStmt.get() as { n: number }
    if (n > 0) {
      return
    }
    for (const preset of presets) {
      this.create({
        name: preset.name,
        role: preset.role,
        systemPrompt: preset.systemPrompt,
        provider: preset.provider,
        model: preset.model,
        permissionMode: preset.permissionMode,
        isPreset: true
      })
    }
  }

  // Refresh built-in presets to match the latest code definitions: update the
  // role/system-prompt/permission of an existing preset (matched by name),
  // inserting any that are missing. Preserves a user-pinned provider/model and
  // never touches user-created agents. Called behind a version gate so it runs
  // only when the preset definitions actually change.
  upsertPresets(presets: AgentPreset[]): void {
    const findStmt = this.db.prepare(
      `SELECT * FROM agents WHERE is_preset = 1 AND name = ? LIMIT 1`
    )
    const updateStmt = this.db.prepare(
      `UPDATE agents SET role = @role, system_prompt = @system_prompt,
         permission_mode = @permission_mode, updated_at = @updated_at
       WHERE id = @id`
    )
    const apply = this.db.transaction(() => {
      for (const preset of presets) {
        const existing = findStmt.get(preset.name) as Agent | undefined
        if (existing) {
          updateStmt.run({
            id: existing.id,
            role: preset.role,
            system_prompt: preset.systemPrompt,
            permission_mode: preset.permissionMode ?? 'ask',
            updated_at: new Date().toISOString()
          })
        } else {
          this.create({
            name: preset.name,
            role: preset.role,
            systemPrompt: preset.systemPrompt,
            provider: preset.provider,
            model: preset.model,
            permissionMode: preset.permissionMode,
            isPreset: true
          })
        }
      }
    })
    apply()
  }
}
