import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { readPickedFiles } from '@main/files'

// readPickedFiles reads text files directly and extracts PDF/Excel/Word to text
// (PDF/Word extraction is exercised by the runtime smoke test, not here). Covers:
// text + CSV read, spreadsheet extraction, unsupported-binary skip, truncation,
// unreadable skip, and the total size cap.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunny-files-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readPickedFiles', () => {
  it('reads a small text file verbatim', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello world')
    const out = await readPickedFiles([join(dir, 'a.txt')])
    expect(out.skipped).toEqual([])
    expect(out.files).toEqual([
      { name: 'a.txt', kind: 'text', content: 'hello world', bytes: 11, truncated: false }
    ])
  })

  it('reads an image file as a base64 data URL', async () => {
    // Bytes don't need to be a valid PNG — routing is by extension; the picker
    // just base64-encodes them into a data URL for vision models.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFileSync(join(dir, 'shot.png'), png)
    const out = await readPickedFiles([join(dir, 'shot.png')])
    expect(out.skipped).toEqual([])
    expect(out.files).toHaveLength(1)
    expect(out.files[0].kind).toBe('image')
    expect(out.files[0].mediaType).toBe('image/png')
    expect(out.files[0].dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(out.files[0].content).toBe('')
  })

  it('reads a CSV file as text', async () => {
    writeFileSync(join(dir, 'data.csv'), 'name,city\nAda,Mobile')
    const out = await readPickedFiles([join(dir, 'data.csv')])
    expect(out.skipped).toEqual([])
    expect(out.files[0].name).toBe('data.csv')
    expect(out.files[0].content).toBe('name,city\nAda,Mobile')
  })

  it('extracts text from an .xlsx spreadsheet', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'City'],
      ['Ada', 'Mobile']
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'People')
    writeFileSync(join(dir, 'book.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))

    const out = await readPickedFiles([join(dir, 'book.xlsx')])
    expect(out.skipped).toEqual([])
    expect(out.files).toHaveLength(1)
    expect(out.files[0].content).toContain('# Sheet: People')
    expect(out.files[0].content).toContain('Name,City')
    expect(out.files[0].content).toContain('Ada,Mobile')
  })

  it('skips an unsupported binary file (NUL byte)', async () => {
    writeFileSync(join(dir, 'b.bin'), Buffer.from([0x48, 0x00, 0x49, 0x02]))
    const out = await readPickedFiles([join(dir, 'b.bin')])
    expect(out.files).toEqual([])
    expect(out.skipped[0].name).toBe('b.bin')
    expect(out.skipped[0].reason).toMatch(/unsupported/i)
  })

  it('truncates a file over the per-file cap', async () => {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200_000))
    const out = await readPickedFiles([join(dir, 'big.txt')])
    expect(out.files).toHaveLength(1)
    expect(out.files[0].truncated).toBe(true)
    expect(out.files[0].content).toMatch(/…\[truncated\]$/)
    // capped near 128 KB, not the full 200 KB
    expect(out.files[0].content.length).toBeLessThan(140_000)
  })

  it('skips an unreadable / missing path', async () => {
    const out = await readPickedFiles([join(dir, 'nope.txt')])
    expect(out.files).toEqual([])
    expect(out.skipped[0].reason).toMatch(/could not read/i)
  })

  it('skips a directory', async () => {
    mkdirSync(join(dir, 'sub'))
    const out = await readPickedFiles([join(dir, 'sub')])
    expect(out.files).toEqual([])
    expect(out.skipped[0].reason).toMatch(/not a file/i)
  })

  it('enforces the total size cap across files', async () => {
    // Six ~128 KB files: the 512 KB total cap is reached, so a later one is skipped.
    const paths: string[] = []
    for (let i = 0; i < 6; i++) {
      const p = join(dir, `f${i}.txt`)
      writeFileSync(p, 'y'.repeat(128 * 1024))
      paths.push(p)
    }
    const out = await readPickedFiles(paths)
    expect(out.skipped.some((s) => /size limit/i.test(s.reason))).toBe(true)
    // Total retained content stays within ~the 512 KB cap (+ truncation markers).
    const total = out.files.reduce((n, f) => n + f.content.length, 0)
    expect(total).toBeLessThanOrEqual(512 * 1024 + 200)
  })
})
