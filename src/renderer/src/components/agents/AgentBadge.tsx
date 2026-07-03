import { cn } from '@renderer/lib/cn'
import type { PermissionMode } from '@shared/db/types'

/** A small uppercase pill used on agent cards (Preset / permission mode). */
export function Badge({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        className
      )}
    >
      {children}
    </span>
  )
}

/** Human label for a permission mode. */
export const permissionModeLabel: Record<PermissionMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  autopilot: 'Autopilot'
}

/** Tint classes per permission mode, matched to the status palette. */
const permissionModeTint: Record<PermissionMode, string> = {
  ask: 'bg-status-queued/10 text-status-queued',
  plan: 'bg-status-info/10 text-status-info',
  autopilot: 'bg-amber-300/10 text-amber-300'
}

/** The permission-mode badge shown on every agent card. */
export function PermissionBadge({ mode }: { mode: PermissionMode }): JSX.Element {
  return <Badge className={permissionModeTint[mode]}>{permissionModeLabel[mode]}</Badge>
}
