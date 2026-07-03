import { describe, it, expect, vi } from 'vitest'
import { buildBoardTools, type BoardToolDeps } from '@main/tools/board'
import { buildAgentToolset } from '@main/tools/registry'
import type { ConfirmFn, ToolContext } from '@main/tools/types'
import type { TaskCreateInput, TaskMoveInput, TaskUpdateInput } from '@main/repositories/tasks'
import type { Task, TaskStatus } from '@shared/db/types'
import { TOOL_IDS } from '@shared/tools'

// board.ts is the board-manipulation tool set (list/create/update tasks + add a
// dependency edge) that lets a manager agent run its own work queue. These
// tests drive the tools directly (unit) and then THROUGH the registry (the
// permission gate — plan/ask/autopilot) to make sure board tools are governed
// exactly like fs/shell tools.

function makeTask(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    project_id: null,
    description: null,
    status: 'Backlog',
    assignee: null,
    parent_task_id: null,
    sort_order: 0,
    run_id: null,
    chat_id: null,
    goal_id: null,
    locked_by: null,
    locked_at: null,
    wake_at: null,
    context_ref: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

/** In-memory fake BoardToolDeps that tracks every call, mirroring TasksRepo /
 *  TaskDependenciesRepo just closely enough for the tools under test. */
function makeFakeDeps(initialTasks: Task[] = []): BoardToolDeps & {
  calls: {
    create: TaskCreateInput[]
    update: TaskUpdateInput[]
    move: TaskMoveInput[]
    dependencyAdd: Array<[string, string]>
  }
  store: Map<string, Task>
} {
  const store = new Map(initialTasks.map((t) => [t.id, t]))
  const calls = {
    create: [] as TaskCreateInput[],
    update: [] as TaskUpdateInput[],
    move: [] as TaskMoveInput[],
    dependencyAdd: [] as Array<[string, string]>
  }
  let nextId = 1

  return {
    store,
    calls,
    tasks: {
      list(): Task[] {
        return Array.from(store.values())
      },
      get(id: string): Task | null {
        return store.get(id) ?? null
      },
      create(input: TaskCreateInput): Task {
        calls.create.push(input)
        const task = makeTask({
          id: input.id ?? `t${nextId++}`,
          title: input.title,
          description: input.description ?? null,
          status: (input.status ?? 'Backlog') as TaskStatus,
          assignee: input.assignee ?? null,
          parent_task_id: input.parentTaskId ?? null
        })
        store.set(task.id, task)
        return task
      },
      update(input: TaskUpdateInput): Task {
        calls.update.push(input)
        const existing = store.get(input.id)
        if (!existing) throw new Error(`Task not found: ${input.id}`)
        const updated: Task = {
          ...existing,
          title: input.title ?? existing.title,
          description: input.description === undefined ? existing.description : input.description,
          assignee: input.assignee === undefined ? existing.assignee : input.assignee
        }
        store.set(input.id, updated)
        return updated
      },
      move(input: TaskMoveInput): Task {
        calls.move.push(input)
        const existing = store.get(input.id)
        if (!existing) throw new Error(`Task not found: ${input.id}`)
        const updated: Task = { ...existing, status: input.status }
        store.set(input.id, updated)
        return updated
      }
    },
    dependencies: {
      add(taskId: string, dependsOnTaskId: string): unknown {
        calls.dependencyAdd.push([taskId, dependsOnTaskId])
        if (taskId === 'cycle-a' && dependsOnTaskId === 'cycle-b') {
          throw new Error(
            'This would create a circular dependency — "A" already blocks "B".'
          )
        }
        return { id: 'dep1', task_id: taskId, depends_on_task_id: dependsOnTaskId }
      }
    }
  }
}

function getTool(tools: ReturnType<typeof buildBoardTools>, id: string) {
  const tool = tools.find((t) => t.id === id)
  if (!tool) throw new Error(`tool ${id} not found`)
  return tool
}

// run() only needs args for these tools; cast an empty object since ctx is unused.
const noCtx = {} as ToolContext

describe('list_tasks', () => {
  it('filters by status and assignee', async () => {
    const deps = makeFakeDeps([
      makeTask({ id: 't1', title: 'A', status: 'Backlog', assignee: 'sam' }),
      makeTask({ id: 't2', title: 'B', status: 'Planned', assignee: 'sam' }),
      makeTask({ id: 't3', title: 'C', status: 'Backlog', assignee: 'ari' })
    ])
    const tools = buildBoardTools(deps, 'agent')
    const listTasks = getTool(tools, TOOL_IDS.listTasks)

    const byStatus = await listTasks.run({ status: 'Backlog' }, noCtx)
    expect(byStatus).toContain('t1')
    expect(byStatus).toContain('t3')
    expect(byStatus).not.toContain('t2')

    const byAssignee = await listTasks.run({ assignee: 'sam' }, noCtx)
    expect(byAssignee).toContain('t1')
    expect(byAssignee).toContain('t2')
    expect(byAssignee).not.toContain('t3')
  })

  it('caps at 50 rows with a "+N more" note', async () => {
    const many = Array.from({ length: 55 }, (_, i) => makeTask({ id: `t${i}`, title: `Task ${i}` }))
    const deps = makeFakeDeps(many)
    const tools = buildBoardTools(deps, 'agent')
    const out = await getTool(tools, TOOL_IDS.listTasks).run({}, noCtx)
    expect(out).toContain('+5 more')
    expect(out.split('\n').filter((l) => l.startsWith('t'))).toHaveLength(50)
  })

  it('returns a friendly message when nothing matches', async () => {
    const deps = makeFakeDeps([])
    const tools = buildBoardTools(deps, 'agent')
    const out = await getTool(tools, TOOL_IDS.listTasks).run({}, noCtx)
    expect(out).toBe('No tasks match.')
  })
})

describe('create_task', () => {
  it('creates a task and reports it', async () => {
    const deps = makeFakeDeps()
    const tools = buildBoardTools(deps, 'agent')
    const out = await getTool(tools, TOOL_IDS.createTask).run(
      { title: 'Write the report', status: 'Planned' },
      noCtx
    )
    expect(out).toMatch(/^Created task /)
    expect(out).toContain('"Write the report"')
    expect(out).toContain('(Planned)')
    expect(deps.calls.create).toHaveLength(1)
    expect(deps.calls.create[0].title).toBe('Write the report')
  })

  it('rejects an empty/whitespace title without calling create', async () => {
    const deps = makeFakeDeps()
    const tools = buildBoardTools(deps, 'agent')
    const out = await getTool(tools, TOOL_IDS.createTask).run({ title: '   ' }, noCtx)
    expect(out).toMatch(/error/i)
    expect(deps.calls.create).toHaveLength(0)
  })
})

describe('update_task', () => {
  it('routes a status change through move() with the actor name', async () => {
    const deps = makeFakeDeps([makeTask({ id: 't1', title: 'A', status: 'Backlog' })])
    const tools = buildBoardTools(deps, 'Aria')
    const out = await getTool(tools, TOOL_IDS.updateTask).run(
      { id: 't1', status: 'In Progress' },
      noCtx
    )
    expect(deps.calls.move).toHaveLength(1)
    expect(deps.calls.move[0]).toMatchObject({ id: 't1', status: 'In Progress', actor: 'Aria' })
    expect(deps.calls.update).toHaveLength(0)
    expect(out).toContain('status → In Progress')
    expect(deps.store.get('t1')?.status).toBe('In Progress')
  })

  it('routes non-status fields through update() without touching move()', async () => {
    const deps = makeFakeDeps([makeTask({ id: 't1', title: 'A' })])
    const tools = buildBoardTools(deps, 'Aria')
    const out = await getTool(tools, TOOL_IDS.updateTask).run(
      { id: 't1', title: 'New title', assignee: 'sam' },
      noCtx
    )
    expect(deps.calls.update).toHaveLength(1)
    expect(deps.calls.update[0]).toMatchObject({ id: 't1', title: 'New title', assignee: 'sam' })
    expect(deps.calls.move).toHaveLength(0)
    expect(out).toContain('title → "New title"')
    expect(out).toContain('assignee → sam')
  })

  it('returns an error string for an unknown task id', async () => {
    const deps = makeFakeDeps()
    const tools = buildBoardTools(deps, 'Aria')
    const out = await getTool(tools, TOOL_IDS.updateTask).run({ id: 'missing', title: 'x' }, noCtx)
    expect(out).toMatch(/error/i)
    expect(out).toContain('missing')
    expect(deps.calls.update).toHaveLength(0)
    expect(deps.calls.move).toHaveLength(0)
  })

  it('rejects an invalid status', async () => {
    const deps = makeFakeDeps([makeTask({ id: 't1', title: 'A' })])
    const tools = buildBoardTools(deps, 'Aria')
    const out = await getTool(tools, TOOL_IDS.updateTask).run(
      { id: 't1', status: 'Nope' },
      noCtx
    )
    expect(out).toMatch(/error/i)
    expect(deps.calls.move).toHaveLength(0)
  })
})

describe('add_task_dependency', () => {
  it('adds the edge and describes it', async () => {
    const deps = makeFakeDeps()
    const tools = buildBoardTools(deps, 'agent')
    const out = await getTool(tools, TOOL_IDS.addTaskDependency).run(
      { taskId: 't1', dependsOnTaskId: 't2' },
      noCtx
    )
    expect(out).toContain('t1')
    expect(out).toContain('t2')
    expect(deps.calls.dependencyAdd).toEqual([['t1', 't2']])
  })

  it('surfaces a thrown circular-dependency message as a result string, not a throw', async () => {
    const deps = makeFakeDeps()
    const tools = buildBoardTools(deps, 'agent')
    const out = await getTool(tools, TOOL_IDS.addTaskDependency).run(
      { taskId: 'cycle-a', dependsOnTaskId: 'cycle-b' },
      noCtx
    )
    expect(out).toContain('circular dependency')
  })
})

// ── through buildAgentToolset — the permission gate ─────────────────────────

const BOARD_ALLOWED = new Set<string>([
  TOOL_IDS.listTasks,
  TOOL_IDS.createTask,
  TOOL_IDS.updateTask,
  TOOL_IDS.addTaskDependency
])

function boardCtx(
  deps: BoardToolDeps,
  over: Partial<ToolContext> & { confirm: ConfirmFn }
): ToolContext & { board: BoardToolDeps; actorName?: string } {
  return { mode: 'ask', allowed: BOARD_ALLOWED, board: deps, actorName: 'Aria', ...over }
}

function call(name: string, args: object) {
  return { id: 'c1', name, arguments: JSON.stringify(args) }
}

describe('buildAgentToolset governs board tools like fs/shell', () => {
  it('plan mode blocks create_task and never calls deps.create', async () => {
    const deps = makeFakeDeps()
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(boardCtx(deps, { mode: 'plan', confirm }))
    const out = await ts.runTool(call('create_task', { title: 'Nope' }))
    expect(out).toMatch(/plan mode/i)
    expect(confirm).not.toHaveBeenCalled()
    expect(deps.calls.create).toHaveLength(0)
  })

  it('ask mode with a confirm that denies means create_task does not run', async () => {
    const deps = makeFakeDeps()
    const confirm = vi.fn<ConfirmFn>(async () => false)
    const ts = buildAgentToolset(boardCtx(deps, { mode: 'ask', confirm }))
    const out = await ts.runTool(call('create_task', { title: 'Nope' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(out).toMatch(/did not approve/i)
    expect(deps.calls.create).toHaveLength(0)
  })

  it('autopilot runs create_task without confirming (non-destructive)', async () => {
    const deps = makeFakeDeps()
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(boardCtx(deps, { mode: 'autopilot', confirm }))
    const out = await ts.runTool(call('create_task', { title: 'Go' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(out).toMatch(/^Created task /)
    expect(deps.calls.create).toHaveLength(1)
  })

  it('list_tasks (read-only) runs in any mode without a confirm', async () => {
    const deps = makeFakeDeps([makeTask({ id: 't1', title: 'A' })])
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(boardCtx(deps, { mode: 'ask', confirm }))
    const out = await ts.runTool(call('list_tasks', {}))
    expect(out).toContain('t1')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('board tools are absent when the agent is not allowlisted for them', () => {
    const deps = makeFakeDeps()
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(
      boardCtx(deps, { allowed: new Set([TOOL_IDS.listTasks]), confirm })
    )
    const names = ts.tools.map((t) => t.function.name)
    expect(names).toContain('list_tasks')
    expect(names).not.toContain('create_task')
  })

  it('board tools are absent entirely when ctx.board is not supplied', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset({ mode: 'autopilot', allowed: BOARD_ALLOWED, confirm })
    expect(ts.tools).toHaveLength(0)
    const out = await ts.runTool(call('list_tasks', {}))
    expect(out).toMatch(/not enabled/i)
  })
})
