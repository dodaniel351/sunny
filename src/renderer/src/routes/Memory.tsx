import { Brain, Plus, Search, SearchX, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AddMemoryForm } from '@renderer/components/memory/AddMemoryForm'
import { MemoryEntityPanel } from '@renderer/components/memory/MemoryEntityPanel'
import { MemoryGraph } from '@renderer/components/memory/MemoryGraph'
import { MemoryRow } from '@renderer/components/memory/MemoryRow'
import { MemoryStatusBar } from '@renderer/components/memory/MemoryStatusBar'
import { EmbeddingPicker } from '@renderer/components/memory/EmbeddingPicker'
import { RelevanceControl } from '@renderer/components/memory/RelevanceControl'
import { ScopeFilter, type ScopeFilterValue } from '@renderer/components/memory/ScopeFilter'
import { useMemories } from '@renderer/components/memory/useMemories'
import { useMemoryGraph } from '@renderer/components/memory/useMemoryGraph'
import { ViewToggle, type MemoryViewMode } from '@renderer/components/memory/ViewToggle'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'

const SEARCH_DEBOUNCE_MS = 250

/**
 * Memory browser (spec §5): a status bar (counts + auto-memory toggle + embedding
 * note), a Graph/List toggle, search + scope filter, and the two views. List is
 * the existing debounced `memories.list({ query, scope })`; Graph is the
 * force-directed knowledge graph (`memories.graph`) with a click-to-inspect side
 * panel (`memories.entity`). The list stays the accessible alternative to the
 * visual graph.
 */
export function Memory(): JSX.Element {
  const [view, setView] = useState<MemoryViewMode>('list')
  const [scope, setScope] = useState<ScopeFilterValue>(undefined)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null)

  // Active project scope (null = "All Projects"). Drives the list/graph queries
  // below and the header scope indicator. Resolve its name from the loaded list.
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const projects = useUiStore((s) => s.projects)
  const activeProjectName =
    activeProjectId !== null ? (projects.find((p) => p.id === activeProjectId)?.name ?? null) : null

  // Seed the search box once from a query staged by the dashboard SearchBar,
  // then clear it so a later visit doesn't re-apply a stale term.
  const pendingMemoryQuery = useUiStore((s) => s.pendingMemoryQuery)
  const setPendingMemoryQuery = useUiStore((s) => s.setPendingMemoryQuery)
  useEffect(() => {
    if (pendingMemoryQuery === null) return
    setSearchInput(pendingMemoryQuery)
    setPendingMemoryQuery(null)
  }, [pendingMemoryQuery, setPendingMemoryQuery])

  // Debounce the raw input into the query that actually hits the backend.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchInput), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [searchInput])

  // Scope the list + graph to the active project. null → undefined ("all"); never
  // pass null to the IPC layer. Both hooks re-fetch when activeProjectId changes.
  const projectId = activeProjectId ?? undefined

  const { memories, loading, error, create, update, remove } = useMemories({
    scope,
    query: debouncedQuery,
    projectId
  })

  // The graph + status (status is shown in both views; graph data fetched lazily).
  const {
    graph,
    status,
    loading: graphLoading,
    error: graphError,
    refresh: refreshMemory,
    setAuto
  } = useMemoryGraph({ scope, projectId, enabled: view === 'graph' })

  const hasQuery = debouncedQuery.trim().length > 0
  const filtered = scope !== undefined || hasQuery
  const count = memories.length

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-10">
      <PageHeader
        title="Memory"
        description="Browse, search, edit, and prune what Sunny remembers across sessions, projects, and globally."
        actions={
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
            className={cn(
              'flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              adding
                ? 'border border-ink-700 bg-ink-850 text-fg-muted hover:text-fg'
                : 'bg-amber-400 text-ink-950 hover:bg-amber-300'
            )}
          >
            {adding ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {adding ? 'Close' : 'Add memory'}
          </button>
        }
      />

      <p className="mt-2 text-xs text-fg-subtle" aria-live="polite">
        {activeProjectId !== null
          ? `Showing memory for ${activeProjectName ?? 'this project'}`
          : 'Showing all projects'}
      </p>

      <div className="mt-6">
        <MemoryStatusBar
          status={status}
          loading={graphLoading}
          onToggleAuto={(enabled) => void setAuto(enabled)}
        />
      </div>

      <div className="mt-4">
        <EmbeddingPicker onChanged={() => void refreshMemory()} />
      </div>

      <div className="mt-3">
        <RelevanceControl embeddingsAvailable={status?.embeddingsAvailable ?? false} />
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <label htmlFor="memory-search" className="sr-only">
            Search memories
          </label>
          <input
            id="memory-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search memories…"
            className="w-full rounded-xl border border-ink-700 bg-ink-850 py-2.5 pl-11 pr-4 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
          />
        </div>
        <div className="flex items-center gap-3">
          <ScopeFilter value={scope} onChange={setScope} />
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {adding ? (
        <div className="mt-4">
          <AddMemoryForm onCreate={create} onCancel={() => setAdding(false)} />
        </div>
      ) : null}

      {view === 'list' ? (
        <>
          <div className="mt-6 flex items-center justify-between">
            <p
              className="text-xs font-medium uppercase tracking-wide text-fg-subtle"
              aria-live="polite"
            >
              {loading
                ? 'Loading…'
                : `${count} ${count === 1 ? 'memory' : 'memories'}${filtered ? ' shown' : ''}`}
            </p>
          </div>

          <div className="mt-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-fg-muted">
                <Spinner label="Loading memories" />
                Loading memories…
              </div>
            ) : error ? (
              <div
                className="rounded-2xl border border-status-blocked/40 bg-status-blocked/10 px-5 py-4 text-sm text-status-blocked"
                role="alert"
              >
                {error}
              </div>
            ) : count === 0 ? (
              filtered ? (
                <EmptyState
                  icon={SearchX}
                  title="No memories match"
                  description="Try a different search term or switch the scope filter."
                />
              ) : (
                <EmptyState
                  icon={Brain}
                  title="No memories yet"
                  description="Sunny will remember things here as you work — or add one yourself."
                  actionLabel="Add a memory"
                  onAction={() => setAdding(true)}
                />
              )
            ) : (
              <ul className="flex flex-col gap-3">
                {memories.map((memory) => (
                  <MemoryRow key={memory.id} memory={memory} onUpdate={update} onDelete={remove} />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div
          className={cn(
            'mt-6 grid h-[calc(100vh-18rem)] min-h-[34rem] gap-4',
            selected ? 'lg:grid-cols-[1fr_22rem]' : 'grid-cols-1'
          )}
        >
          <MemoryGraph
            entities={graph.entities}
            relations={graph.relations}
            loading={graphLoading}
            error={graphError}
            active={view === 'graph'}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
          {selected ? (
            <div className="h-full min-h-0">
              <MemoryEntityPanel
                entityId={selected.id}
                entityName={selected.name}
                onClose={() => setSelected(null)}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
