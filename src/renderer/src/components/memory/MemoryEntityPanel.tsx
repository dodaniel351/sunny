import { ArrowRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'
import type { MemoryEntityDetail } from '@shared/ipc/contract'
import { KindBadge, ScopeBadge } from './MemoryBadge'
import { entityColor, provenanceBadgeClass, provenanceLabels } from './memoryMeta'

interface MemoryEntityPanelProps {
  /** The selected entity id, or null when nothing is selected. */
  entityId: string | null
  /** Display name as known from the graph (shown immediately while detail loads). */
  entityName: string
  onClose: () => void
}

const badgeBase =
  'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide'

/**
 * Side panel for a selected graph node: loads `memories.entity({ id })` and shows
 * the entity's summary, its relations (with provenance badges), and the
 * observations that mention it. Re-fetches whenever the selected id changes; a
 * request token guards against out-of-order responses.
 */
export function MemoryEntityPanel({
  entityId,
  entityName,
  onClose
}: MemoryEntityPanelProps): JSX.Element {
  const [detail, setDetail] = useState<MemoryEntityDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (entityId === null) {
      setDetail(null)
      setError(null)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    setDetail(null)
    window.sunny.memories
      .entity({ id: entityId })
      .then((next) => {
        if (active) setDetail(next)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load this entity.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [entityId])

  const entity = detail?.entity
  const color = entity ? entityColor(entity.type) : entityColor('')

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-850 shadow-panel"
      aria-label="Entity details"
    >
      <header className="flex items-start justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
            <h2 className="truncate text-sm font-semibold text-fg-heading" title={entityName}>
              {entity?.name ?? entityName}
            </h2>
          </div>
          {entity ? (
            <span className="mt-1 inline-block text-xs uppercase tracking-wide text-fg-subtle">
              {entity.type}
              {entity.mention_count > 0
                ? ` · ${entity.mention_count} ${entity.mention_count === 1 ? 'mention' : 'mentions'}`
                : ''}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close entity details"
          className="shrink-0 rounded-lg p-1 text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-fg-muted">
            <Spinner label="Loading entity" />
            Loading…
          </div>
        ) : error ? (
          <div
            className="rounded-xl border border-status-blocked/40 bg-status-blocked/10 px-4 py-3 text-sm text-status-blocked"
            role="alert"
          >
            {error}
          </div>
        ) : detail ? (
          <div className="flex flex-col gap-5">
            {entity?.summary ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
                {entity.summary}
              </p>
            ) : (
              <p className="text-sm italic text-fg-subtle">No summary yet.</p>
            )}

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Relations ({detail.relations.length})
              </h3>
              {detail.relations.length === 0 ? (
                <p className="text-xs text-fg-subtle">No relations.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {detail.relations.map((rel) => {
                    const outgoing = rel.source_id === entity?.id
                    return (
                      <li
                        key={rel.id}
                        className="rounded-xl border border-ink-700/70 bg-ink-800 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                          <ArrowRight
                            className={cn('h-3 w-3 text-fg-subtle', !outgoing && 'rotate-180')}
                            aria-hidden="true"
                          />
                          <span className="font-medium text-fg">{rel.relation}</span>
                          <span
                            className={cn(
                              badgeBase,
                              provenanceBadgeClass[rel.provenance] ?? provenanceBadgeClass.ambiguous
                            )}
                          >
                            {provenanceLabels[rel.provenance] ?? rel.provenance}
                          </span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                Observations ({detail.observations.length})
              </h3>
              {detail.observations.length === 0 ? (
                <p className="text-xs text-fg-subtle">No observations mention this entity.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {detail.observations.map((obs) => (
                    <li
                      key={obs.id}
                      className="rounded-xl border border-ink-700/70 bg-ink-800 px-3 py-2.5"
                    >
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <KindBadge kind={obs.kind} />
                        <ScopeBadge scope={obs.scope} />
                        <span className="text-[11px] text-fg-subtle">
                          {relativeTime(obs.updated_at)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg">
                        {obs.content}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
