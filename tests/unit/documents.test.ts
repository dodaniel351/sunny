import { describe, it, expect } from 'vitest'
import {
  DOCUMENT_FORMATS,
  generateDocument,
  isDocumentFormat,
  markdownToHtml,
  mimeFor
} from '@main/documents/generate'

// generate.ts imports electron for the PDF path, but `BrowserWindow` is only
// touched when generating a pdf — every other format is pure and testable here.

describe('isDocumentFormat', () => {
  it('accepts the supported formats and rejects others', () => {
    for (const f of DOCUMENT_FORMATS) expect(isDocumentFormat(f)).toBe(true)
    expect(isDocumentFormat('exe')).toBe(false)
    expect(isDocumentFormat('')).toBe(false)
  })
})

describe('markdownToHtml', () => {
  it('renders headings, lists, emphasis, and code', () => {
    expect(markdownToHtml('# Title')).toContain('<h1>Title</h1>')
    expect(markdownToHtml('## Sub')).toContain('<h2>Sub</h2>')
    const list = markdownToHtml('- one\n- two')
    expect(list).toContain('<ul>')
    expect(list).toContain('<li>one</li>')
    expect(markdownToHtml('**bold**')).toContain('<strong>bold</strong>')
    expect(markdownToHtml('`code`')).toContain('<code>code</code>')
  })

  it('escapes HTML in plain text', () => {
    expect(markdownToHtml('a < b & c')).toContain('a &lt; b &amp; c')
  })
})

describe('generateDocument', () => {
  it('writes text formats verbatim', async () => {
    expect((await generateDocument('md', '# Hi')).toString('utf8')).toBe('# Hi')
    expect((await generateDocument('txt', 'plain')).toString('utf8')).toBe('plain')
    expect((await generateDocument('csv', 'a,b\n1,2')).toString('utf8')).toBe('a,b\n1,2')
  })

  it('wraps markdown into an HTML document', async () => {
    const html = (await generateDocument('html', '# Report')).toString('utf8')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<h1>Report</h1>')
  })

  it('passes through authored HTML unchanged', async () => {
    const src = '<html><body><p>hi</p></body></html>'
    expect((await generateDocument('html', src)).toString('utf8')).toBe(src)
  })

  it('produces a zip-based xlsx workbook', async () => {
    const buf = await generateDocument('xlsx', 'name,score\nA,1\nB,2')
    // OOXML files are zip archives — they start with the "PK" signature.
    expect(buf.length).toBeGreaterThan(0)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('produces a zip-based docx document', async () => {
    const buf = await generateDocument('docx', '# Heading\n\nA paragraph.\n- a bullet')
    expect(buf.length).toBeGreaterThan(0)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
  })
})

describe('mimeFor', () => {
  it('maps each format to a MIME type', () => {
    expect(mimeFor('pdf')).toBe('application/pdf')
    expect(mimeFor('csv')).toBe('text/csv')
  })
})
