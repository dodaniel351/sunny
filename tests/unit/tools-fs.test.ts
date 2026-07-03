import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FS_TOOLS } from '@main/tools/fs'
import { TOOL_IDS } from '@shared/tools'
import type { ToolContext, ToolDefinition } from '@main/tools/types'

// These tests run the real fs tools against a real temp workspace (no mocks):
// the tools resolve, read, write, and refuse paths just as they would in the
// app, so we cover both the happy paths AND the workspace-escape security case.

let workspace: string

/** A minimal autopilot ToolContext (no real confirm round-trip needed). */
function ctx(ws: string): ToolContext {
  return {
    workspace: ws,
    mode: 'autopilot',
    allowed: new Set<string>(),
    confirm: async () => true
  }
}

/** Find a tool by its id; fail loudly if the contract drifted. */
function tool(id: string): ToolDefinition {
  const def = FS_TOOLS.find((t) => t.id === id)
  if (!def) throw new Error(`tool not found: ${id}`)
  return def
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'sunny-fs-'))
  writeFileSync(join(workspace, 'hello.txt'), 'hello world', 'utf8')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const x = 1\n', 'utf8')
  writeFileSync(join(workspace, 'src', 'util.ts'), 'export const y = 2\n', 'utf8')
  writeFileSync(join(workspace, 'README.md'), '# readme\n', 'utf8')
})

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('FS_TOOLS contract', () => {
  it('exposes the five fs tools by their TOOL_IDS', () => {
    const ids = FS_TOOLS.map((t) => t.id).sort()
    expect(ids).toEqual(
      [
        TOOL_IDS.readFile,
        TOOL_IDS.listDir,
        TOOL_IDS.glob,
        TOOL_IDS.writeFile,
        TOOL_IDS.editFile
      ].sort()
    )
    // spec.function.name must equal the id for every tool.
    for (const t of FS_TOOLS) {
      expect(t.spec.type).toBe('function')
      expect(t.spec.function.name).toBe(t.id)
      expect(t.requiresWorkspace).toBe(true)
    }
  })

  it('marks read tools non-side-effecting and write/edit side-effecting (non-destructive)', () => {
    expect(tool(TOOL_IDS.readFile).sideEffecting).toBe(false)
    expect(tool(TOOL_IDS.listDir).sideEffecting).toBe(false)
    expect(tool(TOOL_IDS.glob).sideEffecting).toBe(false)
    expect(tool(TOOL_IDS.writeFile).sideEffecting).toBe(true)
    expect(tool(TOOL_IDS.editFile).sideEffecting).toBe(true)
    expect(tool(TOOL_IDS.writeFile).destructive?.({})).toBe(false)
    expect(tool(TOOL_IDS.editFile).destructive?.({})).toBe(false)
  })
})

describe('read_file', () => {
  it('reads an existing file', async () => {
    const out = await tool(TOOL_IDS.readFile).run({ path: 'hello.txt' }, ctx(workspace))
    expect(out).toBe('hello world')
  })

  it('returns an error string for a missing file (does not throw)', async () => {
    const out = await tool(TOOL_IDS.readFile).run({ path: 'nope.txt' }, ctx(workspace))
    expect(out).toMatch(/Error reading/)
    expect(out).toMatch(/ENOENT/)
  })

  it('rejects a non-string path', async () => {
    const out = await tool(TOOL_IDS.readFile).run({ path: 42 }, ctx(workspace))
    expect(out).toMatch(/requires a non-empty "path"/)
  })

  it('truncates files larger than the cap', async () => {
    const big = 'x'.repeat(120 * 1024)
    writeFileSync(join(workspace, 'big.txt'), big, 'utf8')
    const out = await tool(TOOL_IDS.readFile).run({ path: 'big.txt' }, ctx(workspace))
    expect(out).toMatch(/…\[truncated\]/)
    expect(out.length).toBeLessThan(big.length)
  })
})

describe('write_file then read back', () => {
  it('creates a file (mkdir -p parent) and reads it back', async () => {
    const writeOut = await tool(TOOL_IDS.writeFile).run(
      { path: 'nested/dir/new.txt', content: 'fresh content' },
      ctx(workspace)
    )
    expect(writeOut).toMatch(/Wrote/)
    expect(writeOut).toMatch(/nested\/dir\/new\.txt/)
    expect(existsSync(join(workspace, 'nested', 'dir', 'new.txt'))).toBe(true)

    const readOut = await tool(TOOL_IDS.readFile).run(
      { path: 'nested/dir/new.txt' },
      ctx(workspace)
    )
    expect(readOut).toBe('fresh content')
  })

  it('rejects a missing content arg', async () => {
    const out = await tool(TOOL_IDS.writeFile).run({ path: 'x.txt' }, ctx(workspace))
    expect(out).toMatch(/requires a "content" string/)
  })
})

