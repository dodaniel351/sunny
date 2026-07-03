import { Archive, ArchiveRestore, Check, FolderKanban, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'
import type { Project } from '@shared/db/types'

const inputClass = cn(
  'w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg',
  'placeholder:text-fg-subtle transition-colors',
  'focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30',
  'disabled:cursor-not-allowed disabled:opacity-50'
)

const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-fg-subtle'

const iconButton = cn(
  'flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 bg-ink-900 text-fg-muted',
  'transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
  'disabled:cursor-not-allowed disabled:opacity-40'
)

interface ProjectRowProps {
  project: Project
  busy: boolean
  onRename: (id: string, name: string, description: string | null) => Promise<void>
  onArchiveToggle: (project: Project) => Promise<void>
  onDelete: (project: Project) => void
}

/** One project row: inline rename + edit description, archive/unarchive, delete. */
function ProjectRow({
  project,
  busy,
  onRename,
  onArchiveToggle,
  onDelete
}: ProjectRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const archived = project.archived === 1

  const nameFieldId = useId()
  const descFieldId = useId()

  function beginEdit(): void {
    setName(project.name)
    setDescription(project.description ?? '')
    setEditing(true)
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const next = name.trim()
    if (!next) return
    await onRename(project.id, next, description.trim() ? description.trim() : null)
    setEditing(false)
  }

  if (editing) {
    return (
      <form
        onSubmit={submit}
        className="space-y-2 rounded-xl border border-ink-700 bg-ink-900/60 p-3"
      >
        <div className="space-y-1">
          <label htmlFor={nameFieldId} className="sr-only">
            Project name
          </label>
          <input
            id={nameFieldId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            disabled={busy}
            placeholder="Project name"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={descFieldId} className="sr-only">
            Description
          </label>
          <textarea
            id={descFieldId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="Description (optional)"
            className={cn(inputClass, 'resize-y leading-relaxed')}
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim().length === 0}
            className={cn(
              'rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors',
              'hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            Save
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-700/70 bg-ink-900/40 px-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-700 bg-ink-800">
        <FolderKanban
          className={cn('h-4 w-4', archived ? 'text-fg-subtle' : 'text-amber-300')}
          aria-hidden="true"
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'truncate text-sm font-semibold',
              archived ? 'text-fg-muted' : 'text-fg-heading'
            )}
          >
            {project.name}
          </span>
          {archived ? (
            <span className="shrink-0 rounded-full border border-ink-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
              Archived
            </span>
          ) : null}
        </div>
        {project.description ? (
          <p className="mt-0.5 truncate text-xs text-fg-subtle">{project.description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={beginEdit}
          disabled={busy}
          aria-label={`Edit ${project.name}`}
          className={iconButton}
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void onArchiveToggle(project)}
          disabled={busy}
          aria-label={archived ? `Unarchive ${project.name}` : `Archive ${project.name}`}
          className={iconButton}
        >
          {archived ? (
            <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Archive className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={() => onDelete(project)}
          disabled={busy}
          aria-label={`Delete ${project.name}`}
          className={cn(iconButton, 'hover:border-status-blocked/50 hover:text-status-blocked')}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

interface ManageProjectsDialogProps {
  onClose: () => void
}

/**
 * Project management modal (spec §7). Lists projects (with an archived toggle),
 * and supports create / rename + edit description / archive-unarchive / delete.
 *
 * Every mutation refreshes the shared store (`projects` + the switcher) and, if
 * the active project is archived or deleted, resets the scope to "All Projects".
 */
export function ManageProjectsDialog({ onClose }: ManageProjectsDialogProps): JSX.Element {
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setProjects = useUiStore((s) => s.setProjects)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const loadProjects = useUiStore((s) => s.loadProjects)

  const [projects, setLocalProjects] = useState<Project[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)

  // Pending delete confirmation (the project to delete, or null).
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null)

  const titleId = useId()
  const newNameId = useId()
  const newDescId = useId()
  const nameRef = useRef<HTMLInputElement>(null)

  /** Load the project list for the dialog (always includes archived, then we
   *  filter locally so the "show archived" toggle is instant). */
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const all = await window.sunny.projects.list({ includeArchived: true })
      setLocalProjects(all)
      // Keep the global store (switcher) in sync with the active subset.
      setProjects(all.filter((p) => p.archived === 0))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load projects.')
    } finally {
      setLoading(false)
    }
  }, [setProjects])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    nameRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const visible = showArchived ? projects : projects.filter((p) => p.archived === 0)

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault()
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    setError(null)
    try {
      await window.sunny.projects.create({
        name,
        description: newDescription.trim() ? newDescription.trim() : null
      })
      setNewName('')
      setNewDescription('')
      await refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create project.')
    } finally {
      setCreating(false)
    }
  }

  const handleRename = useCallback(
    async (id: string, name: string, description: string | null): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        await window.sunny.projects.update({ id, name, description })
        await refresh()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save project.')
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const handleArchiveToggle = useCallback(
    async (project: Project): Promise<void> => {
      const nextArchived = project.archived === 0
      setBusy(true)
      setError(null)
      try {
        await window.sunny.projects.update({ id: project.id, archived: nextArchived })
        // Archiving the active project drops the scope back to "All Projects".
        if (nextArchived && activeProjectId === project.id) setActiveProject(null)
        await refresh()
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to update project.')
      } finally {
        setBusy(false)
      }
    },
    [activeProjectId, setActiveProject, refresh]
  )

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    const project = pendingDelete
    setBusy(true)
    setError(null)
    try {
      await window.sunny.projects.delete({ id: project.id })
      if (activeProjectId === project.id) setActiveProject(null)
      setPendingDelete(null)
      await refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.')
    } finally {
      setBusy(false)
    }
  }

  // After any store-affecting change, also refresh the global store's view so a
  // closed dialog leaves the switcher consistent (defensive — refresh already
  // calls setProjects, but loadProjects re-validates the active id).
  useEffect(() => {
    return () => {
      void loadProjects()
    }
  }, [loadProjects])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden',
          'rounded-2xl border border-ink-700 bg-ink-850 shadow-panel'
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-ink-700/60 px-6 py-4">
          <h2 id={titleId} className="text-lg font-bold text-fg-heading">
            Manage projects
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          {/* Create */}
          <form
            onSubmit={handleCreate}
            className="space-y-2 rounded-xl border border-ink-700 bg-ink-900/40 p-3"
          >
            <div className="space-y-1.5">
              <label htmlFor={newNameId} className={labelClass}>
                New project <span className="text-amber-300">*</span>
              </label>
              <input
                id={newNameId}
                ref={nameRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={creating}
                placeholder="e.g. Q3 Launch"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={newDescId} className={labelClass}>
                Description
              </label>
              <textarea
                id={newDescId}
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                disabled={creating}
                rows={2}
                placeholder="What this project is about (optional)"
                className={cn(inputClass, 'resize-y leading-relaxed')}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={creating || newName.trim().length === 0}
                className={cn(
                  'inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 transition-colors',
                  'hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                  'disabled:cursor-not-allowed disabled:opacity-40'
                )}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {creating ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </form>

          {/* List header + archived toggle */}
          <div className="flex items-center justify-between">
            <span className={labelClass}>Projects</span>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-fg-muted">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 accent-amber-400"
              />
              Show archived
            </label>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-status-blocked">
              {error}
            </p>
          ) : null}

          {loading ? (
            <p className="py-6 text-center text-sm text-fg-muted">Loading projects…</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-muted">
              {showArchived
                ? 'No projects yet — create one above.'
                : 'No active projects. Create one above, or show archived.'}
            </p>
          ) : (
            <div className="space-y-2">
              {visible.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  busy={busy}
                  onRename={handleRename}
                  onArchiveToggle={handleArchiveToggle}
                  onDelete={setPendingDelete}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {pendingDelete ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPendingDelete(null)
          }}
        >
          <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" aria-hidden="true" />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={`Delete ${pendingDelete.name}`}
            className="relative z-10 w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-850 p-6 shadow-panel"
          >
            <h3 className="text-lg font-bold text-fg-heading">Delete project</h3>
            <p className="mt-2 text-sm text-fg-muted">
              Delete <span className="font-semibold text-fg">{pendingDelete.name}</span>? Its chats,
              tasks, and memories will move to Unassigned — they are not deleted.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={busy}
                className="rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={busy}
                className={cn(
                  'inline-flex items-center gap-2 rounded-xl bg-status-blocked px-4 py-2 text-sm font-semibold text-ink-950 transition-colors',
                  'hover:bg-status-blocked/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-blocked/60',
                  'disabled:cursor-not-allowed disabled:opacity-40'
                )}
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
