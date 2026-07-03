import { cn } from '@renderer/lib/cn'
import type { MemoryKind, MemoryScope } from '@shared/db/types'
import { kindBadgeClass, kindLabels, scopeBadgeClass, scopeLabels } from './memoryMeta'

const base =
  'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide'

/** A small pill marking a memory's scope tier, tinted per tier. */
export function ScopeBadge({ scope }: { scope: MemoryScope }): JSX.Element {
  return <span className={cn(base, scopeBadgeClass[scope])}>{scopeLabels[scope]}</span>
}

/** A small pill marking a memory's kind, tinted per kind. */
export function KindBadge({ kind }: { kind: MemoryKind }): JSX.Element {
  return <span className={cn(base, kindBadgeClass[kind])}>{kindLabels[kind]}</span>
}
