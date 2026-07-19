import { AlertTriangle, Brain, Check, ChevronDown, Copy } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { Spinner } from '@renderer/components/ui/Spinner'
import { FileChips } from '@renderer/components/chat/FileChips'
import { Markdown } from '@renderer/components/chat/Markdown'
import { cn } from '@renderer/lib/cn'
import { parseMessageFiles, parseMessageImages } from '@renderer/lib/attachments'
import type { MessageRole } from '@shared/db/types'

interface MessageBubbleProps {
  role: MessageRole
  content: string
  /** Assistant bubble that is currently receiving stream deltas. */
  streaming?: boolean
  /** Inline error for a failed assistant turn. */
  error?: string | null
  /** The message row's raw `attachments` JSON (images + generated files). Parsed
   *  inside so this prop stays a referentially-stable string and memo holds. */
  attachments?: string | null
  /** The model's reasoning for this turn — rendered in a collapsible section
   *  above the answer (AI-Studio-style). Null/empty renders nothing. */
  thinking?: string | null
  /** Friendly label of the model that produced this turn (assistant turns). */
  modelLabel?: string | null
  /** Friendly label of the provider that produced this turn (assistant turns). */
  providerLabel?: string | null
  /** Name of the agent this chat runs as, if any (assistant turns). */
  agentName?: string | null
}

/**
 * Collapsible reasoning section. While the model is still thinking (no answer
 * text yet) it auto-expands so the reasoning streams live; the moment the
 * answer starts it auto-collapses to a one-line header. A manual toggle always
 * wins over the automatic behavior once used.
 */
function ThinkingDisclosure({ text, active }: { text: string; active: boolean }): JSX.Element {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? active
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-fg-subtle',
          'transition-colors hover:bg-ink-800 hover:text-fg-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
        )}
      >
        <Brain className="h-3.5 w-3.5 text-amber-300/80" aria-hidden="true" />
        {active ? 'Thinking…' : 'Thoughts'}
        {active ? <Spinner className="h-3 w-3" label="Model is thinking" /> : null}
        <ChevronDown
          className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-ink-700 pl-3 text-xs leading-relaxed text-fg-muted">
          {text}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A single transcript turn. User turns align right with an amber tint and render
 * literally (`whitespace-pre-wrap`, preserving exactly what was typed/pasted);
 * assistant/system turns align left on a panel surface and render as themed
 * markdown (headings, lists, tables, syntax-highlighted code). Assistant turns
 * get a footer: who answered (agent · model) on the left, a copy button on the
 * right. Memoized: saved rows are immutable, so with a stable `attachments`
 * string prop the whole transcript doesn't re-parse markdown on every stream
 * delta of the one live bubble.
 */
function MessageBubbleImpl({
  role,
  content,
  streaming = false,
  error = null,
  attachments = null,
  thinking = null,
  modelLabel = null,
  providerLabel = null,
  agentName = null
}: MessageBubbleProps): JSX.Element {
  const isUser = role === 'user'
  const [copied, setCopied] = useState(false)

  // Parse attachments here (behind useMemo) so ChatView passes the raw string and
  // doesn't allocate a fresh array per render (which would defeat memo).
  const images = useMemo(() => parseMessageImages(attachments), [attachments])
  const files = useMemo(
    () => (role === 'assistant' ? parseMessageFiles(attachments) : []),
    [attachments, role]
  )

  async function handleCopy(): Promise<void> {
    try {
      await window.sunny.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write failed — non-fatal; the button just doesn't confirm.
    }
  }

  // Copy is available once there's final text (not the streaming placeholder).
  const canCopy = content.trim().length > 0 && !streaming
  const copyButton = (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label="Copy message"
      title={copied ? 'Copied' : 'Copy'}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
        isUser
          ? 'text-amber-200/70 hover:bg-amber-400/10 hover:text-amber-100'
          : 'text-fg-subtle hover:bg-ink-800 hover:text-fg'
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  )

  // Attribution line for assistant turns: agent (if any) · provider · model.
  // Shown even while streaming so it's clear who's answering before copy appears.
  // Separators render only between parts that are actually present.
  const hasAttribution = !isUser && Boolean(agentName || providerLabel || modelLabel)
  const sep = <span className="text-fg-subtle"> · </span>
  const attribution = hasAttribution ? (
    <span className="min-w-0 truncate text-[11px] text-fg-subtle">
      {agentName ? <span className="font-medium text-fg-muted">{agentName}</span> : null}
      {agentName && (providerLabel || modelLabel) ? sep : null}
      {providerLabel ? <span>{providerLabel}</span> : null}
      {providerLabel && modelLabel ? sep : null}
      {modelLabel ? <span className="font-mono">{modelLabel}</span> : null}
    </span>
  ) : null

  // The footer renders when there's anything to show in it.
  const showAssistantFooter = !isUser && (hasAttribution || canCopy)
  const showUserFooter = isUser && canCopy

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed',
          isUser
            ? 'bg-amber-400/15 text-fg ring-1 ring-amber-400/20'
            : 'border border-ink-700/70 bg-ink-850 text-fg shadow-panel'
        )}
      >
        {images.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <img
                key={`${img.name}-${i}`}
                src={img.dataUrl}
                alt={img.name}
                title={img.name}
                className="max-h-40 max-w-[12rem] rounded-lg border border-ink-700 object-cover"
              />
            ))}
          </div>
        ) : null}

        {!isUser && thinking ? (
          <ThinkingDisclosure text={thinking} active={streaming && !content && !error} />
        ) : null}

        {content ? (
          isUser ? (
            // User turns stay literal (preserve exactly what was typed/pasted).
            <p className="whitespace-pre-wrap break-words">{content}</p>
          ) : (
            // Assistant turns render as themed markdown (headings, lists, tables,
            // and fenced code in a syntax-highlighted code window).
            <Markdown content={content} streaming={streaming} />
          )
        ) : streaming && !error && !thinking ? (
          // Generic waiting placeholder — only until real reasoning arrives
          // (the disclosure above then carries the live "Thinking…" cue).
          <span className="inline-flex items-center gap-2 text-fg-muted">
            <Spinner label="Generating response" />
            Thinking…
          </span>
        ) : null}

        {streaming && content && !error ? (
          <span
            className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse-glow rounded-sm bg-amber-300 align-middle"
            aria-hidden="true"
          />
        ) : null}

        {error ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 text-xs text-status-blocked">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {files.length > 0 ? <FileChips files={files} className="mt-2.5" /> : null}

        {/* Footer: attribution (assistant) + copy, at the bottom of the card. */}
        {showAssistantFooter ? (
          <div className="mt-2.5 flex items-center gap-2 border-t border-ink-700/50 pt-2">
            {attribution ?? <span className="flex-1" />}
            <div className="ml-auto">{canCopy ? copyButton : null}</div>
          </div>
        ) : null}
        {showUserFooter ? <div className="mt-1.5 flex justify-end">{copyButton}</div> : null}
      </div>
    </div>
  )
}

// Memoized so a stream delta on the one live bubble doesn't re-render (and
// re-parse markdown for) every historical turn. Saved message props are
// immutable and `attachments` is a stable string, so the default shallow
// comparison is correct.
export const MessageBubble = memo(MessageBubbleImpl)
