import { ShieldAlert, Terminal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import type { ChatConfirmRequest } from '@shared/ipc/contract'

/**
 * Global agent tool-approval dialog. Mounted once high in the tree (AppShell).
 *
 * Subscribes to `window.sunny.chat.onConfirm` for the lifetime of the app and,
 * for each request, shows a modal asking the user to Allow or Deny a
 * side-effecting agent action (e.g. writing a file or running a shell command).
 * Requests are handled one at a time — any that arrive while a dialog is open
 * are queued and shown in turn.
 *
 * Deny is the safe default: it's focused on open, and Esc / a backdrop click
 * both deny. Every request is answered via `respondConfirm` (matched by
 * requestId) so the main process is never left waiting.
 */
export function ToolConfirmDialog(): JSX.Element | null {
  // FIFO queue; the head (index 0) is the request currently shown.
  const [queue, setQueue] = useState<ChatConfirmRequest[]>([])
  const current = queue[0] ?? null

  const denyRef = useRef<HTMLButtonElement>(null)

  // Subscribe once for the app's lifetime. Each incoming request is appended.
  useEffect(() => {
    const unsubscribe = window.sunny.chat.onConfirm((req) => {
      setQueue((prev) => [...prev, req])
    })
    return unsubscribe
  }, [])

  // Answer the head request and advance the queue. Guarded against the dialog
  // already being closed (no current request) so a stray Esc is a no-op.
  const respond = useCallback((allow: boolean): void => {
    setQueue((prev) => {
      const [head, ...rest] = prev
      if (!head) return prev
      void window.sunny.chat.respondConfirm({ requestId: head.requestId, allow })
      return rest
    })
  }, [])

  // Focus Deny on open; wire Esc → Deny while a request is showing.
  useEffect(() => {
    if (!current) return
    denyRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        respond(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [current, respond])

  if (!current) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        // Backdrop click = Deny (safe default).
        if (e.target === e.currentTarget) respond(false)
      }}
    >
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" aria-hidden="true" />

      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tool-confirm-title"
        aria-describedby="tool-confirm-detail"
        className={cn(
          'relative z-10 flex w-full max-w-md flex-col overflow-hidden',
          'rounded-2xl border border-ink-700 bg-ink-850 shadow-panel'
        )}
      >
        <header className="flex items-start gap-3 border-b border-ink-700/60 px-6 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-400/10">
            <ShieldAlert className="h-5 w-5 text-amber-300" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="tool-confirm-title" className="text-base font-bold text-fg-heading">
              {current.title}
            </h2>
            <p className="mt-0.5 text-xs text-fg-subtle">
              An agent wants to run a tool that can change things.
            </p>
          </div>
        </header>

        <div className="space-y-3 px-6 py-5">
          <div
            id="tool-confirm-detail"
            className="flex items-start gap-2 rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5"
          >
            <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
            <code className="min-w-0 break-words font-mono text-xs leading-relaxed text-fg">
              {current.detail}
            </code>
          </div>
          <p className="text-xs text-fg-subtle">
            Tool: <span className="font-mono text-fg-muted">{current.tool}</span>
          </p>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-ink-700/60 px-6 py-4">
          <button
            type="button"
            onClick={() => respond(true)}
            className={cn(
              'rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950 transition-colors',
              'hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
            )}
          >
            Allow
          </button>
          <button
            ref={denyRef}
            type="button"
            onClick={() => respond(false)}
            className={cn(
              'rounded-xl border border-ink-700 px-4 py-2 text-sm font-medium text-fg-muted transition-colors',
              'hover:border-ink-600 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
            )}
          >
            Deny
          </button>
        </footer>
      </div>
    </div>
  )
}
