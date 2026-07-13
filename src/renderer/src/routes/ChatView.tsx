import { ArrowLeft, Check, FolderOpen, Pencil, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChatComposer } from '@renderer/components/chat/ChatComposer'
import { MessageBubble } from '@renderer/components/chat/MessageBubble'
import { Spinner } from '@renderer/components/ui/Spinner'
import { useChatStream } from '@renderer/hooks/useChatStream'
import { useProviders } from '@renderer/hooks/useProviders'
import { cn } from '@renderer/lib/cn'
import { useChatStore } from '@renderer/store/chatStore'
import { useUiStore } from '@renderer/store/uiStore'
import { ProjectPicker } from '@renderer/components/chat/ProjectPicker'
import type { Chat, Message } from '@shared/db/types'
import type { ImageAttachment } from '@shared/ipc/contract'

/** Map the composer's permission label to the backend's chat.send enum. */
const PERMISSION_TO_DB = { Ask: 'ask', Plan: 'plan', Autopilot: 'autopilot' } as const

/** A live (in-flight) assistant turn the view is rendering before persistence. */
interface ActiveStream {
  streamId: string
  /** The user message that triggered this stream — kept for retry. */
  prompt: string
  /** Whether web search was enabled for this turn — preserved across retry. */
  webSearch: boolean
}

/**
 * The conversation pane (`/chats/:chatId`). Loads the transcript, renders the
 * message list, streams the assistant reply, and lets the user send / stop /
 * retry. Subscribes to `chat.onStream` once on mount.
 */
