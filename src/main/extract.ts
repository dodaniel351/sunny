import { extname } from 'node:path'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

// Turn binary documents the model can't read as raw bytes (PDF, Excel, Word)
// into plain text, so they flow through the same text-attachment path as .txt /
// .csv files. Pure-JS parsers only — nothing here touches the network, and the
// caller (files.ts) still applies the size caps to the extracted text.

/** Extensions we extract text from (beyond plain-text files like .txt/.csv/.md). */
const EXTRACTABLE_EXTS = new Set(['.pdf', '.xlsx', '.xls', '.xlsm', '.docx'])

/** Whether `name`'s extension is a document we can extract text from. */
export function isExtractable(name: string): boolean {
  return EXTRACTABLE_EXTS.has(extname(name).toLowerCase())
}

/**
 * Extract plain text from a supported binary document. Returns '' when the file
 * has no extractable text (e.g. a scanned, image-only PDF). Throws only on a
 * genuinely unreadable/corrupt file, which the caller turns into a skip reason.
 */
export async function extractDocumentText(name: string, buf: Buffer): Promise<string> {
  const ext = extname(name).toLowerCase()
  if (ext === '.pdf') return extractPdf(buf)
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') return extractSpreadsheet(buf)
  if (ext === '.docx') return extractDocx(buf)
  return ''
}

async function extractPdf(buf: Buffer): Promise<string> {
  // PDFParse converts a Buffer to a Uint8Array itself, but pass one explicitly
  // so the input is unambiguous across versions.
  const parser = new PDFParse({ data: new Uint8Array(buf) })
  try {
    const result = await parser.getText()
    return result.text ?? ''
  } finally {
    await parser.destroy().catch(() => {})
  }
}

function extractSpreadsheet(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet).trim()
    if (csv) parts.push(`# Sheet: ${sheetName}\n${csv}`)
  }
  return parts.join('\n\n')
}

async function extractDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf })
  return result.value ?? ''
}
