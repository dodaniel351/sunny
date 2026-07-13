import { ArrowUp, FolderOpen, Globe, Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AttachmentChips } from '@renderer/components/ui/AttachmentChips'
import { Chip } from '@renderer/components/ui/Chip'
import { Panel } from '@renderer/components/ui/Panel'
import { ModelSelector } from '@renderer/components/dashboard/ModelSelector'
import { PermissionSelect } from '@renderer/components/chat/PermissionSelect'
import { useProviders } from '@renderer/hooks/useProviders'
import { composeMessage, imageAttachments } from '@renderer/lib/attachments'
import { cn } from '@renderer/lib/cn'
import { useChatStore } from '@renderer/store/chatStore'
import { useUiStore } from '@renderer/store/uiStore'
import type { FileAttachment, FilePickResult } from '@shared/ipc/contract'

/**
 * The central composer card. On submit it creates a chat with the selected
 * provider + model, navigates to `/chats/:id`, and hands the first message to
 * the chat view via the chat store. Enter sends; Shift+Enter inserts a newline.
 */
export function Composer(): JSX.Element {
  const navigate = useNavigate()
  const { providers } = useProviders()
  const selectedProvider = useUiStore((s) => s.selectedProvider)
  const selectedModel = useUiStore((s) => s.selectedModel)
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const composerDraft = useUiStore((s) => s.composerDraft)
  const setComposerDraft = useUiStore((s) => s.setComposerDraft)
  const setPendingFirstMessage = useChatStore((s) => s.setPendingFirstMessage)
  const pendingFolder = useChatStore((s) => s.pendingFolder)
  const setPendingFolder = useChatStore((s) => s.setPendingFolder)

  const [value, setValue] = useState('')
  const [webSearch, setWebSearch] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [skipped, setSkipped] = useState<FilePickResult['skipped']>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const skippedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Consume a starter staged by a quick-action chip exactly once: apply it to
  // the textarea, put the caret at the end, then clear the draft so it never
  // clobbers later typing.
  useEffect(() => {
    if (composerDraft === null) return
    setValue(composerDraft)
    setComposerDraft(null)
    const el = textareaRef.current
    if (el) {
      el.focus()
      const end = composerDraft.length
      el.setSelectionRange(end, end)
    }
  }, [composerDraft, setComposerDraft])

  // Surface the picker's "skipped" list briefly, then clear it.
  useEffect(() => {
    return () => {
      if (skippedTimer.current) clearTimeout(skippedTimer.current)
    }
  }, [])

  const hasConnected = providers.some((p) => p.connected)
  const canSend = hasConnected && Boolean(selectedProvider) && Boolean(selectedModel)
  const trimmed = value.trim()
  const hasContent = trimmed.length > 0 || attachments.length > 0
  const sendEnabled = canSend && hasContent && !submitting

  async function pickFolder(): Promise<void> {
    const result = await window.sunny.folder.pick()
    if (result.path && result.name) {
      setPendingFolder({ path: result.path, name: result.name })
    }
  }

  async function pickFiles(): Promise<void> {
    const result = await window.sunny.files.pick()
    if (result.files.length > 0) {
      setAttachments((prev) => [...prev, ...result.files])
    }
    if (skippedTimer.current) clearTimeout(skippedTimer.current)
    setSkipped(result.skipped)
    if (result.skipped.length > 0) {
      skippedTimer.current = setTimeout(() => setSkipped([]), 6000)
    }
    textareaRef.current?.focus()
  }

  function removeAttachment(index: number): void {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  async function startChat(): Promise<void> {
    if (!sendEnabled || !selectedProvider || !selectedModel) return
    setSubmitting(true)
    try {
      const chat = await window.sunny.chats.create({
        provider: selectedProvider,
        model: selectedModel,
        // Attach the chat to the active project scope (null = unattached).
        projectId: activeProjectId ?? undefined
      })
      setPendingFirstMessage(
        chat.id,
        composeMessage(trimmed, attachments),
        imageAttachments(attachments),
        webSearch
      )
      setValue('')
      setWebSearch(false)
      setAttachments([])
      setSkipped([])
      navigate(`/chats/${chat.id}`)
    } finally {
      setSubmitting(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void startChat()
    }
  }

  return (
    <Panel className="p-4">
      <label htmlFor="composer" className="sr-only">
        Message Sunny Core
      </label>
      <textarea
        id="composer"
        ref={textareaRef}
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Sunny Core, Send a message, upload files, open a folder, or create a scheduled task…"
        className="w-full resize-none bg-transparent px-2 py-1 text-base leading-relaxed text-fg placeholder:text-fg-subtle focus:outline-none"
      />

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {pendingFolder ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/60 bg-amber-400/10 px-3.5 py-2 text-sm font-medium text-amber-200">
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
              <span className="max-w-[12rem] truncate" title={pendingFolder.path}>
                {pendingFolder.name}
              </span>
              <button
                type="button"
                onClick={() => setPendingFolder(null)}
                aria-label={`Clear folder ${pendingFolder.name}`}
                className="flex h-4 w-4 items-center justify-center rounded-full text-amber-200/80 transition-colors hover:text-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          ) : (
            <Chip
              onClick={() => void pickFolder()}
              aria-label="Chat in a folder: pick a folder to use as context"
            >
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
              Chat in Folder
            </Chip>
          )}

          <ModelSelector />

          <PermissionSelect />

          <button
            type="button"
            onClick={() => setWebSearch((on) => !on)}
            aria-pressed={webSearch}
            title="Search the web"
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              webSearch
                ? 'border-amber-400/60 bg-amber-400/10 text-amber-200'
                : 'border-ink-700 bg-ink-850 text-fg-muted hover:border-ink-600 hover:bg-ink-800 hover:text-fg'
            )}
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            Web search
          </button>

          <Chip
            onClick={() => void pickFiles()}
            aria-label="Attach files"
            title="Attach files — text, PDF, Office, images"
          >
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            Attach
          </Chip>
        </div>

        <button
          type="button"
          onClick={() => void startChat()}
          disabled={!sendEnabled}
          aria-label="Send message"
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-soft text-ink-950 shadow-glow transition-colors',
            'hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none'
          )}
        >
          <ArrowUp className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <AttachmentChips attachments={attachments} onRemove={removeAttachment} skipped={skipped} />
    </Panel>
  )
}
