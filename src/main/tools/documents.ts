// The `create_file` agent tool (the "Create documents" group): turn model output
// into a real downloadable file. Unlike the workspace fs tools, it writes ONLY to
// the app-managed generated dir (ctx.generatedDir) with a sanitized name — so it
// can't touch the rest of the disk and is safe to run ungated (sideEffecting:
// false). Each file is recorded as an artifact so the chat/worker can attach it
// to the assistant message with Open / Save chips.

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ToolContext, ToolDefinition } from './types'
import { TOOL_IDS } from '@shared/tools'
import {
  DOCUMENT_FORMATS,
  generateDocument,
  isDocumentFormat,
  mimeFor
} from '@main/documents/generate'

/** Reduce a model-supplied name to a safe `<stem>.<format>` basename. */
function sanitizeName(name: string, format: string): string {
  const base = basename(name || 'document')
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_')
  const stem = cleaned.replace(/\.[^.]+$/, '').replace(/^_+|_+$/g, '') || 'document'
  return `${stem}.${format}`
}

const createFileTool: ToolDefinition = {
  id: TOOL_IDS.createFile,
  // Writes only to the managed output dir — safe, so it runs without a confirm
  // gate (you WANT "make me a report" to just produce the file).
  sideEffecting: false,
  requiresWorkspace: false,
  spec: {
    type: 'function',
    function: {
      name: TOOL_IDS.createFile,
      description:
        'Create a downloadable file for the user and attach it to your reply. Use this for ' +
        'deliverables — reports, spreadsheets, documents. Provide the file CONTENT as text: ' +
        'markdown or plain text for docx & pdf, raw text for md/txt, HTML or markdown for html, ' +
        'and CSV rows (comma-separated, one row per line) for csv & xlsx.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Base file name (the extension is set by `format`).'
          },
          format: {
            type: 'string',
            enum: [...DOCUMENT_FORMATS],
            description: 'One of: md, txt, csv, html, docx, xlsx, pdf.'
          },
          content: {
            type: 'string',
            description:
              'The file content. CSV rows for csv/xlsx; markdown or plain text for docx/pdf; ' +
              'HTML or markdown for html; raw text for md/txt.'
          }
        },
        required: ['filename', 'format', 'content']
      }
    }
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.generatedDir) {
      return 'Error: file generation is unavailable (no output directory configured).'
    }
    const rawFormat = typeof args.format === 'string' ? args.format.toLowerCase().replace(/^\./, '') : ''
    if (!isDocumentFormat(rawFormat)) {
      return `Error: unsupported format "${String(args.format)}". Use one of: ${DOCUMENT_FORMATS.join(', ')}.`
    }
    if (typeof args.content !== 'string' || args.content.length === 0) {
      return 'Error: create_file requires non-empty "content".'
    }
    const displayName = sanitizeName(
      typeof args.filename === 'string' ? args.filename : 'document',
      rawFormat
    )
    try {
      const bytes = await generateDocument(rawFormat, args.content, displayName.replace(/\.[^.]+$/, ''))
      await mkdir(ctx.generatedDir, { recursive: true })
      // Prefix a timestamp so repeated same-name files never clobber each other.
      const path = join(ctx.generatedDir, `${Date.now()}-${displayName}`)
      await writeFile(path, bytes)
      ctx.recordArtifact?.({
        name: displayName,
        path,
        format: rawFormat,
        mediaType: mimeFor(rawFormat),
        bytes: bytes.byteLength
      })
      return `Created ${displayName} (${rawFormat}, ${bytes.byteLength} bytes). It is attached to this message — the user can open it or save a copy.`
    } catch (err) {
      return `Error creating "${displayName}": ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

export const DOCUMENT_TOOLS: ToolDefinition[] = [createFileTool]
