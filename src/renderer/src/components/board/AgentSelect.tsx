import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@renderer/lib/cn'
import type { Agent } from '@shared/db/types'

interface AgentSelectProps {
  /** The agents to choose from (loaded once at the board level). */
  agents: Agent[]
  /** The currently selected agent, or null for the "empty" option. */
  value: Agent | null
  /** Fires with the chosen agent, or null when the empty option is picked. */
  onChange: (agent: Agent | null) => void
  /** Label shown on the trigger when nothing is selected (e.g. "Unassigned"). */
  emptyLabel: string
  /** Accessible label for the control (the listbox + trigger). */
  label: string
  /** Visual size — `card` is the compact variant used inside a task card. */
  size?: 'card' | 'header'
  /** Where the menu opens relative to the trigger. */
  align?: 'left' | 'right'
}

/** Fixed-position coordinates for the portaled menu (only the set edges apply). */
interface MenuCoords {
  top?: number
  bottom?: number
  left?: number
  right?: number
}

/**
 * A small, accessible agent picker (listbox) reused by the task card's Assignee
 * control and the board header's Default agent control. Lists every agent plus a
 * leading empty option ("Unassigned" / "None").
 *
 * The menu is rendered through a portal with fixed positioning so it is never
 * clipped by an ancestor's `overflow` (task cards and board columns both clip) —
 * it flips upward near the bottom edge and closes on outside click, Escape,
 * scroll, or resize.
 */
export function AgentSelect({
  agents,
  value,
  onChange,
  emptyLabel,
  label,
  size = 'card',
  align = 'left'
}: AgentSelectProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<MenuCoords | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const menuId = useId()

  /** Position the menu from the trigger's viewport rect (flips up if cramped). */
  function place(): void {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 280 && rect.top > spaceBelow
    const vertical: MenuCoords = openUp
      ? { bottom: window.innerHeight - rect.top + 6 }
      : { top: rect.bottom + 6 }
    const horizontal: MenuCoords =
      align === 'right' ? { right: window.innerWidth - rect.right } : { left: rect.left }
    setCoords({ ...vertical, ...horizontal })
  }

  function toggle(): void {
    if (open) {
      setOpen(false)
    } else {
      place()
      setOpen(true)
    }
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const t = e.target as Node
      if (containerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onResize = (): void => setOpen(false)
    // A scroll (capture, so inner scrollers like board columns count) would
    // detach the fixed menu from its trigger — close it. But scrolling INSIDE
    // the menu's own overflow must NOT close it, so ignore those.
    const onScroll = (e: Event): void => {
      const t = e.target as Node | null
      if (t && menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const triggerLabel = value?.name ?? emptyLabel

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${label}: ${triggerLabel}`}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 font-medium text-fg-muted',
          'transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
          size === 'card' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1.5 text-sm'
        )}
      >
        <span className="max-w-[10rem] truncate">{triggerLabel}</span>
        <ChevronDown
          className={cn('shrink-0 text-fg-subtle', size === 'card' ? 'h-3 w-3' : 'h-4 w-4')}
          aria-hidden="true"
        />
      </button>

      {open && coords
        ? createPortal(
            <ul
              ref={menuRef}
              id={menuId}
              role="listbox"
              aria-label={label}
              style={{
                position: 'fixed',
                top: coords.top,
                bottom: coords.bottom,
                left: coords.left,
                right: coords.right
              }}
              className={cn(
                'z-[100] max-h-64 w-52 overflow-y-auto rounded-xl',
                'border border-ink-700 bg-ink-800 p-1 shadow-panel'
              )}
            >
              <li role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={value === null}
                  onClick={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                    value === null
                      ? 'bg-amber-400/10 text-amber-300'
                      : 'text-fg-muted hover:bg-ink-750 hover:text-fg'
                  )}
                >
                  {emptyLabel}
                </button>
              </li>
              {agents.map((agent) => {
                const active = value?.id === agent.id
                return (
                  <li key={agent.id} role="none">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onChange(agent)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                        active
                          ? 'bg-amber-400/10 text-amber-300'
                          : 'text-fg-muted hover:bg-ink-750 hover:text-fg'
                      )}
                    >
                      <span className="truncate">{agent.name}</span>
                      {agent.role ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                          {agent.role}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>,
            document.body
          )
        : null}
    </div>
  )
}
