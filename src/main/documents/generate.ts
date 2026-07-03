// Document generation for the `create_file` agent tool: turn model-provided text
// into a real file in one of several formats. Plain formats (md/txt/csv/html) are
// just UTF-8 writes; xlsx goes through SheetJS (already a dep); docx through the
// `docx` builder; pdf is rendered by Chromium via Electron's printToPDF (no extra
// dependency, real layout). Everything here runs in the main process.

import { BrowserWindow } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'

export const DOCUMENT_FORMATS = ['md', 'txt', 'csv', 'html', 'docx', 'xlsx', 'pdf'] as const
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number]

export function isDocumentFormat(value: string): value is DocumentFormat {
  return (DOCUMENT_FORMATS as readonly string[]).includes(value)
}

const MIME: Record<DocumentFormat, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf'
}
export function mimeFor(format: DocumentFormat): string {
  return MIME[format]
}

// ── minimal markdown → HTML (no deps) ──────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function inlineMd(s: string): string {
  let t = escapeHtml(s)
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return t
}

/** Convert a useful subset of markdown (headings, lists, code, paragraphs) to HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let inUl = false
  let inOl = false
  let inCode = false
  const closeLists = (): void => {
    if (inUl) {
      out.push('</ul>')
      inUl = false
    }
    if (inOl) {
      out.push('</ol>')
      inOl = false
    }
  }
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        out.push('</pre>')
        inCode = false
      } else {
        closeLists()
        out.push('<pre>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      out.push(escapeHtml(line))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeLists()
      const level = heading[1].length
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`)
      continue
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    if (ul) {
      if (!inUl) {
        closeLists()
        out.push('<ul>')
        inUl = true
      }
      out.push(`<li>${inlineMd(ul[1])}</li>`)
      continue
    }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      if (!inOl) {
        closeLists()
        out.push('<ol>')
        inOl = true
      }
      out.push(`<li>${inlineMd(ol[1])}</li>`)
      continue
    }
    if (line.trim() === '') {
      closeLists()
      continue
    }
    closeLists()
    out.push(`<p>${inlineMd(line)}</p>`)
  }
  if (inCode) out.push('</pre>')
  closeLists()
  return out.join('\n')
}

/** Whether content already looks like authored HTML (so we don't double-wrap). */
function looksLikeHtml(s: string): boolean {
  return /<\s*(!doctype|html|body|div|table|h[1-6]|p)\b/i.test(s.slice(0, 600))
}

/** Wrap body HTML in a clean, print-friendly document shell. */
function wrapHtml(bodyHtml: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55;max-width:46rem;margin:2rem auto;padding:0 1.25rem;color:#1a1a1a}
  h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em}
  h1{font-size:1.8rem}h2{font-size:1.4rem}h3{font-size:1.15rem}
  code{background:#f3f4f6;padding:.1em .35em;border-radius:4px;font-size:.9em}
  pre{background:#f3f4f6;padding:1rem;border-radius:8px;overflow:auto;white-space:pre-wrap}
  table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #d8d8d8;padding:.45em .7em;text-align:left}
  a{color:#2563eb}
</style></head><body>${bodyHtml}</body></html>`
}

// ── csv → xlsx (SheetJS) ───────────────────────────────────────────────────
function csvToXlsx(content: string): Buffer {
  // SheetJS parses a CSV string into a single-sheet workbook when read as text.
  const wb = XLSX.read(content, { type: 'string', raw: false })
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer)
}

// ── text/markdown → docx ───────────────────────────────────────────────────
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
]

async function textToDocx(content: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = []
  for (const line of content.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (heading) {
      paragraphs.push(new Paragraph({ text: heading[2], heading: HEADINGS[heading[1].length - 1] }))
    } else if (bullet) {
      paragraphs.push(new Paragraph({ text: bullet[1], bullet: { level: 0 } }))
    } else if (line.trim() === '') {
      paragraphs.push(new Paragraph({ text: '' }))
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun(line)] }))
    }
  }
  const doc = new Document({
    sections: [{ children: paragraphs.length > 0 ? paragraphs : [new Paragraph({ text: '' })] }]
  })
  return Packer.toBuffer(doc)
}

// ── html → pdf (Chromium via Electron) ─────────────────────────────────────
async function htmlToPdf(html: string): Promise<Buffer> {
  // Load from a temp file (avoids data: URL length limits), render, print, clean up.
  const tmp = join(tmpdir(), `sunny-pdf-${randomUUID()}.html`)
  await writeFile(tmp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true }
  })
  try {
    await win.loadFile(tmp)
    return await win.webContents.printToPDF({ printBackground: true })
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await unlink(tmp).catch(() => undefined)
  }
}

/**
 * Generate a file's bytes for the given format from model-provided `content`.
 * `title` seeds the document title for html/pdf/docx. Throws on failure (the
 * tool wrapper turns that into a result string for the model).
 */
export async function generateDocument(
  format: DocumentFormat,
  content: string,
  title = 'Document'
): Promise<Buffer> {
  switch (format) {
    case 'md':
    case 'txt':
    case 'csv':
      return Buffer.from(content, 'utf8')
    case 'html':
      return Buffer.from(looksLikeHtml(content) ? content : wrapHtml(markdownToHtml(content), title), 'utf8')
    case 'xlsx':
      return csvToXlsx(content)
    case 'docx':
      return textToDocx(content)
    case 'pdf': {
      const html = looksLikeHtml(content) ? content : wrapHtml(markdownToHtml(content), title)
      return htmlToPdf(html)
    }
  }
}