export function ChatView(): JSX.Element {
  const { chatId } = useParams<{ chatId: string }>()
  const { providers } = useProviders()
  const selectedProvider = useUiStore((s) => s.selectedProvider)
  const selectedModel = useUiStore((s) => s.selectedModel)
  const permissionMode = useUiStore((s) => s.permissionMode)

  const startStream = useChatStore((s) => s.startStream)
  const clearStream = useChatStore((s) => s.clearStream)
  const bumpChats = useChatStore((s) => s.bumpChats)
  const consumePendingFirstMessage = useChatStore((s) => s.consumePendingFirstMessage)
  const folder = useChatStore((s) => (chatId ? s.chatFolders[chatId] : undefined)) ?? null
  const setChatFolder = useChatStore((s) => s.setChatFolder)
  const consumePendingFolder = useChatStore((s) => s.consumePendingFolder)

  const [chat, setChat] = useState<Chat | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  // Whether this chat's agent (if any) has web access — used to default the
  // composer's web-search toggle ON for agent-scoped chats.
  const [agentWebDefault, setAgentWebDefault] = useState(false)
  // The chat's agent name (if it runs as an agent) — shown under each response.
  const [agentName, setAgentName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [active, setActive] = useState<ActiveStream | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  // Inline title editing (rename the chat from its header).
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleError, setTitleError] = useState<string | null>(null)

  const activeStreamId = active?.streamId
  const buffer = useChatStore((s) => (activeStreamId ? s.streams[activeStreamId] : undefined))

  const scrollRef = useRef<HTMLDivElement>(null)
  const hasConnected = providers.some((p) => p.connected)
  const canSend = hasConnected && Boolean(selectedProvider) && Boolean(selectedModel)
  const streaming = Boolean(active && buffer && !buffer.done)

  // Resolve a friendly model label from the provider's catalog (falls back to
  // the raw id) for the per-response attribution footer.
  const modelLabelFor = useCallback(
    (provider: string | null, model: string | null): string | null => {
      if (!model) return null
      const p = providers.find((pp) => pp.kind === provider)
      return p?.models.find((mm) => mm.id === model)?.label ?? model
    },
    [providers]
  )

  // Resolve a provider's display label (falls back to its kind) — pairs with the
  // model in the footer so local (Ollama) vs. cloud reads at a glance.
  const providerLabelFor = useCallback(
    (provider: string | null): string | null => {
      if (!provider) return null
      return providers.find((pp) => pp.kind === provider)?.label ?? provider
    },
    [providers]
  )

  // --- Load transcript on mount / chatId change ---------------------------
  useEffect(() => {
    if (!chatId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    window.sunny.chats
      .get({ chatId })
      .then((res) => {
        if (cancelled) return
        setChat(res.chat)
        setMessages(res.messages)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load chat.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chatId])

  // --- Resolve the chat's agent web access (defaults the 🔍 toggle) -------
  // When this chat runs as an agent that has web access, default the composer's
  // web-search toggle ON. Best-effort: any failure just leaves it OFF.
  useEffect(() => {
    const agentId = chat?.agent_id
    if (!agentId) {
      setAgentWebDefault(false)
      setAgentName(null)
      return
    }
    let cancelled = false
    window.sunny.agents
      .list()
      .then((agents) => {
        if (cancelled) return
        const agent = agents.find((a) => a.id === agentId)
        setAgentWebDefault(agent?.web_access === 1)
        setAgentName(agent?.name ?? null)
      })
      .catch(() => {
        if (!cancelled) {
          setAgentWebDefault(false)
          setAgentName(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [chat?.agent_id])

  // --- Stream subscription (once on mount) --------------------------------
  // On `done`, swap the streaming buffer for the persisted message and clear.
  const handleDone = useCallback(
    (streamId: string, message: Message) => {
      setActive((cur) => {
        if (!cur || cur.streamId !== streamId) return cur
        setMessages((prev) => [...prev, message])
        clearStream(streamId)
        return null
      })
    },
    [clearStream]
  )
  useChatStream({ onDone: handleDone })

  // --- Auto-scroll as content arrives -------------------------------------
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, buffer?.text, active])

  // --- Send (also used for retry + dashboard handoff) ---------------------
  const sendMessage = useCallback(
    async (content: string, webSearch = false, images?: ImageAttachment[]): Promise<void> => {
      if (!chatId || !selectedProvider || !selectedModel) return
      setSendError(null)
      try {
        const { streamId, userMessage, title: derivedTitle } = await window.sunny.chat.send({
          chatId,
          content,
          model: selectedModel,
          provider: selectedProvider,
          folderPath: folder?.path,
          webSearch,
          permissionMode: PERMISSION_TO_DB[permissionMode],
          ...(images && images.length > 0 ? { images } : {})
        })
        setMessages((prev) => [...prev, userMessage])
        // Reflect a freshly auto-derived title in the header without a reload —
        // but never clobber a title the user has already set.
        if (derivedTitle) {
          setChat((cur) =>
            cur && (!cur.title || cur.title.trim() === '') ? { ...cur, title: derivedTitle } : cur
          )
        }
        startStream(streamId, chatId)
        setActive({ streamId, prompt: content, webSearch })
        // Refresh the Projects tree (recency + any auto-derived title).
        bumpChats()
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Failed to send message.')
      }
    },
    [chatId, selectedProvider, selectedModel, permissionMode, folder?.path, startStream, bumpChats]
  )

  // --- Consume a folder handed off from the dashboard ---------------------
  // Runs before the first message is sent so the very first turn carries it.
  useEffect(() => {
    if (!chatId) return
    const pending = consumePendingFolder()
    if (pending) setChatFolder(chatId, pending)
  }, [chatId, consumePendingFolder, setChatFolder])

  // --- Consume the first message handed off from the dashboard ------------
  // Wait until the transcript has loaded AND a model is resolved, so the handed
  // -off message is never consumed (and dropped) before we can actually send.
  useEffect(() => {
    if (!chatId || loading || active || !selectedProvider || !selectedModel) return
    const pending = consumePendingFirstMessage(chatId)
    // The user's dashboard web-search choice wins; otherwise fall back to the
    // chat agent's web-access default.
    if (pending)
      void sendMessage(pending.content, pending.webSearch || agentWebDefault, pending.images)
  }, [
    chatId,
    loading,
    active,
    selectedProvider,
    selectedModel,
    agentWebDefault,
    consumePendingFirstMessage,
    sendMessage
  ])

  async function handlePickFolder(): Promise<void> {
    if (!chatId) return
    const result = await window.sunny.folder.pick()
    if (result.path && result.name) {
      setChatFolder(chatId, { path: result.path, name: result.name })
    }
  }

  function handleClearFolder(): void {
    if (!chatId) return
    setChatFolder(chatId, null)
  }

  function handleStop(): void {
    if (!active) return
    void window.sunny.chat.cancel({ streamId: active.streamId })
    clearStream(active.streamId)
    setActive(null)
  }

  function handleRetry(): void {
    if (!active || !chatId || !selectedProvider || !selectedModel) return
    const { prompt, webSearch, streamId: failedId } = active
    clearStream(failedId)
    setActive(null)
    setSendError(null)
    // Re-stream the reply for the EXISTING last user turn — no new user message
    // (so no duplicate, and its images are preserved on the persisted turn).
    void (async () => {
      try {
        const { streamId } = await window.sunny.chat.retry({
          chatId,
          model: selectedModel,
          provider: selectedProvider,
          folderPath: folder?.path,
          webSearch,
          permissionMode: PERMISSION_TO_DB[permissionMode]
        })
        startStream(streamId, chatId)
        setActive({ streamId, prompt, webSearch })
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Failed to retry.')
      }
    })()
  }

  function beginEditTitle(): void {
    setTitleDraft(chat?.title ?? '')
    setTitleError(null)
    setEditingTitle(true)
  }

  // Persist a renamed title. Empty/unchanged input just closes the editor. A
  // title set here before the first message is preserved — the backend only
  // auto-derives a title from the first message when none has been set.
  async function saveTitle(): Promise<void> {
    if (!chatId) return
    const next = titleDraft.trim()
    setTitleError(null)
    if (next && next !== (chat?.title ?? '')) {
      try {
        await window.sunny.chats.rename({ chatId, title: next })
        setChat((cur) => (cur ? { ...cur, title: next } : cur))
        bumpChats()
      } catch (err: unknown) {
        setTitleError(err instanceof Error ? err.message : 'Failed to rename chat.')
        return
      }
    }
    setEditingTitle(false)
  }

  /** Move this chat to another project (or to Unfiled with null). Optimistic. */
  async function handleMoveProject(projectId: string | null): Promise<void> {
    if (!chatId) return
    const prev = chat?.project_id ?? null
    if (projectId === prev) return
    setChat((cur) => (cur ? { ...cur, project_id: projectId } : cur))
    try {
      await window.sunny.chats.setProject({ chatId, projectId })
      bumpChats()
    } catch {
      setChat((cur) => (cur ? { ...cur, project_id: prev } : cur))
    }
  }

  const title = chat?.title ?? 'Untitled chat'
  const iconBtn =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-850 text-fg-muted transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-ink-700/40 px-8 py-4">
        <Link
          to="/chats"
          aria-label="Back to chats"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-ink-700 bg-ink-850 text-fg-muted transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        {editingTitle ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void saveTitle()
            }}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingTitle(false)
                  setTitleError(null)
                }
              }}
              autoFocus
              placeholder="Chat title"
              aria-label="Chat title"
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-lg font-semibold text-fg-heading placeholder:text-fg-subtle/70 focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            />
            <button type="submit" aria-label="Save title" className={iconBtn}>
              <Check className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Cancel rename"
              className={iconBtn}
              onClick={() => {
                setEditingTitle(false)
                setTitleError(null)
              }}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={beginEditTitle}
            title="Click to rename"
            className="group flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-ink-850 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <h1 className="truncate text-lg font-semibold text-fg-heading">{title}</h1>
            <Pencil
              className="h-3.5 w-3.5 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          </button>
        )}
        {titleError ? (
          <span className="shrink-0 text-xs text-status-blocked">{titleError}</span>
        ) : null}

        <div className="ml-auto shrink-0">
          <ProjectPicker
            projectId={chat?.project_id ?? null}
            onChange={(p) => void handleMoveProject(p)}
          />
        </div>

        {folder ? (
          <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-amber-400/60 bg-amber-400/10 px-3 py-1.5 text-sm font-medium text-amber-200">
            <FolderOpen className="h-4 w-4" aria-hidden="true" />
            <span className="max-w-[14rem] truncate" title={folder.path}>
              {folder.name}
            </span>
            <button
              type="button"
              onClick={handleClearFolder}
              aria-label={`Clear folder ${folder.name}`}
              className="flex h-4 w-4 items-center justify-center rounded-full text-amber-200/80 transition-colors hover:text-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-fg-muted">
              <Spinner label="Loading conversation" />
              Loading conversation…
            </div>
          ) : loadError ? (
            <div className="rounded-xl border border-status-blocked/40 bg-status-blocked/10 px-4 py-3 text-sm text-status-blocked">
              {loadError}
            </div>
          ) : (
            <>
              {messages.length === 0 && !active ? (
                <p className="py-12 text-center text-sm text-fg-subtle">
                  No messages yet. Say hello to start the conversation.
                </p>
              ) : null}

              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  attachments={m.attachments}
                  modelLabel={m.role === 'assistant' ? modelLabelFor(m.provider, m.model) : null}
                  providerLabel={m.role === 'assistant' ? providerLabelFor(m.provider) : null}
                  agentName={m.role === 'assistant' ? agentName : null}
                />
              ))}

              {active ? (
                <>
                  <MessageBubble
                    role="assistant"
                    content={buffer?.text ?? ''}
                    streaming={!buffer?.error}
                    error={buffer?.error}
                    modelLabel={modelLabelFor(selectedProvider, selectedModel)}
                    providerLabel={providerLabelFor(selectedProvider)}
                    agentName={agentName}
                  />
                  {buffer?.status && !buffer.error ? (
                    <p
                      className="flex justify-start px-1 text-xs italic text-fg-muted"
                      role="status"
                    >
                      {buffer.status}
                    </p>
                  ) : null}
                  {buffer?.error ? (
                    <div className="flex justify-start">
                      <button
                        type="button"
                        onClick={handleRetry}
                        className={cn(
                          'inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-850 px-3.5 py-2',
                          'text-sm font-medium text-fg-muted transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-fg',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
                        )}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        Retry
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-ink-700/40 px-8 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {sendError ? (
            <div className="mb-3 rounded-xl border border-status-blocked/40 bg-status-blocked/10 px-4 py-2.5 text-sm text-status-blocked">
              {sendError}
            </div>
          ) : null}
          <ChatComposer
            streaming={streaming}
            canSend={canSend}
            folder={folder}
            defaultWebSearch={agentWebDefault}
            onSend={(content, webSearch, images) => void sendMessage(content, webSearch, images)}
            onStop={handleStop}
            onPickFolder={() => void handlePickFolder()}
            onClearFolder={handleClearFolder}
          />
        </div>
      </div>
    </div>
  )
}
