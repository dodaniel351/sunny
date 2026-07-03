import { useEffect } from 'react'
import { useUiStore } from '@renderer/store/uiStore'

/**
 * Seed once on app mount: the active-project scope (project list + persisted
 * `active_project`, validated against the loaded projects) AND the user's default
 * chat model (persisted `default_provider`/`default_model`). Mirrors `useCorePing`
 * — a fire-once bootstrap in the shell.
 */
export function useProjectsInit(): void {
  const loadProjects = useUiStore((s) => s.loadProjects)
  const loadDefaultModel = useUiStore((s) => s.loadDefaultModel)

  useEffect(() => {
    void loadProjects()
    void loadDefaultModel()
  }, [loadProjects, loadDefaultModel])
}
