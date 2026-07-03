import { Check, ChevronsUpDown, FolderKanban, Layers, Settings2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'
import { ManageProjectsDialog } from './ManageProjectsDialog'

/**
 * Active-project scope selector, mounted near the top of the sidebar (spec §7).
 *
 * Shows the active project's name (or "All Projects"). The dropdown lists "All
 * Projects", each active project, a divider, then "Manage projects…" which opens
 * the management modal. Selecting an item updates + persists the scope via the
 * store (`setActiveProject`).
 */
export function ProjectSwitcher(): JSX.Element {
  const projects = useUiStore((s) => s.projects)
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setActiveProject = useUiStore((s) => s.setActiveProject)

  const [open, setOpen] = useState(false)
  const [managing, setManaging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const active = activeProjectId ? (projects.find((p) => p.id === activeProjectId) ?? null) : null
  const label = active ? active.name : 'All Projects'

  // Close on outside click / Escape while the menu is open.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function select(id: string | null): void {
    setActiveProject(id)
    setOpen(false)
  }

  return (
    <div className="px-3 pb-2" ref={containerRef}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl border border-ink-700/70 bg-ink-850 px-3 py-2.5',
            'text-left transition-colors hover:border-ink-600 hover:bg-ink-800',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-ink-700 bg-ink-800">
            {active ? (
              <FolderKanban className="h-4 w-4 text-amber-300" aria-hidden="true" />
            ) : (
              <Layers className="h-4 w-4 text-amber-300" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-widest text-fg-subtle">
              Project
            </span>
            <span className="block truncate text-sm font-semibold text-fg-heading">{label}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        </button>

        {open ? (
          <div
            id={menuId}
            role="menu"
            className={cn(
              'absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-ink-700 bg-ink-850 shadow-panel',
              'max-h-80 overflow-y-auto'
            )}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeProjectId === null}
              onClick={() => select(null)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors',
                'hover:bg-ink-800 focus-visible:outline-none focus-visible:bg-ink-800',
                activeProjectId === null ? 'text-amber-300' : 'text-fg-muted'
              )}
            >
              <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 truncate font-medium">All Projects</span>
              {activeProjectId === null ? (
                <Check className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              ) : null}
            </button>

            {projects.map((project) => {
              const selected = activeProjectId === project.id
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => select(project.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors',
                    'hover:bg-ink-800 focus-visible:outline-none focus-visible:bg-ink-800',
                    selected ? 'text-amber-300' : 'text-fg-muted'
                  )}
                >
                  <FolderKanban className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate font-medium">{project.name}</span>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                  ) : null}
                </button>
              )
            })}

            <div className="my-1 h-px bg-ink-700/60" role="separator" aria-hidden="true" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setManaging(true)
              }}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-fg-muted transition-colors',
                'hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:bg-ink-800'
              )}
            >
              <Settings2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 truncate font-medium">Manage projects…</span>
            </button>
          </div>
        ) : null}
      </div>

      {managing ? <ManageProjectsDialog onClose={() => setManaging(false)} /> : null}
    </div>
  )
}
