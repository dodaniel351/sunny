// Board-manipulation agent tools (spec §7/§6): let an agent create, inspect,
// and update Kanban tasks so a "manager" agent can run its own work queue
// (decompose a goal into tasks, re-triage a column, wire up blockers) without a
// human clicking through the board by hand.
//
// GOVERNANCE: these tools flow through the exact same registry gate as the
// fs/shell tools (registry.ts) — they are only advertised when allowlisted on
// the agent, and `create_task` / `update_task` / `add_task_dependency` are
// side-effecting, so:
//   • Plan mode    → refused, described instead of run (read-only).
//   • Ask mode     → confirmed by a human before running.
//   • Autopilot    → runs unconfirmed (none of these are `destructive`; they
//                    only touch the task store, never the filesystem/shell).
// `list_tasks` is read-only and always available once allowlisted.
//
// `BoardToolDeps` is a narrow, type-only-import interface (no better-sqlite3 /
// electron at runtime) that mirrors `TasksRepo` / `TaskDependenciesRepo`
// exactly, so the orchestrator can pass the real repositories straight in at
// the `buildAgentToolset` call sites (worker + chat) without an adapter layer.

import type { ToolDefinition } from './types'
import { TOOL_IDS } from '@shared/tools'
import type { Task, TaskStatus } from '@shared/db/types'
import type { TaskCreateInput, TaskMoveInput, TaskUpdateInput } from '@main/repositories/tasks'

/** What the board tools need from the task store — mirrors TasksRepo's shape. */
export interface BoardToolDeps {
  tasks: {
    list(projectId?: string | null): Task[]
    get(id: string): Task | null
    create(input: TaskCreateInput): Task
    update(input: TaskUpdateInput): Task
    move(input: TaskMoveInput): Task
  }
  dependencies: {
    add(taskId: string, dependsOnTaskId: string): unknown
  }
}

// Statuses a new task may start in (mirrors the board's default columns for
// freshly-created work — In Progress/Blocked/Done only make sense once a task
// has been worked, so create_task doesn't offer them).
const CREATE_STATUSES: readonly TaskStatus[] = ['Backlog', 'Planned']
// All valid columns — what update_task may move a task into.
const ALL_STATUSES: readonly TaskStatus[] = [
  'Backlog',
  'Planned',
  'In Progress',
  'Blocked',
  'Done'
]

const MAX_LIST_ROWS = 50

/** Coerce a tool argument to a trimmed non-empty string, or null if it isn't one. */
function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Normalize any thrown value into a short message for the model. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One compact board row: `id | status | assignee | title`. */
function formatTaskLine(t: Task): string {
  return `${t.id} | ${t.status} | ${t.assignee ?? '(unassigned)'} | ${t.title}`
}

// ── list_tasks ─────────────────────────────────────────────────────────────
function buildListTasksTool(deps: BoardToolDeps): ToolDefinition {
  return {
    id: TOOL_IDS.listTasks,
    sideEffecting: false,
    requiresWorkspace: false,
    spec: {
      type: 'function',
      function: {
        name: TOOL_IDS.listTasks,
        description:
          'List Kanban board tasks, optionally filtered by status and/or assignee. ' +
          'Returns compact rows: "id | status | assignee | title", capped at ' +
          `${MAX_LIST_ROWS} with a "+N more" note when there are more matches.`,
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: `Filter to one column, e.g. "In Progress". One of: ${ALL_STATUSES.join(', ')}.`
            },
            assignee: {
              type: 'string',
              description: 'Filter to tasks assigned to this exact user/agent name.'
            }
          },
          required: []
        }
      }
    },
    async run(args: Record<string, unknown>): Promise<string> {
      try {
        const status = asNonEmptyString(args.status)
        const assignee = asNonEmptyString(args.assignee)
        let tasks = deps.tasks.list()
        if (status) tasks = tasks.filter((t) => t.status === status)
        if (assignee) tasks = tasks.filter((t) => t.assignee === assignee)
        if (tasks.length === 0) return 'No tasks match.'
        const shown = tasks.slice(0, MAX_LIST_ROWS)
        const more =
          tasks.length > shown.length ? `\n+${tasks.length - shown.length} more` : ''
        return `${shown.map(formatTaskLine).join('\n')}${more}`
      } catch (err) {
        return `Error: ${message(err)}`
      }
    }
  }
}

