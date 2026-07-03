import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AgentSelect } from '@renderer/components/board/AgentSelect'
import { BoardColumn } from '@renderer/components/board/BoardColumn'
import { BoardProjectFilter } from '@renderer/components/board/BoardProjectFilter'
import { boardColumns } from '@renderer/components/board/columns'
import { DelegateDialog } from '@renderer/components/board/DelegateDialog'
import { ReviewModal } from '@renderer/components/activity/ReviewModal'
import { TaskCard } from '@renderer/components/board/TaskCard'
import { TaskCreateDialog } from '@renderer/components/board/TaskCreateDialog'
import { TaskDetailDialog } from '@renderer/components/board/TaskDetailDialog'
import { WorkerControls } from '@renderer/components/board/WorkerControls'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import { Plus } from 'lucide-react'
import { useBoardStore } from '@renderer/store/boardStore'
import { useUiStore } from '@renderer/store/uiStore'
import type { Agent, Task, TaskStatus } from '@shared/db/types'
import type { GoalNode } from '@shared/ipc/contract'

/** Settings key holding the default agent's id (used for unassigned tasks). */
const DEFAULT_AGENT_KEY = 'default_agent'

/**
 * The Kanban board (spec §6) — the live task store rendered as five drag-and-drop
 * columns. Tasks load from `tasks.list()` on mount and are grouped by status.
 * Dragging a card to another column calls `tasks.move({ id, status })`; the store
 * updates optimistically and reconciles with the returned row (refetch on error).
 */
