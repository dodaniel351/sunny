import { ArrowUpRight, FileText, Undo2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { FileChips } from '@renderer/components/chat/FileChips'
import { Markdown } from '@renderer/components/chat/Markdown'
import { parseMessageFiles, parseMessageImages } from '@renderer/lib/attachments'
import { relativeTime } from '@renderer/lib/time'
import type { Chat, Message } from '@shared/db/types'

interface ReviewModalProps {
  /** The agent's work chat to review. */
  chatId: string
  /** The task this result belongs to, when known — enables "Request changes"
   *  (the critique re-queues the task and the resumed run fixes the result). */
  taskId?: string | null
  onClose: () => void
  /** Jump to the full chat (the modal hands control back to the caller). */
  onOpenChat: (chatId: string) => void
}

const btnBase =
  'inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'

/**
 * A report-style view of a completed agent run (structure layer): the result is
 * shown in a roomy modal — title, who/when, and the agent's final output — with
 * an "Open full chat" link to dive into the whole transcript. Opened from the
 * Activity feed instead of dropping the user straight into the chat.
 */
export function ReviewModal({
  chatId,
  taskId = null,
  onClose,
  onOpenChat
}: ReviewModalProps): JSX.Element {
  const [chat, setChat] = useState<Chat | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Rework-with-feedback: the critique box (shown when the task is known).
  const [reworkOpen, setReworkOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [reworkBusy, setReworkBusy] = useState(false)
  const [reworkError, setReworkError] = useState<string | null>(null)

  async function handleRework(): Promise<void> {
    if (!taskId || feedback.trim().length === 0) return
    setReworkBusy(true)
    setReworkError(null)
    try {
      await window.sunny.tasks.rework({ id: taskId, feedback: feedback.trim() })
      onClose() // the task re-queues; progress shows on the board
    } catch (err: unknown) {
      setReworkError(err instanceof Error ? err.message : 'Could not request changes.')
      setReworkBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.sunny.chats
      .get({ chatId })
      .then((res) => {
        if (cancelled) return
        setChat(res.chat)
        setMessages(res.messages)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load the result.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chatId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The result is the agent's final output (last assistant turn), with its images.
  const result = [...messages].reverse().find((m) => m.role === 'assistant') ?? null
  const images = result ? parseMessageImages(result.attachments) : []
  const files = result ? parseMessageFiles(result.attachments) : []
  const title = chat?.title ?? 'Review'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-panel"
      >
        <div className="flex items-start gap-3 border-b border-ink-700/60 px-6 py-4">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-fg-heading">{title}</h2>
            {result ? (
              <p className="mt-0.5 text-[11px] text-fg-subtle">
                {result.provider ? <span>{result.provider}</span> : null}
                {result.provider && result.model ? <span> · </span> : null}
                {result.model ? <span className="font-mono">{result.model}</span> : null}
                {result.created_at ? <span> · {relativeTime(result.created_at)}</span> : null}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-fg-muted">
              <Spinner label="Loading result" />
              Loading…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-status-blocked/40 bg-status-blocked/10 px-4 py-3 text-sm text-status-blocked">
              {error}
            </div>
          ) : result ? (
            <>
              {images.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {images.map((img, i) => (
                    <img
                      key={`${img.name}-${i}`}
                      src={img.dataUrl}
                      alt={img.name}
                      title={img.name}
                      className="max-h-56 max-w-full rounded-lg border border-ink-700 object-contain"
                    />
                  ))}
                </div>
              ) : null}
              <Markdown content={result.content} />
              {files.length > 0 ? <FileChips files={files} className="mt-4" /> : null}
            </>
          ) : (
            <p className="py-8 text-center text-sm text-fg-muted">
              No result was produced for this item yet.
            </p>
          )}
        </div>

        {/* Rework-with-feedback: critique → re-queue → the resumed run fixes it. */}
        {taskId && reworkOpen ? (
          <div className="border-t border-ink-700/60 px-6 py-4">
            <label
              htmlFor="rework-feedback"
              className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-fg-subtle"
            >
              What should change?
            </label>
            <textarea
              id="rework-feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              placeholder="e.g. Section 2 is missing sources; shorten the intro; use a table for the comparison."
              className="w-full resize-y rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            />
            {reworkError ? (
              <p className="mt-1.5 text-xs text-status-blocked" role="alert">
                {reworkError}
              </p>
            ) : null}
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setReworkOpen(false)}
                disabled={reworkBusy}
                className={`${btnBase} border border-ink-700 text-fg-muted hover:border-ink-600 hover:text-fg`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRework()}
                disabled={reworkBusy || feedback.trim().length === 0}
                className={`${btnBase} bg-amber-400 font-semibold text-ink-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {reworkBusy ? <Spinner className="text-ink-950" label="Requesting" /> : null}
                Send back for changes
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-ink-700/60 px-6 py-4">
          {taskId && !reworkOpen ? (
            <button
              type="button"
              onClick={() => setReworkOpen(true)}
              className={`${btnBase} mr-auto border border-ink-700 text-fg-muted hover:border-ink-600 hover:text-fg`}
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              Request changes
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className={`${btnBase} border border-ink-700 text-fg-muted hover:border-ink-600 hover:text-fg`}
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => onOpenChat(chatId)}
            className={`${btnBase} bg-amber-400 font-semibold text-ink-950 hover:bg-amber-300`}
          >
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            Open full chat
          </button>
        </div>
      </div>
    </div>
  )
}