// ── create_task ────────────────────────────────────────────────────────────
function buildCreateTaskTool(deps: BoardToolDeps): ToolDefinition {
  return {
    id: TOOL_IDS.createTask,
    sideEffecting: true,
    // Adding a card to the board is never destructive — nothing existing is
    // overwritten or lost, so autopilot never needs to confirm it.
    destructive: () => false,
    requiresWorkspace: false,
    spec: {
      type: 'function',
      function: {
        name: TOOL_IDS.createTask,
        description: 'Create a new task on the Kanban board.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title (required, non-empty).' },
            description: { type: 'string', description: 'Optional longer description.' },
            assignee: {
              type: 'string',
              description: 'Optional user or agent name to assign the task to.'
            },
            status: {
              type: 'string',
              enum: [...CREATE_STATUSES],
              description: 'Starting column. Defaults to "Backlog".'
            },
            parentTaskId: {
              type: 'string',
              description: 'Optional parent task id, when this is a decomposed subtask.'
            }
          },
          required: ['title']
        }
      }
    },
    async run(args: Record<string, unknown>): Promise<string> {
      try {
        const title = asNonEmptyString(args.title)
        if (!title) return 'Error: create_task requires a non-empty "title" string.'

        let status: TaskStatus = 'Backlog'
        if (args.status !== undefined) {
          const requested = asNonEmptyString(args.status)
          if (!requested || !CREATE_STATUSES.includes(requested as TaskStatus)) {
            return `Error: invalid status "${String(args.status)}" for a new task. Use one of: ${CREATE_STATUSES.join(', ')}.`
          }
          status = requested as TaskStatus
        }

        const description = asNonEmptyString(args.description) ?? undefined
        const assignee = asNonEmptyString(args.assignee) ?? undefined
        const parentTaskId = asNonEmptyString(args.parentTaskId) ?? undefined

        const task = deps.tasks.create({ title, description, assignee, status, parentTaskId })
        return `Created task ${task.id}: "${task.title}" (${task.status})`
      } catch (err) {
        return `Error: ${message(err)}`
      }
    }
  }
}