export function Board(): JSX.Element {
  const tasks = useBoardStore((s) => s.tasks)
  const groups = useBoardStore((s) => s.groups)
  const loading = useBoardStore((s) => s.loading)
  const error = useBoardStore((s) => s.error)
  const load = useBoardStore((s) => s.load)
  const create = useBoardStore((s) => s.create)
  const update = useBoardStore((s) => s.update)
  const move = useBoardStore((s) => s.move)
  const reorder = useBoardStore((s) => s.reorder)
  const remove = useBoardStore((s) => s.remove)

  const navigate = useNavigate()
  const projects = useUiStore((s) => s.projects)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [goals, setGoals] = useState<GoalNode[]>([])
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null)
  // Board scope: 'all' (fleet view, the default) or a project id. Independent of
  // the Chats panel's active project so navigating chats never reshapes the Board.
  const [filter, setFilter] = useState<string>('all')
  // The card whose detail/edit modal is open (double-click to open).
  const [detailTask, setDetailTask] = useState<Task | null>(null)
  // The column status to create a new task in (null = create modal closed).
  const [createStatus, setCreateStatus] = useState<TaskStatus | null>(null)
  // The work chat being reviewed in the result/status modal (null = closed).
  const [reviewChatId, setReviewChatId] = useState<string | null>(null)
  // The reviewed chat's task, so the ReviewModal can offer "Request changes".
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)
  // Auto-work enabled state (reported by WorkerControls' status poll) — drives
  // the "tasks are waiting but auto-work is off" banner. null until first poll.
  const [workerEnabled, setWorkerEnabled] = useState<boolean | null>(null)

  // Delegate flow: the task whose dialog is open, in-flight + error state, and a
  // transient confirmation toast.
  const [delegateTask, setDelegateTask] = useState<Task | null>(null)
  const [delegating, setDelegating] = useState(false)
  const [delegateError, setDelegateError] = useState<string | null>(null)
  const [delegateToast, setDelegateToast] = useState<string | null>(null)
  // Timers for the post-delegate board poll + toast dismissal, cleaned up on unmount.
  const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load tasks for the board's scope, and re-fetch whenever the filter changes.
  // 'all' maps to null (= every project); a project id scopes to that project.
  useEffect(() => {
    void load(filter === 'all' ? null : filter)
  }, [load, filter])

  // Load the agent library once so cards can assign and "Work this task" resolve.
  useEffect(() => {
    let cancelled = false
    window.sunny.agents
      .list()
      .then((list) => {
        if (!cancelled) setAgents(list)
      })
      .catch(() => {
        // Degrade gracefully: cards still render with an empty agent list.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Load the goals in scope (for the card goal chip + the detail dialog's goal
  // selector). Re-fetch when the board's project filter changes.
  const loadGoals = useCallback((): void => {
    window.sunny.goals
      .list({ projectId: filter === 'all' ? undefined : filter })
      .then(setGoals)
      .catch(() => {
        // Degrade gracefully: cards render without goal chips.
      })
  }, [filter])

  useEffect(() => {
    loadGoals()
  }, [loadGoals])

  // Load the persisted default agent (the agent used for unassigned tasks).
  useEffect(() => {
    let cancelled = false
    window.sunny.settings
      .get({ key: DEFAULT_AGENT_KEY })
      .then((res) => {
        if (!cancelled) setDefaultAgentId(res.value)
      })
      .catch(() => {
        // No default configured / unreadable — leave it unset.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const defaultAgent = useMemo(
    () => (defaultAgentId ? (agents.find((a) => a.id === defaultAgentId) ?? null) : null),
    [agents, defaultAgentId]
  )

  // Project id → name, for the per-card project badge. Badges show only in the
  // "All Projects" fleet view (redundant when already filtered to one project).
  const projectName = useMemo(
    () => new Map<string, string>(projects.map((p) => [p.id, p.name] as const)),
    [projects]
  )
  const showProjectBadge = filter === 'all'

  // goal id → title, for the per-card goal chip + lookups.
  const goalName = useMemo(
    () => new Map<string, string>(goals.map((g) => [g.id, g.title] as const)),
    [goals]
  )

  /** Persist the default agent (its id, or empty when "None"), then update UI. */
  const handleDefaultAgentChange = useCallback((agent: Agent | null): void => {
    const value = agent ? agent.id : ''
    setDefaultAgentId(agent ? agent.id : null)
    void window.sunny.settings.set({ key: DEFAULT_AGENT_KEY, value })
  }, [])

  /** Assign an agent (by name) to a task, or '' to unassign, then refetch. */
  const handleAssign = useCallback(
    (taskId: string, assignee: string): void => {
      void window.sunny.tasks
        .update({ id: taskId, assignee: assignee.length > 0 ? assignee : null })
        .then(() => load())
    },
    [load]
  )

  /** Schedule a burst of board reloads so a background run's progress (claim →
   *  finish/block) appears without a manual refresh. */
  const pollBoard = useCallback((): void => {
    void load()
    for (let i = 1; i <= 12; i++) {
      pollTimers.current.push(setTimeout(() => void load(), i * 2500))
    }
  }, [load])

  /**
   * "Work this task": run it NOW in the background through the autonomous worker.
   * The worker claims it (→ In Progress, recorded as the AGENT, not the user) and
   * works it as its agent, then advances the card — no chat navigation. The card
   * shows a working light while it runs; review the linked chat afterward.
   */
  const handleWork = useCallback(
    async (task: Task): Promise<void> => {
      const assigned = task.assignee ? agents.find((a) => a.name === task.assignee) : undefined
      const agent = assigned ?? defaultAgent
      if (!agent) return // The card surfaces its own inline hint.
      // The worker won't run a paused/terminated agent (it deliberately doesn't
      // fall back to the default), so warn instead of firing a no-op that would
      // otherwise flash a false "is working…" success toast.
      if (agent.lifecycle_state !== 'active') {
        setDelegateToast(
          `${agent.name} is ${agent.lifecycle_state === 'paused' ? 'paused' : 'terminated'} — resume it in Team or reassign the task.`
        )
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setDelegateToast(null), 6000)
        return
      }
      try {
        await window.sunny.tasks.workNow({ id: task.id })
        setDelegateToast(`${agent.name} is working “${task.title}”…`)
        pollBoard()
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setDelegateToast(null), 6000)
      } catch (err: unknown) {
        setDelegateToast(err instanceof Error ? err.message : 'Failed to start the task.')
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setDelegateToast(null), 6000)
      }
    },
    [agents, defaultAgent, pollBoard]
  )

  /** Create a task from the modal, then close it. */
  const handleCreate = useCallback(
    (input: {
      title: string
      description: string | null
      status: TaskStatus
      assignee: string | null
      projectId: string | null
    }): void => {
      void create({
        title: input.title,
        description: input.description ?? undefined,
        status: input.status,
        assignee: input.assignee,
        projectId: input.projectId
      })
      setCreateStatus(null)
    },
    [create]
  )

  /** Open the agent's work chat for a task (review its output), if one exists. */
  const handleOpenChat = useCallback(
    (chatId: string): void => {
      navigate(`/chats/${chatId}`)
    },
    [navigate]
  )

  /** Open the Delegate dialog for a task (clears any stale dialog error). */
  const handleDelegate = useCallback((task: Task): void => {
    setDelegateError(null)
    setDelegateTask(task)
  }, [])

  /**
   * Fire the (fire-and-forget) delegation, then reflect the async result on the
   * board: close the dialog, show a transient confirmation, and poll the board
   * every ~3s for ~30s so child subtasks appear and complete without a manual
   * refresh. Timers are tracked in refs and cleared on unmount.
   */
  const confirmDelegate = useCallback(
    async (input: { managerAgentId?: string; workerAgentId?: string }): Promise<void> => {
      if (!delegateTask) return
      setDelegating(true)
      setDelegateError(null)
      try {
        await window.sunny.tasks.delegate({
          taskId: delegateTask.id,
          managerAgentId: input.managerAgentId,
          workerAgentId: input.workerAgentId
        })
        setDelegateTask(null)
        setDelegateToast('Delegating… subtasks will appear on the board.')
        // Refresh now, then poll so children appear + complete as the agents work.
        void load()
        for (let i = 1; i <= 10; i++) {
          pollTimers.current.push(setTimeout(() => void load(), i * 3000))
        }
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setDelegateToast(null), 6000)
      } catch (err: unknown) {
        setDelegateError(err instanceof Error ? err.message : 'Failed to delegate task.')
      } finally {
        setDelegating(false)
      }
    },
    [delegateTask, load]
  )

  // Clear any pending poll/toast timers on unmount.
  useEffect(() => {
    return () => {
      pollTimers.current.forEach(clearTimeout)
      pollTimers.current = []
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const activeTask = useMemo(
    () => (activeId ? (tasks.find((t) => t.id === activeId) ?? null) : null),
    [activeId, tasks]
  )

  /** Resolve the target column status from a droppable/sortable `over` id. */
  function resolveStatus(overId: string): TaskStatus | null {
    // Dropped directly on a column droppable (id === status).
    if (boardColumns.some((c) => c.status === overId)) return overId as TaskStatus
    // Otherwise we're over another card — use that card's column.
    const overTask = tasks.find((t) => t.id === overId)
    return overTask ? overTask.status : null
  }

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    const activeTaskId = String(active.id)
    const dragged = tasks.find((t) => t.id === activeTaskId)
    if (!dragged) return

    const targetStatus = resolveStatus(String(over.id))
    if (!targetStatus) return

    if (targetStatus !== dragged.status) {
      // Column move — the must-have. Maps straight to tasks.move.
      void move({ id: activeTaskId, status: targetStatus })
      return
    }

    // Same column — reorder (nice-to-have) using the drop index as sortOrder.
    const column = groups[targetStatus]
    const toIndex = column.findIndex((t) => t.id === String(over.id))
    if (toIndex !== -1) void reorder({ id: activeTaskId, status: targetStatus, toIndex })
  }

  const showEmptyHint = !loading && tasks.length === 0 && !error

  return (
    <div className="flex h-full flex-col px-8 py-10">
      <PageHeader
        title="Board"
        description="The live task store. Agents create and move cards as they work — this is the picture of the fleet."
        actions={
          <div className="flex items-center gap-4">
            {loading ? (
              <span className="flex items-center gap-2 text-sm text-fg-muted">
                <Spinner label="Loading tasks" />
                Loading…
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setCreateStatus('Backlog')}
              className="flex items-center gap-2 rounded-xl bg-amber-400 px-3.5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New task
            </button>
            <BoardProjectFilter projects={projects} value={filter} onChange={setFilter} />
            <span className="h-10 w-px shrink-0 bg-ink-700/60" aria-hidden="true" />
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-fg-muted">Default agent</span>
                <AgentSelect
                  agents={agents}
                  value={defaultAgent}
                  onChange={handleDefaultAgentChange}
                  emptyLabel="None"
                  label="Default agent"
                  size="header"
                  align="right"
                />
              </div>
              <span className="text-[11px] text-fg-subtle">
                Works tasks that aren&apos;t assigned to a specific agent.
              </span>
            </div>
            <span className="h-10 w-px shrink-0 bg-ink-700/60" aria-hidden="true" />
            <WorkerControls onScan={() => void load()} onStatus={setWorkerEnabled} />
          </div>
        }
      />

      {error ? (
        <div className="mt-6 rounded-xl border border-status-blocked/40 bg-status-blocked/10 px-4 py-2.5 text-sm text-status-blocked">
          {error}
        </div>
      ) : null}

      {showEmptyHint ? (
        <p className="mt-4 text-sm text-fg-muted">
          No tasks yet — add one below, or let an agent create them.
        </p>
      ) : null}

      {/* Autonomy cue: a board full of workable tasks does NOTHING while
          auto-work is off — say so instead of letting the user wait on a
          worker that will never scan. */}
      {workerEnabled === false &&
      tasks.some((t) => t.status === 'Backlog' || t.status === 'Planned') ? (
        <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-200">
          Auto-work is <span className="font-semibold">off</span> —{' '}
          {tasks.filter((t) => t.status === 'Backlog' || t.status === 'Planned').length} task(s)
          are waiting. Turn it on (top right), use a card&apos;s <em>Work now</em>, or click{' '}
          <em>Run now</em> for a one-off scan.
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="mt-8 flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
          {boardColumns.map((column) => (
            <BoardColumn
              key={column.status}
              column={column}
              tasks={groups[column.status]}
              agents={agents}
              defaultAgentId={defaultAgentId}
              projectName={projectName}
              showProjectBadge={showProjectBadge}
              goalName={goalName}
              onRequestCreate={(status) => setCreateStatus(status)}
              onEdit={(input) =>
                void update({ id: input.id, title: input.title, description: input.description })
              }
              onDelete={(id) => void remove(id)}
              onAssign={handleAssign}
              onWork={(task) => void handleWork(task)}
              onDelegate={handleDelegate}
              onOpenDetail={setDetailTask}
              onView={(task) => {
                if (task.chat_id) {
                  setReviewChatId(task.chat_id)
                  setReviewTaskId(task.id)
                }
              }}
            />
          ))}
        </div>

        <DragOverlay>
          {activeTask ? (
            <TaskCard
              task={activeTask}
              overlay
              onEdit={() => undefined}
              onDelete={() => undefined}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {detailTask ? (
        <TaskDetailDialog
          task={detailTask}
          agents={agents}
          goals={goals}
          allTasks={tasks}
          onChanged={() => {
            void load()
            loadGoals()
          }}
          onClose={() => setDetailTask(null)}
          onSave={(input) =>
            void update({ id: input.id, title: input.title, description: input.description })
          }
          onAssign={handleAssign}
          onStatusChange={(taskId, status) => void move({ id: taskId, status })}
          onDelete={(id) => void remove(id)}
          onWork={(task) => void handleWork(task)}
          onDelegate={handleDelegate}
          onOpenChat={handleOpenChat}
        />
      ) : null}

      {reviewChatId ? (
        <ReviewModal
          chatId={reviewChatId}
          taskId={reviewTaskId}
          onClose={() => {
            setReviewChatId(null)
            setReviewTaskId(null)
            pollBoard() // a rework re-queues the task — reflect it promptly
          }}
          onOpenChat={(id) => {
            setReviewChatId(null)
            setReviewTaskId(null)
            navigate(`/chats/${id}`)
          }}
        />
      ) : null}

      {createStatus ? (
        <TaskCreateDialog
          agents={agents}
          projects={projects}
          initialStatus={createStatus}
          defaultProjectId={filter === 'all' ? null : filter}
          onCreate={handleCreate}
          onClose={() => setCreateStatus(null)}
        />
      ) : null}

      {delegateTask ? (
        <DelegateDialog
          task={delegateTask}
          agents={agents}
          defaultAgentId={defaultAgentId}
          delegating={delegating}
          error={delegateError}
          onConfirm={(input) => void confirmDelegate(input)}
          onClose={() => {
            if (!delegating) setDelegateTask(null)
          }}
        />
      ) : null}

      {delegateToast ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-amber-400/30 bg-ink-850 px-4 py-2.5 text-sm font-medium text-amber-300 shadow-panel"
        >
          {delegateToast}
        </div>
      ) : null}
    </div>
  )
}
