import { randomUUID } from 'node:crypto'
import type { SunnyDatabase } from '@main/db'
import type { Run, RunStatus } from '@shared/db/types'

// Repository for `runs` (migration 006 puts the previously-unwritten table to
// work). A run row IS one agent execution: the heartbeat creates it when an
// agent starts working a task, its id becomes the value the task is locked by
// (`tasks.locked_by`), and it anchors the captured cost. DB type is imported
// type-only so the native binding is never loaded here.

export interface RunCreateInput {
  id?: string
  agentId?: string | null
  projectId?: string | null
  chatId?: string | null
  taskId?: string | null
  goalId?: string | null
  parentRunId?: string | null
  provider?: string | null
  model?: string | null
  // The run begins life as 'running' (a heartbeat is actively executing it).
  status?: RunStatus
  input?: string | null
  heartbeatSeq?: number
}

export interface RunFinishInput {
  // Terminal status: succeeded | failed | cancelled | blocked.
  status: RunStatus
  output?: string | null
  error?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  costUsd?: number | null
}

export class RunsRepo {
  private readonly db: SunnyDatabase
  private readonly insertStmt
  private readonly getStmt

  constructor(db: SunnyDatabase) {
    this.db = db
    this.insertStmt = db.prepare(
      `INSERT INTO runs
         (id, agent_id, project_id, chat_id, task_id, parent_run_id, status, input, output, error,
          started_at, finished_at, created_at, updated_at,
          goal_id, heartbeat_seq, prompt_tokens, completion_tokens, cost_usd, provider, model)
       VALUES
         (@id, @agent_id, @project_id, @chat_id, @task_id, @parent_run_id, @status, @input, @output, @error,
          @started_at, @finished_at, @created_at, @updated_at,
          @goal_id, @heartbeat_seq, @prompt_tokens, @completion_tokens, @cost_usd, @provider, @model)`
    )
    this.getStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`)
  }

  get(id: string): Run | null {
    return (this.getStmt.get(id) as Run | undefined) ?? null
  }

  // Open a run. Defaults to 'running' with started_at set now — the heartbeat
  // creates the run, then claims the task with its id (see TasksRepo.checkout).
  create(input: RunCreateInput): Run {
    const now = new Date().toISOString()
    const status: RunStatus = input.status ?? 'running'
    const row: Run = {
      id: input.id ?? randomUUID(),
      agent_id: input.agentId ?? null,
      project_id: input.projectId ?? null,
      chat_id: input.chatId ?? null,
      task_id: input.taskId ?? null,
      parent_run_id: input.parentRunId ?? null,
      status,
      input: input.input ?? null,
      output: null,
      error: null,
      started_at: status === 'queued' ? null : now,
      finished_at: null,
      goal_id: input.goalId ?? null,
      heartbeat_seq: input.heartbeatSeq ?? 0,
      prompt_tokens: null,
      completion_tokens: null,
      cost_usd: null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      created_at: now,
      updated_at: now
    }
    this.insertStmt.run(row)
    return row
  }

  // Close a run: set its terminal status, output/error, finished_at, and any
  // captured cost. Cost stays null until token capture lands (a later phase).
  finish(id: string, input: RunFinishInput): void {
    this.db
      .prepare(
        `UPDATE runs SET
           status = @status,
           output = COALESCE(@output, output),
           error = COALESCE(@error, error),
           prompt_tokens = COALESCE(@prompt_tokens, prompt_tokens),
           completion_tokens = COALESCE(@completion_tokens, completion_tokens),
           cost_usd = COALESCE(@cost_usd, cost_usd),
           finished_at = @finished_at,
           updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        status: input.status,
        output: input.output ?? null,
        error: input.error ?? null,
        prompt_tokens: input.promptTokens ?? null,
        completion_tokens: input.completionTokens ?? null,
        cost_usd: input.costUsd ?? null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
  }

  // Month-to-date spend across ALL runs (worker + chat), for the budget gate
  // and the Settings Budget section. `monthStartIso` = first instant of the
  // current month (the caller computes it so this stays pure SQL).
  monthSpend(monthStartIso: string): { usd: number; tokensIn: number; tokensOut: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS usd,
                COALESCE(SUM(prompt_tokens), 0) AS tokensIn,
                COALESCE(SUM(completion_tokens), 0) AS tokensOut
         FROM runs WHERE started_at >= ?`
      )
      .get(monthStartIso) as { usd: number; tokensIn: number; tokensOut: number }
    return row
  }

  // Trailing consecutive 'failed' runs for a task, newest first — the retry
  // policy's attempt counter. 'cancelled' runs (a checkout-race loser) neither
  // count nor break the streak; any other terminal status (succeeded/blocked)
  // ends it. Bounded scan: the cap is small, so LIMIT 10 is plenty.
  consecutiveFailures(taskId: string): number {
    const rows = this.db
      .prepare(
        `SELECT status FROM runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 10`
      )
      .all(taskId) as Array<{ status: string }>
    let count = 0
    for (const row of rows) {
      if (row.status === 'failed') count++
      else if (row.status === 'cancelled') continue
      else break
    }
    return count
  }

  // Fail every still-'running' run in one statement. Called at worker startup:
  // the worker is single-process, so any run left 'running' at boot is stale (the
  // app quit mid-run) — leaving it open pollutes the org chart's live-run join.
  // Returns how many rows were recovered.
  failAllRunning(reason: string): number {
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'failed', error = @reason, finished_at = @now, updated_at = @now
         WHERE status = 'running'`
      )
      .run({ reason, now })
    return result.changes
  }

  setStatus(id: string, status: RunStatus): void {
    this.db
      .prepare(`UPDATE runs SET status = @status, updated_at = @updated_at WHERE id = @id`)
      .run({ id, status, updated_at: new Date().toISOString() })
  }
}
