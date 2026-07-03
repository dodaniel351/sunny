import { Plus, Sun } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { ProjectSwitcher } from '@renderer/components/projects/ProjectSwitcher'
import { navItems } from '@renderer/data/nav'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'

const coreLabel: Record<ReturnType<typeof useUiStore.getState>['coreStatus'], string> = {
  connecting: 'Core connecting…',
  connected: 'Core connected',
  offline: 'Core offline'
}

const coreDot: Record<ReturnType<typeof useUiStore.getState>['coreStatus'], string> = {
  connecting: 'bg-status-queued animate-pulse-glow',
  connected: 'bg-status-success',
  offline: 'bg-status-blocked'
}

/** Left sidebar: brand, primary nav, "New" CTA, core-status footer. */
export function Sidebar(): JSX.Element {
  const coreStatus = useUiStore((s) => s.coreStatus)
  const coreVersion = useUiStore((s) => s.coreVersion)

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-ink-700/60 bg-ink-900">
      {/* Brand header */}
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-400 shadow-glow">
          <Sun className="h-6 w-6 text-ink-950" aria-hidden="true" />
        </div>
        <div className="leading-tight">
          <div className="text-lg font-bold text-amber-300">Sunny</div>
          <div className="text-xs text-fg-subtle">AI Command Center</div>
        </div>
      </div>

      {/* Active-project scope */}
      <ProjectSwitcher />

      {/* Primary nav */}
      <nav className="flex flex-col gap-1 px-3 py-2" aria-label="Primary">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5',
                'text-sm font-semibold uppercase tracking-wide transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                isActive
                  ? 'bg-amber-400/10 text-amber-300'
                  : 'text-fg-muted hover:bg-ink-800 hover:text-fg'
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'absolute left-0 top-1/2 h-6 -translate-y-1/2 rounded-r-full bg-amber-400 transition-all',
                    isActive ? 'w-1 opacity-100' : 'w-0 opacity-0'
                  )}
                  aria-hidden="true"
                />
                <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer: New CTA + core status */}
      <div className="mt-auto flex flex-col gap-1 px-3 pb-4">
        <button
          type="button"
          className={cn(
            'mb-3 flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3',
            'text-sm font-semibold text-ink-950 shadow-glow transition-colors hover:bg-amber-300',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          )}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Chat
        </button>

        <div className="mt-3 flex items-center gap-2 px-3 text-xs text-fg-subtle">
          <span className={cn('h-2 w-2 rounded-full', coreDot[coreStatus])} aria-hidden="true" />
          <span>{coreLabel[coreStatus]}</span>
          {coreVersion ? <span className="text-fg-subtle/70">v{coreVersion}</span> : null}
        </div>
      </div>
    </aside>
  )
}
