import { Sun } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { navItems } from '@renderer/data/nav'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'

const coreDot: Record<ReturnType<typeof useUiStore.getState>['coreStatus'], string> = {
  connecting: 'bg-status-queued animate-pulse-glow',
  connected: 'bg-status-success',
  offline: 'bg-status-blocked'
}

const coreLabel: Record<ReturnType<typeof useUiStore.getState>['coreStatus'], string> = {
  connecting: 'Core connecting…',
  connected: 'Core connected',
  offline: 'Core offline'
}

/**
 * The thin left rail: Sunny mark, the section icons (Chats / Board / Agents /
 * Schedules / Memory / Settings), and the core-status + version at the bottom.
 * "Chats" stays active on both the home route and any /chats path.
 */
export function IconRail(): JSX.Element {
  const { pathname } = useLocation()
  const coreStatus = useUiStore((s) => s.coreStatus)
  const coreVersion = useUiStore((s) => s.coreVersion)
  const unseenActivityCount = useUiStore((s) => s.unseenActivityCount)
  const pendingApprovalsCount = useUiStore((s) => s.pendingApprovalsCount)

  const isActive = (to: string): boolean =>
    to === '/chats' ? pathname === '/' || pathname.startsWith('/chats') : pathname.startsWith(to)

  // Per-route badge counts (structure layer). A count of 0 renders no badge.
  const badges: Record<string, number> = {
    '/activity': unseenActivityCount,
    '/approvals': pendingApprovalsCount
  }

  return (
    <aside className="flex h-full w-16 shrink-0 flex-col items-center border-r border-ink-700/60 bg-ink-950 py-3">
      <Link
        to="/chats"
        aria-label="Sunny home"
        className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-400 shadow-glow"
      >
        <Sun className="h-5 w-5 text-ink-950" aria-hidden="true" />
      </Link>

      <nav className="flex flex-1 flex-col items-center gap-1 pt-3" aria-label="Primary">
        {navItems.map(({ to, label, icon: Icon }) => {
          const active = isActive(to)
          const badge = badges[to] ?? 0
          return (
            <Link
              key={to}
              to={to}
              title={label}
              aria-label={badge > 0 ? `${label} (${badge} new)` : label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex w-14 flex-col items-center gap-1 rounded-xl py-1.5 text-[10px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                active ? 'text-amber-300' : 'text-fg-subtle hover:text-fg'
              )}
            >
              <span
                className={cn(
                  'relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors',
                  active ? 'bg-amber-400/15' : 'group-hover:bg-ink-800'
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {badge > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-ink-950 ring-2 ring-ink-950">
                    {badge > 99 ? '99+' : badge}
                  </span>
                ) : null}
              </span>
              {label}
            </Link>
          )
        })}
      </nav>

      <div
        className="flex flex-col items-center gap-1 pt-2 text-[9px] text-fg-subtle"
        title={coreLabel[coreStatus]}
      >
        <span
          className={cn('h-2 w-2 rounded-full', coreDot[coreStatus])}
          aria-label={coreLabel[coreStatus]}
        />
        {coreVersion ? <span>v{coreVersion}</span> : null}
      </div>
    </aside>
  )
}
