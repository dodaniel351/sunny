import { useCallback, useEffect } from 'react'
import { useUiStore } from '@renderer/store/uiStore'
import type { ProviderStatus } from '@shared/ipc/contract'

interface UseProvidersResult {
  providers: ProviderStatus[]
  loaded: boolean
  /** Re-fetch provider statuses (e.g. after saving/removing a key). */
  refresh: () => Promise<void>
}

/**
 * Load provider statuses into the UI store on mount and expose a refresh fn.
 * Centralises `providers.list()` so the composer, chat view, and settings all
 * read from one place and stay in sync after key changes.
 */
export function useProviders(): UseProvidersResult {
  const providers = useUiStore((s) => s.providers)
  const loaded = useUiStore((s) => s.providersLoaded)
  const setProviders = useUiStore((s) => s.setProviders)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.sunny.providers.list()
    setProviders(next)
  }, [setProviders])

  useEffect(() => {
    let cancelled = false
    window.sunny.providers
      .list()
      .then((next) => {
        if (!cancelled) setProviders(next)
      })
      .catch(() => {
        // Leave the store empty; the UI degrades to "Add a key in Settings".
      })
    return () => {
      cancelled = true
    }
  }, [setProviders])

  return { providers, loaded, refresh }
}
