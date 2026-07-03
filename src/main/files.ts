import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { FilePickResult } from '@shared/ipc/contract'
import { extractDocumentText, isExtractable } from './extract'

// "Attach files" (spec §9): read the user-picked files for inclusion in a chat
// message. Plain-text files are read directly; PDF / Excel / Word documents are
// extracted to text (see ./extract); images become base64 data URLs for
// vision-capable models. Other binary files are skipped. Capped per-file and in
// total so a giant file can't blow up the context or the main-process heap.
// Nothing here touches the network.

const MAX_FILE_BYTES = 128 * 1024 // per-file text cap (~128 KB)
const MAX_TOTAL_BYTES = 512 * 1024 // text budget across all attachments in one pick
const MAX_SOURCE_BYTES = 25 * 1024 * 1024 // never read a >25 MB source into memory
const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // per-image cap (sent base64 to the model)

/** Image extensions we accept → their MIME type (what vision APIs expect). */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** Heuristic: a NUL byte in the first chunk means it's not text we should send. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Read picked files into text / image attachments, recording any skipped. */
export async function readPickedFiles(paths: string[]): Promise<FilePickResult> {
  const files: FilePickResult['files'] = []
  const skipped: FilePickResult['skipped'] = []
  let total = 0 // text budget consumed so far

  for (const path of paths) {
    const name = basename(path)
    try {
      const st = statSync(path)
      if (!st.isFile()) {
        skipped.push({ name, reason: 'not a file' })
        continue
      }
      if (st.size > MAX_SOURCE_BYTES) {
        skipped.push({ name, reason: 'file too large' })
        continue
      }

      const ext = extname(name).toLowerCase()
      const mediaType = IMAGE_MEDIA_TYPES[ext]

      // Image → base64 data URL for vision models (own cap; not the text budget).
      if (mediaType) {
        if (st.size > MAX_IMAGE_BYTES) {
          skipped.push({ name, reason: 'image too large (max 8 MB)' })
          continue
        }
        const buf = readFileSync(path)
        files.push({
          name,
          kind: 'image',
          content: '',
          bytes: st.size,
          truncated: false,
          mediaType,
          dataUrl: `data:${mediaType};base64,${buf.toString('base64')}`
        })
        continue
      }

      // Text / document path (shares the text budget).
      if (total >= MAX_TOTAL_BYTES) {
        skipped.push({ name, reason: 'attachment size limit reached' })
        continue
      }
      const buf = readFileSync(path)

      let content: string
      if (isExtractable(name)) {
        // PDF / Excel / Word → extract text via ./extract.
        try {
          content = await extractDocumentText(name, buf)
        } catch {
          skipped.push({ name, reason: 'could not read this file type' })
          continue
        }
        if (content.trim().length === 0) {
          skipped.push({
            name,
            reason: ext === '.pdf' ? 'no extractable text (scanned image?)' : 'no text found'
          })
          continue
        }
      } else if (!looksBinary(buf)) {
        content = buf.toString('utf8')
      } else {
        skipped.push({ name, reason: 'unsupported file type' })
        continue
      }

      const cap = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)
      let truncated = false
      if (content.length > cap) {
        content = `${content.slice(0, cap)}\n…[truncated]`
        truncated = true
      }
      total += Buffer.byteLength(content, 'utf8')
      files.push({ name, kind: 'text', content, bytes: st.size, truncated })
    } catch {
      skipped.push({ name, reason: 'could not read' })
    }
  }

  return { files, skipped }
}
