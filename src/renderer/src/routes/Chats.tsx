import { Check, MessageSquare, MessageSquarePlus, Pencil, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '@renderer/components/ui/EmptyState'
import { PageHeader } from '@renderer/components/ui/PageHeader'
import { Panel } from '@renderer/components/ui/Panel'
import { Spinner } from '@renderer/components/ui/Spinner'
import { cn } from '@renderer/lib/cn'
import { relativeTime } from '@renderer/lib/time'
import { useUiStore } from '@renderer/store/uiStore'
import type { ChatSummary } from '@shared/ipc/contract'

const iconButton = cn(
  'flex h-8 w-8 items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-fg-muted',
  'transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
)

interface ChatRowProps {
  chat: ChatSummary
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

/** A single history row: open on click, with inline rename + confirm-delete. */
function ChatRow({ chat, onOpen, onRename, onDelete }: ChatRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const title = chat.title ?? 'Untitled chat'
  const when = relativeTime(chat.lastMessageAt ?? chat.updated_at)

  async function submitRename(e: FormEvent): Promise<void> {
    e.preventDefault()
    const next = draft.trim()
    if (next && next !== chat.title) await onRename(chat.id, next)
    setEditing(false)
  }

  function handleEditKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(false)
      setDraft(chat.title ?? '')
    }
  }

  if (editing) {
    return (
      <Panel className="p-4">
        <form onSubmit={submitRename} className="flex items-center gap-2">
          <label htmlFor={`rename-${chat.id}`} className="sr-only">
            Rename chat
          </label>
          <input
            id={`rename-${chat.id}`}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleEditKeyDown}
            autoFocus
            className="flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            placeholder="Chat title"
          />
          <button type="submit" aria-label="Save title" className={iconButton}>
            <Check className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Cancel rename"
            className={iconButton}
            onClick={() => {
              setEditing(false)
              setDraft(chat.title ?? '')
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
      </Panel>
    )
  }

  return (
    <Panel className="group flex items-center gap-4 p-4 transition-colors hover:border-ink-600">
      <button
        type="button"
        onClick={() => onOpen(chat.id)}
        className="flex flex-1 items-center gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-ink-700 bg-ink-800">
          <MessageSquare className="h-5 w-5 text-amber-300" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-fg-heading">{title}</span>
          <span className="mt-0.5 block text-xs text-fg-subtle">
            {when}
            {' · '}
            {chat.messageCount} {chat.messageCount === 1 ? 'message' : 'messages'}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {confirmingDelete ? (
          <>
            <span className="text-xs text-fg-muted">Delete?</span>
            <button
              type="button"
              aria-label="Confirm delete"
              className={cn(iconButton, 'border-status-blocked/50 text-status-blocked')}
              onClick={() => void onDelete(chat.id)}
            >
              <Check className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Cancel delete"
              className={iconButton}
              onClick={() => setConfirmingDelete(false)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Rename ${title}`}
              className={iconButton}
              onClick={() => {
                setDraft(chat.title ?? '')
                setEditing(true)
              }}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${title}`}
              className={iconButton}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </Panel>
  )
}

/** Sort newest-first by last activity (lastMessageAt, falling back to updated_at). */
function sortNewestFirst(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => {
    const at = new Date(a.lastMessageAt ?? a.updated_at).getTime()
    const bt = new Date(b.lastMessageAt ?? b.updated_at).getTime()
    return bt - at
  })
}

/** Chats history — every conversation, newest first, with open/rename/delete. */
export function Chats(): JSX.Element {
  const navigate = useNavigate()
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Scope the history to the active project (null = all chats), re-fetch on change.
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.sunny.chats.list({ projectId: activeProjectId ?? undefined })
      setChats(sortNewestFirst(list))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load chats.')
    } finally {
      setLoading(false)
    }
  }, [activeProjectId])

  useEffect(() => {
    void load()
  }, [load])

  const handleRename = useCallback(async (id: string, title: string): Promise<void> => {
    await window.sunny.chats.rename({ chatId: id, title })
    setChats((prev) => sortNewestFirst(prev.map((c) => (c.id === id ? { ...c, title } : c))))
  }, [])

  const handleDelete = useCallback(async (id: string): Promise<void> => {
    await window.sunny.chats.delete({ chatId: id })
    setChats((prev) => prev.filter((c) => c.id !== id))
  }, [])

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-10">
      <PageHeader
        title="Chats"
        description="Every conversation with Sunny and your agents, searchable and saved locally."
        actions={
          <button
            type="button"
            onClick={() => navigate('/')}
            className={cn(
              'inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-ink-950',
              'transition-colors hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
            )}
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            New Chat
          </button>
        }
      />

      <div className="mt-8">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-fg-muted">
            <Spinner label="Loading chats" />
            Loading chats…
          </div>
        ) : error ? (
          <div className="rounded-xl border border-status-blocked/40 bg-status-blocked/10 px-4 py-3 text-sm text-status-blocked">
            {error}
          </div>
        ) : chats.length === 0 ? (
          <EmptyState
            icon={MessageSquarePlus}
            title="No conversations yet"
            description="Start a chat from the dashboard composer. Your history lives on this machine and reopens anytime."
            actionLabel="New Chat"
            onAction={() => navigate('/')}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {chats.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                onOpen={(id) => navigate(`/chats/${id}`)}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
