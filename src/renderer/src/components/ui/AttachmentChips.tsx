import { FileText, X } from 'lucide-react'
import type { FileAttachment } from '@shared/ipc/contract'
import { formatKb } from '@renderer/lib/attachments'

interface AttachmentChipsProps {
  /** The text files currently attached to the pending message. */
  attachments: FileAttachment[]
  /** Remove the attachment at `index` from the pending message. */
  onRemove: (index: number) => void
  /**
   * Names + reasons for files the picker skipped (binary/unreadable/over the
   * cap). Rendered as a brief transient note; pass an empty array to hide it.
   */
  skipped: Array<{ name: string; reason: string }>
}

/**
 * Renders attached text files as removable chips (name + KB size, a "truncated"
 * marker when the file hit its cap, and an ✕ to remove), plus a short note for
 * any skipped files. Shared by both the in-chat and dashboard composers.
 */
export function AttachmentChips({
  attachments,
  onRemove,
  skipped
}: AttachmentChipsProps): JSX.Element | null {
  if (attachments.length === 0 && skipped.length === 0) return null

  return (
    <div className="mt-3 space-y-2">
      {attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-sm text-fg-muted"
            >
              {file.kind === 'image' && file.dataUrl ? (
                <img
                  src={file.dataUrl}
                  alt=""
                  className="h-7 w-7 shrink-0 rounded object-cover"
                  aria-hidden="true"
                />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              )}
              <span className="max-w-[14rem] truncate text-fg" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-fg-subtle">{formatKb(file.bytes)}</span>
              {file.truncated ? (
                <span
                  className="shrink-0 rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-amber-200"
                  title="File was truncated to fit the size cap"
                >
                  truncated
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${file.name}`}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {skipped.length > 0 ? (
        <p className="px-1 text-xs text-fg-subtle" role="status">
          {skipped.map((s) => `Skipped ${s.name} — ${s.reason}`).join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
