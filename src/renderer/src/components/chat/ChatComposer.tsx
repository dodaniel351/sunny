import { ArrowUp, FolderOpen, Ghost, Globe, Paperclip, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { ModelSelector } from '@renderer/components/dashboard/ModelSelector'
import { PermissionSelect } from '@renderer/components/chat/PermissionSelect'
import { AttachmentChips } from '@renderer/components/ui/AttachmentChips'
import { Chip } from '@renderer/components/ui/Chip'
import { Panel } from '@renderer/components/ui/Panel'
import { composeMessage, imageAttachments } from '@renderer/lib/attachments'
import { cn } from '@renderer/lib/cn'
import type { ChatFolder } from '@renderer/store/chatStore'
import type { FileAttachment, FilePickResult, ImageAttachment } from '@shared/ipc/contract'

interface ChatComposerProps {
  /** True while a stream is in flight — swaps Send for Stop and disables input. */
  streaming: boolean
  /** Whether a connected provider + selected model are available. */
  canSend: boolean
  /** The folder bound to this chat, injected as context on every send. */
  folder: ChatFolder | null
  /**
   * Initial state for the per-message web-search toggle. Defaults OFF; set true
   * when the chat runs as an agent that has web access.
   */
  defaultWebSearch?: boolean
  /** Whether this chat is in incognito mode (kept out of the memory system). */
  incognito?: boolean
  /** Toggle incognito for this chat (applies to subsequent turns). */
  onToggleIncognito?: () => void
  onSend: (content: string, webSearch: boolean, images: ImageAttachment[]) => void
  onStop: () => void
  /** Open the native folder picker and bind the result to this chat. */
  onPickFolder: () => void
  /** Clear the folder bound to this chat. */
  onClearFolder: () => void
}

/**
 * The chat view's composer: multiline input, model selector, and a send/stop
 * button. Enter sends, Shift+Enter inserts a newline, Esc stops a live stream.
 * When no provider/model is available, send is disabled with a Settings hint.
 */
export function ChatComposer({
  streaming,
  canSend,
  folder,
  defaultWebSearch = false,
  incognito = false,
  onToggleIncognito,
  onSend,
  onStop,
  onPickFolder,
  onClearFolder
}: ChatComposerProps): JSX.Element {
  const [value, setValue] = useState('')
  const [webSearch, setWebSearch] = useState(defaultWebSearch)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [skipped, setSkipped] = useState<FilePickResult['skipped']>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const skippedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Adopt the agent-scoped default once it resolves (it arrives after the chat
  // loads). The user can still flip it; subsequent default changes don't stomp
  // their choice because this only fires when the default itself changes.
  useEffect(() => {
    setWebSearch(defaultWebSearch)
  }, [defaultWebSearch])

  // Surface the picker's "skipped" list briefly, then clear it.
  useEffect(() => {
    return () => {
      if (skippedTimer.current) clearTimeout(skippedTimer.current)
    }
  }, [])

  const trimmed = value.trim()
  const hasContent = trimmed.length > 0 || attachments.length > 0
  const sendEnabled = canSend && hasContent && !streaming

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

  function submit(): void {
    if (!sendEnabled) return
    onSend(composeMessage(trimmed, attachments), webSearch, imageAttachments(attachments))
    setValue('')
    setAttachments([])
    setSkipped([])
    textareaRef.current?.focus()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape' && streaming) {
      e.preventDefault()
      onStop()
    }
  }

  return (
    <Panel className="p-4">
      <label htmlFor="chat-composer" className="sr-only">
        Message Sunny
      </label>
      <textarea
        id="chat-composer"
        ref={textareaRef}
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={!canSend}
        placeholder={
          canSend
            ? 'Send a message… (Enter to send, Shift+Enter for newline)'
            : 'Connect a provider to start chatting'
        }
        className="w-full resize-none bg-transparent px-2 py-1 text-base leading-relaxed text-fg placeholder:text-fg-subtle focus:outline-none disabled:opacity-60"
      />

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ModelSelector />

          <PermissionSelect />

          {folder ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/60 bg-amber-400/10 px-3.5 py-2 text-sm font-medium text-amber-200">
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
              <span className="max-w-[12rem] truncate" title={folder.path}>
                {folder.name}
              </span>
              <button
                type="button"
                onClick={onClearFolder}
                aria-label={`Clear folder ${folder.name}`}
                className="flex h-4 w-4 items-center justify-center rounded-full text-amber-200/80 transition-colors hover:text-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          ) : (
            <Chip
              onClick={onPickFolder}
              aria-label="Chat in a folder: pick a folder to use as context"
            >
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
              Chat in Folder
            </Chip>
          )}

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

          <button
            type="button"
            onClick={() => void pickFiles()}
            disabled={!canSend}
            title="Attach files — text, PDF, Office, images"
            aria-label="Attach files"
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors',
              'border-ink-700 bg-ink-850 text-fg-muted hover:border-ink-600 hover:bg-ink-800 hover:text-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            Attach
          </button>

          {onToggleIncognito ? (
            <button
              type="button"
              onClick={onToggleIncognito}
              aria-pressed={incognito}
              title={
                incognito
                  ? 'Incognito is ON — this chat is kept out of memory (no capture, no recall)'
                  : 'Turn on incognito — keep this chat out of memory'
              }
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
                incognito
                  ? 'border-violet-400/60 bg-violet-400/10 text-violet-300'
                  : 'border-ink-700 bg-ink-850 text-fg-muted hover:border-ink-600 hover:bg-ink-800 hover:text-fg'
              )}
            >
              <Ghost className="h-4 w-4" aria-hidden="true" />
              Incognito
            </button>
          ) : null}
        </div>

        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className={cn(
              'flex h-11 items-center gap-2 rounded-full border border-ink-700 bg-ink-800 px-4',
              'text-sm font-semibold text-fg transition-colors hover:border-ink-600 hover:bg-ink-750',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
            )}
          >
            <Square className="h-4 w-4 fill-current" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
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
        )}
      </div>

      <AttachmentChips attachments={attachments} onRemove={removeAttachment} skipped={skipped} />

      {!canSend ? (
        <p className="mt-2 px-2 text-xs text-fg-subtle">
          No provider connected.{' '}
          <Link
            to="/settings"
            className="font-medium text-amber-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            Add a key in Settings
          </Link>{' '}
          to begin.
        </p>
      ) : null}
    </Panel>
  )
}
