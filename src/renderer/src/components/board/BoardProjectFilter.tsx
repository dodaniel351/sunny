import { ChevronDown, FolderOpen } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import type { Project } from '@shared/db/types'

interface BoardProjectFilterProps {
  projects: Project[]
  /** 'all' for every project, or a project id. */
  value: string
  onChange: (value: string) => void
}

/**
 * Board scope selector: "All Projects" (the fleet view) or a single project.
 * Independent of the Chats panel's active project — changing chat folders never
 * reshapes the Board.
 */
export function BoardProjectFilter({ projects, value, onChange }: BoardProjectFilterProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
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

  const current = value === 'all' ? null : projects.find((p) => p.id === value)
  const label = current?.name ?? 'All Projects'

  const optionClass = (active: boolean): string =>
    cn(
      'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
      active ? 'bg-amber-400/10 text-amber-300' : 'text-fg-muted hover:bg-ink-750 hover:text-fg'
    )

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Board project filter: ${label}`}
        className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
      >
        <FolderOpen className="h-4 w-4 text-amber-300/80" aria-hidden="true" />
        <span className="max-w-[12rem] truncate">{label}</span>
        <ChevronDown className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
      </button>

      {open ? (
        <ul
          id={menuId}
          role="listbox"
          aria-label="Board project filter"
          className="absolute right-0 top-full z-30 mt-1.5 max-h-72 w-56 overflow-y-auto rounded-xl border border-ink-700 bg-ink-800 p-1 shadow-panel"
        >
          <li role="none">
            <button
              type="button"
              role="option"
              aria-selected={value === 'all'}
              onClick={() => {
                onChange('all')
                setOpen(false)
              }}
              className={optionClass(value === 'all')}
            >
              All Projects
            </button>
          </li>
          {projects.map((p) => (
            <li key={p.id} role="none">
              <button
                type="button"
                role="option"
                aria-selected={p.id === value}
                onClick={() => {
                  onChange(p.id)
                  setOpen(false)
                }}
                className={optionClass(p.id === value)}
              >
                <span className="truncate">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
