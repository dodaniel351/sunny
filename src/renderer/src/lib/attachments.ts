import type { FileAttachment, ImageAttachment } from '@shared/ipc/contract'

/** The image attachments from a pick, in the shape chat.send / persistence want. */
export function imageAttachments(attachments: FileAttachment[]): ImageAttachment[] {
  return attachments
    .filter((f) => f.kind === 'image' && f.mediaType && f.dataUrl)
    .map((f) => ({ name: f.name, mediaType: f.mediaType as string, dataUrl: f.dataUrl as string }))
}

/** A file an agent generated this turn (create_file), stored on the message's
 *  `attachments` JSON alongside any images. The bytes live on disk at `path`. */
export interface FileAttachmentRef {
  kind: 'file'
  name: string
  path: string
  format: string
  bytes: number
  mediaType?: string
}

/** Parse a message row's `attachments` JSON into generated-file attachments. */
export function parseMessageFiles(json: string | null | undefined): FileAttachmentRef[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as Array<Record<string, unknown>>
    return arr
      .filter(
        (f): f is { name: string; path: string; format?: string; bytes?: number; mediaType?: string } =>
          Boolean(f) && f.kind === 'file' && typeof f.name === 'string' && typeof f.path === 'string'
      )
      .map((f) => ({
        kind: 'file' as const,
        name: f.name,
        path: f.path,
        format: typeof f.format === 'string' ? f.format : '',
        bytes: typeof f.bytes === 'number' ? f.bytes : 0,
        mediaType: typeof f.mediaType === 'string' ? f.mediaType : undefined
      }))
  } catch {
    return []
  }
}

/** Parse a message row's `attachments` JSON column into image attachments. */
export function parseMessageImages(json: string | null | undefined): ImageAttachment[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as Array<Partial<ImageAttachment>>
    return arr
      .filter((i): i is ImageAttachment => Boolean(i && i.name && i.mediaType && i.dataUrl))
      .map((i) => ({ name: i.name, mediaType: i.mediaType, dataUrl: i.dataUrl }))
  } catch {
    return []
  }
}

/**
 * Format a byte count as a compact KB label for attachment chips, e.g. "3.4 KB".
 * Files are small text blobs, so KB is the natural unit; sub-KB rounds to 0.1.
 */
export function formatKb(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 0.1) return '0.1 KB'
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
}

/**
 * Build the final message string sent to the model from the typed text plus any
 * attached files. File CONTENTS are inlined so they persist in the transcript
 * and survive across turns (there's no separate attachments field).
 *
 * We deliberately avoid ``` fences — a file may contain its own fences and
 * collide. Instead each file is wrapped in plain `--- file: <name> ---` /
 * `--- end file ---` markers under a "📎 Attached files:" header.
 *
 * If there's no typed text but there are attachments, the attachments ARE the
 * message (header + blocks, no leading blank lines).
 */
export function composeMessage(text: string, attachments: FileAttachment[]): string {
  const trimmed = text.trim()
  // Only TEXT/document files fold into the message; images travel separately as
  // structured image parts (see imageAttachments).
  const textFiles = attachments.filter((f) => f.kind !== 'image')
  if (textFiles.length === 0) return trimmed

  const blocks = textFiles
    .map((f) => `--- file: ${f.name} ---\n${f.content}\n--- end file ---`)
    .join('\n\n')
  const body = `📎 Attached files:\n\n${blocks}`

  return trimmed.length > 0 ? `${trimmed}\n\n${body}` : body
}
