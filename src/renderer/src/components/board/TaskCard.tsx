import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Check,
  CornerDownRight,
  FileText,
  Folder,
  GitFork,
  GripVertical,
  Hourglass,
  MoreHorizontal,
  OctagonAlert,
  Pencil,
  Play,
  Target,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { HeartbeatDot } from '@renderer/components/ui/HeartbeatDot'
import { cn } from '@renderer/lib/cn'
import { AgentSelect } from './AgentSelect'
import { columnByStatus } from './columns'
import type { Agent, Task } from '@shared/db/types'

interface TaskCardProps {
  task: Task
  /** Agents available for assignment (loaded once at the board level). */
  agents?: Agent[]
  /** The default agent's id (the `default_agent` setting), or null if none. */
  defaultAgentId?: string | null
  onEdit: (input: { id: string; title: string; description: string | null }) => void
  onDelete: (id: string) => void
  /** Assign an agent by name, or '' to unassign. */
  onAssign?: (assignee: string) => void
  /** Open a chat configured as the resolved agent, seeded with this task. */
  onWork?: (task: Task) => void
  /** Open the Delegate dialog for this task (manager + worker agents). */
  onDelegate?: (task: Task) => void
  /** Open the full detail/edit modal (double-click the card). */
  onOpenDetail?: (task: Task) => void
  /** Open the result/status modal for the agent's work chat (cards with one). */
  onView?: (task: Task) => void
  /** Project name to show as a badge (the board's All-Projects view). */
  projectBadge?: string
  /** Goal title to show as a chip (the task's "why"), if linked. */
  goalBadge?: string
  /** Renders the static drag preview (in the DragOverlay) — no sortable wiring. */
  overlay?: boolean
}

/**
 * A single Kanban card. Wraps dnd-kit's `useSortable` so it can be dragged
 * between columns and reordered. Carries an inline edit mode and a small actions
 * menu (edit / delete). The whole card is the drag handle except interactive
 * controls, which stop propagation so clicks don't start a drag.
 */
