import { ChevronDown, Globe, Search, Sparkles } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@renderer/lib/cn'
import { useUiStore } from '@renderer/store/uiStore'
import { isUsableProvider, usableModels } from '@renderer/lib/providers'
import type { ProviderStatus } from '@shared/ipc/contract'

/**
 * Usable providers only — connected, toggled on, and offering at least one
 * enabled model. The source for the grouped model menu.
 */
function useUsableProviders(): ProviderStatus[] {
  const providers = useUiStore((s) => s.providers)
  return providers.filter((p) => isUsableProvider(p) && usableModels(p).length > 0)
}

/**
 * The composer's model chip turned into a real selector. Models are grouped
 * under each connected provider's label; picking one sets BOTH the provider and
 * the model in the store so a send/create uses the right key. If nothing is
 * connected it prompts the user to add a key in Settings.
 */
export function ModelSelector(): JSX.Element {
  const navigate = useNavigate()
  const usable = useUsableProviders()
  const selectedProvider = useUiStore((s) => s.selectedProvider)
  const selectedModel = useUiStore((s) => s.selectedModel)
  const setSelectedModel = useUiStore((s) => s.setSelectedModel)
  const defaultProvider = useUiStore((s) => s.defaultProvider)
  const defaultModel = useUiStore((s) => s.defaultModel)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Start each open with a clean filter.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Defensive fallback: if the current selection points at a provider/model
  // that's no longer usable (disabled provider or model turned off), move it to
  // the configured default when that's usable, else the first available option.
  // The store re-resolves on refresh; this guards against any drift in between.
  useEffect(() => {
    const activeProvider = usable.find((p) => p.kind === selectedProvider)
    const stillValid =
      activeProvider !== undefined &&
      activeProvider.models.some((m) => m.id === selectedModel) &&
      !activeProvider.disabledModels.includes(selectedModel ?? '')
    if (stillValid) return
    // Prefer the user's default if it resolves to a usable option.
    const defProvider = usable.find((p) => p.kind === defaultProvider)
    if (
      defProvider &&
      defaultModel &&
      usableModels(defProvider).some((m) => m.id === defaultModel)
    ) {
      setSelectedModel(defProvider.kind, defaultModel)
      return
    }
    const first = usable[0]
    if (!first) return
    const firstModel = usableModels(first)[0]
    if (firstModel) setSelectedModel(first.kind, firstModel.id)
  }, [usable, selectedProvider, selectedModel, defaultProvider, defaultModel, setSelectedModel])

  if (usable.length === 0) {
    return (
      <button
        type="button"
        onClick={() => navigate('/settings')}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-dim',
          'px-3.5 py-2 text-sm font-medium text-amber-300',
          'transition-colors hover:border-amber-400/70 hover:bg-amber-dim/80',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
        )}
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        Add a key in Settings
      </button>
    )
  }

  // Resolve the active model's label within its provider for the trigger.
  const activeProvider = usable.find((p) => p.kind === selectedProvider)
  const activeLabel =
    activeProvider?.models.find((m) => m.id === selectedModel)?.label ??
    selectedModel ??
    'Select a model'

  // Models grouped by provider, filtered by the search query (matches id or label).
  const q = query.trim().toLowerCase()
  const groups = usable
    .map((provider) => ({
      provider,
      models: usableModels(provider).filter(
        (m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
      )
    }))
    .filter((g) => g.models.length > 0)

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Model: ${activeLabel}`}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-850',
          'px-3.5 py-2 text-sm font-medium text-fg-muted',
          'transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
        )}
      >
        <Sparkles className="h-4 w-4 text-amber-300" aria-hidden="true" />
        {activeLabel}
        <ChevronDown className="h-4 w-4 text-fg-subtle" aria-hidden="true" />
      </button>

      {open ? (
        <div
          className={cn(
            'absolute bottom-full z-20 mb-2 w-80 overflow-hidden rounded-xl',
            'border border-ink-700 bg-ink-800 shadow-panel'
          )}
        >
          <div className="border-b border-ink-700/60 p-2">
            <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const top = groups[0]
                    if (top) {
                      setSelectedModel(top.provider.kind, top.models[0].id)
                      setOpen(false)
                    }
                  }
                }}
                placeholder="Search models…"
                aria-label="Search models"
                className="w-full bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
              />
            </div>
          </div>
          <ul
            id={menuId}
            role="listbox"
            aria-label="Select a model"
            className="max-h-72 overflow-y-auto p-1"
          >
            {groups.length === 0 ? (
              <li role="none" className="px-3 py-6 text-center text-sm text-fg-subtle">
                No models match “{query}”.
              </li>
            ) : (
              groups.map(({ provider, models }) => (
                <li key={provider.kind} role="none">
                  <div
                    role="presentation"
                    className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle"
                  >
                    {provider.label}
                  </div>
                  <ul role="group" aria-label={provider.label} className="flex flex-col">
                    {models.map((model) => {
                      const active =
                        provider.kind === selectedProvider && model.id === selectedModel
                      return (
                        <li key={`${provider.kind}:${model.id}`} role="none">
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => {
                              setSelectedModel(provider.kind, model.id)
                              setOpen(false)
                            }}
                            className={cn(
                              'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm',
                              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                              active
                                ? 'bg-amber-400/10 text-amber-300'
                                : 'text-fg-muted hover:bg-ink-750 hover:text-fg'
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              {provider.webCapable ? (
                                <Globe
                                  className="h-3 w-3 shrink-0 text-amber-300/80"
                                  aria-label="Can search the web"
                                />
                              ) : null}
                              <span className="truncate">{model.label}</span>
                            </span>
                            {typeof model.contextWindow === 'number' ? (
                              <span className="shrink-0 text-xs text-fg-subtle">
                                {Math.round(model.contextWindow / 1000)}k
                              </span>
                            ) : null}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
