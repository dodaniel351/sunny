import { Cloud, Snowflake, Sparkle, Zap } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'

/** Centered "SUNNY CORE ACTIVE" status pill with a glyph cluster. */
export function CorePill(): JSX.Element {
  const coreStatus = useUiStore((s) => s.coreStatus)
  const isActive = coreStatus === 'connected'

  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5',
          'text-xs font-bold uppercase tracking-widest',
          isActive
            ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
            : 'border-ink-700 bg-ink-850 text-fg-muted'
        )}
      >
        <Sparkle
          className={cn('h-3.5 w-3.5', isActive && 'animate-pulse-glow')}
          aria-hidden="true"
        />
        Sunny Core {isActive ? 'Active' : coreStatus === 'connecting' ? 'Starting' : 'Offline'}
      </span>
      <span className="flex items-center gap-2 text-fg-subtle" aria-hidden="true">
        <Snowflake className="h-3.5 w-3.5" />
        <Cloud className="h-3.5 w-3.5" />
        <Zap className="h-3.5 w-3.5" />
      </span>
    </div>
  )
}
