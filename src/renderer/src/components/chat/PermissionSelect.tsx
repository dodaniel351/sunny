import { ChevronDown, Shield } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Chip } from '@renderer/components/ui/Chip'
import { cn } from '@renderer/lib/cn'
import { useUiStore, type PermissionMode } from '@renderer/store/uiStore'

const PERMISSION_MODES: PermissionMode[] = ['Ask', 'Plan', 'Autopilot']
const PERMISSION_HINT: Record<PermissionMode, string> = {
  Ask: 'Confirm each tool action before it runs',
  Plan: 'Plan only — block tool actions',
  Autopilot: 'Run tool actions automatically'
}

/**
 * Permission-mode picker: sets the mode that gates an interactive chat's tool
 * actions (Ask confirms each, Plan blocks, Autopilot runs). Shared by the
 * dashboard composer and the in-chat composer so the mode is changeable both
 * before a chat starts AND mid-conversation (it applies to the next turn). Reads
 * the app-wide `permissionMode` store. Opens upward so it isn't clipped.
 */
export function PermissionSelect(): JSX.Element {
  const permissionMode = useUiStore((s) => s.permissionMode)
  const setPermissionMode = useUiStore((s) => s.setPermissionMode)
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

  return (
    <div ref={ref} className="relative">
      <Chip
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Permission mode: ${permissionMode}`}
      >
        <Shield className="h-4 w-4 text-amber-300" aria-hidden="true" />
        Permission: {permissionMode}
        <ChevronDown className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
      </Chip>

      {open ? (
        <ul
          id={menuId}
          role="listbox"
          aria-label="Permission mode"
          className={cn(
            'absolute bottom-full left-0 z-20 mb-2 w-60 overflow-hidden rounded-xl',
            'border border-ink-700 bg-ink-800 p-1 shadow-panel'
          )}
        >
          {PERMISSION_MODES.map((mode) => {
            const active = mode === permissionMode
            return (
              <li key={mode} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setPermissionMode(mode)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                    active
                      ? 'bg-amber-400/10 text-amber-300'
                      : 'text-fg-muted hover:bg-ink-750 hover:text-fg'
                  )}
                >
                  <span className="text-sm font-medium">{mode}</span>
                  <span className="text-[11px] text-fg-subtle">{PERMISSION_HINT[mode]}</span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
