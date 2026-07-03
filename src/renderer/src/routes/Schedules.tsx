import { CalendarClock, CheckCircle2, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeleteScheduleDialog } from '@renderer/components/schedules/DeleteScheduleDialog'
import { ScheduleForm, type ScheduleFormValues } from '@renderer/components/schedules/ScheduleForm'
import { ScheduleRow } from '@renderer/components/schedules/ScheduleRow'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import type { Agent, Project, Schedule } from '@shared/db/types'

/** Editor state: closed, creating, or editing a schedule. */
type EditorState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; schedule: Schedule }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

/**
 * Schedules (spec §7) — "run an agent on a goal automatically on a cadence".
 * Loads schedules plus the agent/project lookups for display + the editor, and
 * drives the enable-toggle, run-now, create/edit, and delete flows. Each flow
 * refreshes the list so next/last-run times stay current.
 */
export function Schedules(): JSX.Element {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Per-row in-flight tracking for the enable toggle and run-now buttons.
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  // Transient confirmation after a successful Run now.
  const [runConfirm, setRunConfirm] = useState<string | null>(null)
  const runConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resolve agent + project ids to display names. Memoised maps avoid rescanning
  // the lists per row.
  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents])
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  const loadSchedules = useCallback(async (): Promise<void> => {
    try {
      const list = await window.sunny.schedules.list()
      setSchedules(list)
      setLoadError(null)
    } catch (err) {
      setLoadError(errorMessage(err))
    }
  }, [])

  // Initial load: schedules + the agent/project lookups in parallel.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [scheduleList, agentList, projectList] = await Promise.all([
          window.sunny.schedules.list(),
          window.sunny.agents.list(),
          window.sunny.projects.list()
        ])
        if (cancelled) return
        setSchedules(scheduleList)
        setAgents(agentList)
        setProjects(projectList)
        setLoadError(null)
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Clear the run-confirmation timer on unmount.
  useEffect(() => {
    return () => {
      if (runConfirmTimer.current) clearTimeout(runConfirmTimer.current)
    }
  }, [])

  function openCreate(): void {
    setSaveError(null)
    setEditor({ mode: 'create' })
  }

  function openEdit(schedule: Schedule): void {
    setSaveError(null)
    setEditor({ mode: 'edit', schedule })
  }

  function closeEditor(): void {
    if (saving) return
    setEditor({ mode: 'closed' })
    setSaveError(null)
  }

  async function handleSubmit(values: ScheduleFormValues): Promise<void> {
    setSaving(true)
    setSaveError(null)
    try {
      if (editor.mode === 'edit') {
        await window.sunny.schedules.update({
          id: editor.schedule.id,
          name: values.name,
          prompt: values.prompt,
          cadence: values.cadence,
          agentId: values.agentId,
          projectId: values.projectId,
          enabled: values.enabled,
          provider: values.provider,
          model: values.model
        })
      } else {
        await window.sunny.schedules.create({
          name: values.name,
          prompt: values.prompt,
          cadence: values.cadence,
          agentId: values.agentId,
          projectId: values.projectId,
          enabled: values.enabled,
          provider: values.provider,
          model: values.model
        })
      }
      await loadSchedules()
      setEditor({ mode: 'closed' })
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleEnabled(schedule: Schedule, enabled: boolean): Promise<void> {
    setTogglingId(schedule.id)
    setLoadError(null)
    try {
      await window.sunny.schedules.update({ id: schedule.id, enabled })
      await loadSchedules()
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setTogglingId(null)
    }
  }

  async function handleRunNow(schedule: Schedule): Promise<void> {
    setRunningId(schedule.id)
    setLoadError(null)
    try {
      await window.sunny.schedules.runNow({ id: schedule.id })
      await loadSchedules()
      setRunConfirm(`“${schedule.name}” fired — a task was created on the board.`)
      if (runConfirmTimer.current) clearTimeout(runConfirmTimer.current)
      runConfirmTimer.current = setTimeout(() => setRunConfirm(null), 5000)
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setRunningId(null)
    }
  }

  function requestDelete(schedule: Schedule): void {
    setDeleteError(null)
    setPendingDelete(schedule)
  }

  function cancelDelete(): void {
    if (deleting) return
    setPendingDelete(null)
    setDeleteError(null)
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await window.sunny.schedules.delete({ id: pendingDelete.id })
      await loadSchedules()
      setPendingDelete(null)
    } catch (err) {
      setDeleteError(errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <PageHeader
        title="Schedules"
        description="Run an agent on a goal automatically on a cadence — Sunny creates a board task each time it fires."
        actions={
          <button
            type="button"
            onClick={openCreate}
            className="flex items-center gap-2 rounded-xl bg-amber-400 px-3.5 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New schedule
          </button>
        }
      />

      <div className="mt-3 min-h-[1.25rem] text-sm" role="status" aria-live="polite">
        {runConfirm ? (
          <span className="inline-flex items-center gap-1.5 text-status-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {runConfirm}
          </span>
        ) : null}
      </div>

      {loadError ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-status-blocked/40 bg-status-blocked/5 px-4 py-3 text-sm text-status-blocked"
        >
          Couldn&apos;t load schedules: {loadError}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Spinner label="Loading schedules" />
          Loading schedules…
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description="Schedules run an agent on a goal automatically on a cadence. When one fires, Sunny creates a board task in the chosen project, assigns it to the chosen agent, and works it — even when the board's auto-worker is off."
          actionLabel="New schedule"
          onAction={openCreate}
          className="mt-8"
        />
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              agentName={
                schedule.agent_id
                  ? (agentNames.get(schedule.agent_id) ?? 'Unknown agent')
                  : 'Default agent'
              }
              projectName={
                schedule.project_id
                  ? (projectNames.get(schedule.project_id) ?? 'Unknown project')
                  : 'All / unassigned'
              }
              toggling={togglingId === schedule.id}
              running={runningId === schedule.id}
              onToggleEnabled={(s, enabled) => void handleToggleEnabled(s, enabled)}
              onRunNow={(s) => void handleRunNow(s)}
              onEdit={openEdit}
              onDelete={requestDelete}
            />
          ))}
        </div>
      )}

      {editor.mode !== 'closed' ? (
        <ScheduleForm
          mode={editor.mode === 'edit' ? 'edit' : 'create'}
          schedule={editor.mode === 'edit' ? editor.schedule : null}
          agents={agents}
          projects={projects}
          saving={saving}
          error={saveError}
          onSubmit={(values) => void handleSubmit(values)}
          onClose={closeEditor}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteScheduleDialog
          schedule={pendingDelete}
          deleting={deleting}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onClose={cancelDelete}
        />
      ) : null}
    </div>
  )
}
