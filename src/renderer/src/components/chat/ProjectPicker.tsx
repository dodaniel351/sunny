import { ChevronDown, Folder, FolderPlus } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'

interface ProjectPickerProps {
  /** The chat's current project, or null for "No project". */
  projectId: string | null
  /** Move the chat to the chosen project (null = Unfiled). */
  onChange: (projectId: string | null) => void
}

/**
 * Compact project selector for the chat header — shows the chat's project and,
 * on open, lets the user move it to another project, to "No project", or spin up
 * a brand-new project inline and move the chat straight into it.
 */
export function ProjectPicker({ projectId, onChange }: ProjectPickerProps): JSX.Element {
  const projects = useUiStore((s) => s.projects)
  const loadProjects = useUiStore((s) => s.loadProjects)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Reset the inline-create state whenever the menu closes.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setNewName('')
    }
  }, [open])

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  const current = projectId ? projects.find((p) => p.id === projectId) : null
  const label = current?.name ?? 'No project'

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    try {
      const project = await window.sunny.projects.create({ name })
      await loadProjects()
      setActiveProject(project.id)
      onChange(project.id)
    } finally {
      setNewName('')
      setCreating(false)
      setOpen(false)
    }
  }

  const optionClass = (active: boolean): string =>
    cn(
      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
      active ? 'bg-amber-400/10 text-amber-300' : 'text-fg-muted hover:bg-ink-750 hover:text-fg'
    )

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Project: ${label} — click to move`}
        className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
      >
        <Folder className="h-3.5 w-3.5 text-amber-300/80" aria-hidden="true" />
        <span className="max-w-[12rem] truncate">{label}</span>
        <ChevronDown className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
      </button>

      {open ? (
        <div
          id={menuId}
          role="listbox"
          aria-label="Move to project"
          className="absolute right-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-ink-700 bg-ink-800 shadow-panel"
        >
          <ul className="max-h-64 overflow-y-auto p-1">
            <li role="none">
              <button
                type="button"
                role="option"
                aria-selected={projectId === null}
                onClick={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className={optionClass(projectId === null)}
              >
                No project
              </button>
            </li>
            {projects.map((p) => {
              const active = p.id === projectId
              return (
                <li key={p.id} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(p.id)
                      setOpen(false)
                    }}
                    className={optionClass(active)}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-amber-300/70" aria-hidden="true" />
                    <span className="truncate">{p.name}</span>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="border-t border-ink-700/60 p-1">
            {creating ? (
              <form onSubmit={handleCreate} className="flex flex-col gap-1.5 p-1.5">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setCreating(false)
                      setNewName('')
                    }
                  }}
                  placeholder="New project name…"
                  aria-label="New project name"
                  className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                />
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Create &amp; move here
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-amber-300 transition-colors hover:bg-ink-750 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                <FolderPlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                New Project…
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