describe('edit_file', () => {
  it('replaces the first occurrence and writes back', async () => {
    writeFileSync(join(workspace, 'edit.txt'), 'foo bar foo', 'utf8')
    const out = await tool(TOOL_IDS.editFile).run(
      { path: 'edit.txt', old_string: 'foo', new_string: 'baz' },
      ctx(workspace)
    )
    expect(out).toMatch(/Edited/)
    expect(readFileSync(join(workspace, 'edit.txt'), 'utf8')).toBe('baz bar foo')
  })

  it('returns an error and does not write when old_string is absent', async () => {
    writeFileSync(join(workspace, 'edit2.txt'), 'unchanged', 'utf8')
    const out = await tool(TOOL_IDS.editFile).run(
      { path: 'edit2.txt', old_string: 'missing', new_string: 'X' },
      ctx(workspace)
    )
    expect(out).toMatch(/not found/)
    expect(readFileSync(join(workspace, 'edit2.txt'), 'utf8')).toBe('unchanged')
  })

  it('treats an empty old_string as an error', async () => {
    const out = await tool(TOOL_IDS.editFile).run(
      { path: 'hello.txt', old_string: '', new_string: 'X' },
      ctx(workspace)
    )
    expect(out).toMatch(/non-empty "old_string"/)
  })
})

describe('list_dir', () => {
  it('lists immediate entries and marks directories with a trailing slash', async () => {
    const out = await tool(TOOL_IDS.listDir).run({ path: '.' }, ctx(workspace))
    expect(out).toMatch(/hello\.txt/)
    expect(out).toMatch(/README\.md/)
    expect(out).toMatch(/src\//) // directory marker
  })

  it("defaults to the workspace root when no path is given", async () => {
    const out = await tool(TOOL_IDS.listDir).run({}, ctx(workspace))
    expect(out).toMatch(/hello\.txt/)
  })
})

describe('glob', () => {
  it('matches **/*.ts across directories and returns workspace-relative POSIX paths', async () => {
    const out = await tool(TOOL_IDS.glob).run({ pattern: '**/*.ts' }, ctx(workspace))
    expect(out).toMatch(/src\/index\.ts/)
    expect(out).toMatch(/src\/util\.ts/)
    expect(out).not.toMatch(/\\/) // POSIX separators only
    expect(out).not.toMatch(/README\.md/)
  })

  it('returns a no-match message for a pattern with no hits', async () => {
    const out = await tool(TOOL_IDS.glob).run({ pattern: '**/*.zzz' }, ctx(workspace))
    expect(out).toMatch(/No files match/)
  })
})

describe('workspace escape security', () => {
  it('read_file refuses ../escape.txt and does not read outside the workspace', async () => {
    // Plant a file just outside the workspace; the tool must NOT read it.
    const outsidePath = join(workspace, '..', 'sunny-fs-escape-read.txt')
    writeFileSync(outsidePath, 'SECRET', 'utf8')
    try {
      const out = await tool(TOOL_IDS.readFile).run({ path: '../sunny-fs-escape-read.txt' }, ctx(workspace))
      expect(out).toMatch(/Error/)
      expect(out).not.toMatch(/SECRET/)
    } finally {
      rmSync(outsidePath, { force: true })
    }
  })

  it('write_file refuses ../escape.txt and does not create anything outside the workspace', async () => {
    const outsidePath = join(workspace, '..', 'sunny-fs-escape-write.txt')
    rmSync(outsidePath, { force: true })
    const out = await tool(TOOL_IDS.writeFile).run(
      { path: '../sunny-fs-escape-write.txt', content: 'should not be written' },
      ctx(workspace)
    )
    expect(out).toMatch(/Error/)
    expect(existsSync(outsidePath)).toBe(false)
  })
})

describe('missing workspace', () => {
  it('every tool returns an error string when ctx.workspace is undefined', async () => {
    const bare: ToolContext = {
      mode: 'autopilot',
      allowed: new Set<string>(),
      confirm: async () => true
    }
    for (const t of FS_TOOLS) {
      const out = await t.run({ path: 'x', pattern: '*', content: '', old_string: 'a', new_string: 'b' }, bare)
      expect(out).toMatch(/no workspace is set/)
    }
  })
})