export function TaskCard({
  task,
  agents = [],
  defaultAgentId = null,
  onEdit,
  onDelete,
  onAssign,
  onWork,
  onDelegate,
  onOpenDetail,
  onView,
  projectBadge,
  goalBadge,
  overlay = false
}: TaskCardProps): JSX.Element {
  const sortable = useSortable({ id: task.id, data: { status: task.status }, disabled: overlay })
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    setActivatorNodeRef
  } = sortable

  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const titleRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const accent = columnByStatus[task.status]?.accent ?? 'bg-fg-subtle'

  // The agent matching this card's assignee (by name), if any.
  const assignedAgent = task.assignee
    ? (agents.find((a) => a.name === task.assignee) ?? null)
    : null
  // "Work this task" resolves to the assignee's agent, else the default agent.
  const resolvedAgent =
    assignedAgent ?? (defaultAgentId ? (agents.find((a) => a.id === defaultAgentId) ?? null) : null)
  const canWork = resolvedAgent !== null

  useEffect(() => {
    if (editing) titleRef.current?.focus()
  }, [editing])

  // Close the actions menu on any outside pointer-down.
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: PointerEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  function beginEdit(): void {
    setTitle(task.title)
    setDescription(task.description ?? '')
    setEditing(true)
    setMenuOpen(false)
  }

  function saveEdit(): void {
    const trimmed = title.trim()
    if (!trimmed) return
    const desc = description.trim()
    onEdit({ id: task.id, title: trimmed, description: desc.length > 0 ? desc : null })
    setEditing(false)
  }

  function cancelEdit(): void {
    setEditing(false)
  }

  const [showWorkHint, setShowWorkHint] = useState(false)

  function handleAssign(agent: Agent | null): void {
    onAssign?.(agent ? agent.name : '')
    // A fresh assignment can resolve an agent — clear any stale "no agent" hint.
    setShowWorkHint(false)
  }

  function handleWork(): void {
    setMenuOpen(false)
    if (!canWork) {
      setShowWorkHint(true)
      return
    }
    onWork?.(task)
  }

  function handleDelegate(): void {
    setMenuOpen(false)
    onDelegate?.(task)
  }

  const isSubtask = task.parent_task_id !== null

  const style = overlay ? undefined : { transform: CSS.Transform.toString(transform), transition }

  if (editing) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="relative overflow-hidden rounded-xl border border-ink-700 bg-ink-800 p-2.5 shadow-panel"
      >
        <span className={cn('absolute inset-y-0 left-0 w-1', accent)} aria-hidden="true" />
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Edit task title"
          className={cn(
            'w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancelEdit()
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit()
          }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Edit task description"
          rows={2}
          placeholder="Description (optional)"
          className={cn(
            'mt-2 w-full resize-none rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-fg',
            'placeholder:text-fg-subtle',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        />
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={cancelEdit}
            aria-label="Cancel edit"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-ink-750 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Cancel
          </button>
          <button
            type="button"
            onClick={saveEdit}
            disabled={title.trim().length === 0}
            aria-label="Save edit"
            className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-2.5 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Save
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      onDoubleClick={overlay ? undefined : () => onOpenDetail?.(task)}
      className={cn(
        'group relative overflow-hidden rounded-xl border border-ink-700 bg-ink-800 shadow-panel',
        'transition-colors hover:border-ink-600',
        isDragging && 'opacity-40',
        overlay && 'rotate-2 cursor-grabbing border-ink-600 shadow-glow'
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', accent)} aria-hidden="true" />
      <div className="flex items-start gap-1.5 py-2.5 pl-3 pr-2">
        {/* Drag handle — keyboard-accessible activator. */}
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={`Drag ${task.title}`}
          className="mt-0.5 cursor-grab touch-none rounded text-fg-subtle opacity-0 transition-opacity hover:text-fg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 group-hover:opacity-100"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1">
          {isSubtask || projectBadge || goalBadge ? (
            <div className="mb-1 flex flex-wrap items-center gap-1">
              {isSubtask ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  <CornerDownRight className="h-3 w-3" aria-hidden="true" />
                  subtask
                </span>
              ) : null}
              {goalBadge ? (
                <span
                  className="inline-flex max-w-[10rem] items-center gap-1 rounded-full border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-[10px] font-medium text-fg-muted"
                  title={`Goal: ${goalBadge}`}
                >
                  <Target className="h-3 w-3 shrink-0 text-amber-300/70" aria-hidden="true" />
                  <span className="truncate">{goalBadge}</span>
                </span>
              ) : null}
              {projectBadge ? (
                <span
                  className="inline-flex max-w-[10rem] items-center gap-1 rounded-full border border-ink-700 bg-ink-850 px-1.5 py-0.5 text-[10px] font-medium text-fg-muted"
                  title={`Project: ${projectBadge}`}
                >
                  <Folder className="h-3 w-3 shrink-0 text-amber-300/70" aria-hidden="true" />
                  <span className="truncate">{projectBadge}</span>
                </span>
              ) : null}
            </div>
          ) : null}
          <h3 className="text-sm font-medium leading-snug text-fg-heading">{task.title}</h3>
          {!overlay && task.locked_by ? (
            <div className="mt-1">
              <HeartbeatDot state="working" showLabel />
            </div>
          ) : null}
          {/* Why-is-this-stuck, at a glance: a pending approval gate gets its own
              badge (deep-linked from /approvals); any other Blocked card shows
              the block reason inline instead of a mystery column placement. */}
          {!overlay && Boolean(task.awaiting_approval) ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
              <Hourglass className="h-3 w-3" aria-hidden="true" />
              Awaiting your approval — see Approvals
            </span>
          ) : null}
          {!overlay && task.status === 'Blocked' && task.blocked_reason && !task.awaiting_approval ? (
            <p
              className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-status-blocked"
              title={task.blocked_reason}
            >
              <OctagonAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="line-clamp-2">{task.blocked_reason}</span>
            </p>
          ) : null}
          {task.description ? (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-fg-muted">
              {task.description}
            </p>
          ) : null}
          {overlay ? (
            // Static preview: show the assignee as a plain badge (no interactive controls).
            task.assignee ? (
              <span className="mt-2 inline-flex items-center rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-[11px] font-medium text-fg-muted">
                {task.assignee}
              </span>
            ) : null
          ) : (
            <div className="mt-2" onDoubleClick={(e) => e.stopPropagation()}>
              <AgentSelect
                agents={agents}
                value={assignedAgent}
                onChange={handleAssign}
                emptyLabel="Unassigned"
                label="Assignee"
                size="card"
              />
            </div>
          )}
          {showWorkHint ? (
            <p className="mt-2 text-[11px] leading-snug text-status-blocked">
              Assign an agent to this task, or set a default agent on the board, to work it.
            </p>
          ) : null}
          {!overlay && task.chat_id && onView ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onView(task)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <FileText className="h-3 w-3" aria-hidden="true" />
              View result
            </button>
          ) : null}
        </div>

        {/* Actions menu */}
        <div ref={menuRef} className="relative" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label="Task actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-lg p-1 text-fg-subtle opacity-0 transition-opacity hover:bg-ink-750 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 group-hover:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-8 z-20 w-40 overflow-hidden rounded-xl border border-ink-700 bg-ink-850 py-1 shadow-panel"
            >
              <button
                type="button"
                role="menuitem"
                onClick={handleWork}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg focus-visible:bg-ink-800 focus-visible:text-fg focus-visible:outline-none"
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Work this task
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleDelegate}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg focus-visible:bg-ink-800 focus-visible:text-fg focus-visible:outline-none"
              >
                <GitFork className="h-3.5 w-3.5" aria-hidden="true" />
                Delegate
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={beginEdit}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg focus-visible:bg-ink-800 focus-visible:text-fg focus-visible:outline-none"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete(task.id)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-status-blocked transition-colors hover:bg-status-blocked/10 focus-visible:bg-status-blocked/10 focus-visible:outline-none"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