// ── update_task ────────────────────────────────────────────────────────────
function buildUpdateTaskTool(deps: BoardToolDeps, actorName: string): ToolDefinition {
  return {
    id: TOOL_IDS.updateTask,
    sideEffecting: true,
    // Editing fields or moving a column never deletes/overwrites unrecoverable
    // state (task_events keeps the full history), so it's never destructive.
    destructive: () => false,
    requiresWorkspace: false,
    spec: {
      type: 'function',
      function: {
        name: TOOL_IDS.updateTask,
        description:
          'Update an existing task: rename it, edit its description/assignee, or move it to ' +
          'another column. Status changes are recorded on the task\'s audit trail under your name.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The task id to update (required).' },
            title: { type: 'string', description: 'New title.' },
            description: { type: 'string', description: 'New description.' },
            status: {
              type: 'string',
              enum: [...ALL_STATUSES],
              description: `New column. One of: ${ALL_STATUSES.join(', ')}.`
            },
            assignee: { type: 'string', description: 'New assignee (user or agent name).' }
          },
          required: ['id']
        }
      }
    },
    async run(args: Record<string, unknown>): Promise<string> {
      try {
        const id = asNonEmptyString(args.id)
        if (!id) return 'Error: update_task requires a non-empty "id" string.'

        const existing = deps.tasks.get(id)
        if (!existing) return `Error: no task with id "${id}".`

        const changes: string[] = []

        // Status change: goes through `move` (not `update`) so the transition is
        // attributed to THIS agent, not hardcoded to 'user' — the whole point of
        // routing status through move for a manager agent's audit trail.
        if (args.status !== undefined) {
          const requested = asNonEmptyString(args.status)
          if (!requested || !ALL_STATUSES.includes(requested as TaskStatus)) {
            return `Error: invalid status "${String(args.status)}". Use one of: ${ALL_STATUSES.join(', ')}.`
          }
          if (requested !== existing.status) {
            deps.tasks.move({ id, status: requested as TaskStatus, actor: actorName })
            changes.push(`status → ${requested}`)
          }
        }

        const fieldUpdate: Partial<TaskUpdateInput> = {}
        if (args.title !== undefined) {
          const title = asNonEmptyString(args.title)
          if (!title) return 'Error: "title" cannot be empty.'
          fieldUpdate.title = title
          changes.push(`title → "${title}"`)
        }
        if (args.description !== undefined) {
          fieldUpdate.description = typeof args.description === 'string' ? args.description : null
          changes.push('description updated')
        }
        if (args.assignee !== undefined) {
          fieldUpdate.assignee = asNonEmptyString(args.assignee)
          changes.push(`assignee → ${fieldUpdate.assignee ?? '(unassigned)'}`)
        }
        if (Object.keys(fieldUpdate).length > 0) {
          deps.tasks.update({ id, ...fieldUpdate })
        }

        if (changes.length === 0) return `No changes specified for task ${id}.`
        return `Updated task ${id}: ${changes.join(', ')}.`
      } catch (err) {
        return `Error: ${message(err)}`
      }
    }
  }
}

// ── add_task_dependency ────────────────────────────────────────────────────
function buildAddTaskDependencyTool(deps: BoardToolDeps): ToolDefinition {
  return {
    id: TOOL_IDS.addTaskDependency,
    sideEffecting: true,
    // A blocker edge is reversible (there's no remove_task_dependency tool yet,
    // but nothing is deleted/lost) and the repo itself refuses cycles, so this
    // never needs an autopilot confirm.
    destructive: () => false,
    requiresWorkspace: false,
    spec: {
      type: 'function',
      function: {
        name: TOOL_IDS.addTaskDependency,
        description:
          'Mark one task as blocked by another — it will not be considered workable until ' +
          'the blocker reaches Done. Rejects edges that would create a circular dependency.',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: 'The task that becomes blocked.' },
            dependsOnTaskId: {
              type: 'string',
              description: 'The task that blocks it (must reach Done first).'
            }
          },
          required: ['taskId', 'dependsOnTaskId']
        }
      }
    },
    async run(args: Record<string, unknown>): Promise<string> {
      try {
        const taskId = asNonEmptyString(args.taskId)
        const dependsOnTaskId = asNonEmptyString(args.dependsOnTaskId)
        if (!taskId || !dependsOnTaskId) {
          return 'Error: add_task_dependency requires non-empty "taskId" and "dependsOnTaskId" strings.'
        }
        deps.dependencies.add(taskId, dependsOnTaskId)
        return `Task ${taskId} now depends on ${dependsOnTaskId} — it is blocked until that task is Done.`
      } catch (err) {
        // The repo throws a friendly circular-dependency message — surface it
        // as-is rather than a generic failure, so the model can react to it.
        return `Error: ${message(err)}`
      }
    }
  }
}

/** The board-manipulation tools advertised to an agent (spec §7). */
export function buildBoardTools(deps: BoardToolDeps, actorName: string): ToolDefinition[] {
  return [
    buildListTasksTool(deps),
    buildCreateTaskTool(deps),
    buildUpdateTaskTool(deps, actorName),
    buildAddTaskDependencyTool(deps)
  ]
}
