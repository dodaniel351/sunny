import { useEffect, useRef } from 'react'

/**
 * Run `handler` whenever a task changes anywhere — the autonomous worker, a
 * schedule, or another window — via main's `tasks:changed` broadcast, debounced
 * so a burst of transitions collapses into a single call. For views derived from
 * task state (board columns, goal rollups, agent heartbeats) so they refresh live
 * instead of going stale until a manual reload.
 *
 * The handler is held in a ref, so a caller can pass a fresh closure each render
 * (e.g. one that depends on the active project) WITHOUT resubscribing every time.
 */
export function useTasksChanged(handler: () => void, debounceMs = 400): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.sunny.tasks.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => handlerRef.current(), debounceMs)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [debounceMs])
}
