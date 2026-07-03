import { useEffect } from 'react'
import { useUiStore } from '@renderer/store/uiStore'

/**
 * Prove the IPC pipe is live by round-tripping `window.sunny.ping()` once on
 * mount. Updates the UI store with connection status + reported core version.
 */
export function useCorePing(): void {
  const setCore = useUiStore((s) => s.setCore)

  useEffect(() => {
    let cancelled = false

    window.sunny
      .ping()
      .then((res) => {
        if (!cancelled) setCore('connected', res.version)
      })
      .catch(() => {
        if (!cancelled) setCore('offline')
      })

    return () => {
      cancelled = true
    }
  }, [setCore])
}
