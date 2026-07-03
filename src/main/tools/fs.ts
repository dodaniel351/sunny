// Workspace-rooted filesystem tools (spec §7). These are the read/write tools an
// agent gets when its allowlist includes the fs groups. Every path the model
// supplies is resolved against the workspace root and refused if it escapes
// (see workspace.ts) — the security boundary that keeps agents off the rest of
// the disk (system files, the user's compliance/PHI work).
//
// Contract: each tool's `run(args, ctx)` MUST NOT throw. Bad args, a path that
// escapes the workspace, ENOENT/EISDIR, etc. all come back as a clear, concise
// STRING — that string is fed straight back to the model as the tool result, so
// it reads like an explanation, and paths in it are workspace-relative.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep, posix } from 'node:path'
import type { ToolSpec } from '@main/providers/types'
import type { ToolContext, ToolDefinition } from './types'
import { TOOL_IDS } from '@shared/tools'
import {
  resolveInWorkspace,
  assertRealpathInside,
  workspaceLabel,
  WorkspaceError
} from './workspace'

// Caps keep tool output small — the result is appended to the model's context,
// so unbounded files/listings would blow the window and cost.
const MAX_READ_BYTES = 100 * 1024 // ~100 KB per read_file
const MAX_DIR_ENTRIES = 300 // list_dir: immediate entries returned
const MAX_GLOB_RESULTS = 300 // glob: matched files returned
const TRUNCATED = '…[truncated]'

// Directories never descended into by glob (noise + huge; also dotdirs).
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn'])

/** Coerce a tool argument to a non-empty string, or null if it isn't one. */
function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Normalize any thrown value into a short message for the model. */
function message(err: unknown): string {
  if (err instanceof WorkspaceError) return err.message
  if (err instanceof Error) {
    // Surface the errno code when present (ENOENT/EISDIR/EACCES…) — it's the
    // most actionable part for the model and avoids leaking absolute paths.
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/**
 * Resolve a user path inside the workspace and assert it (lexically + via
 * realpath) stays inside. Returns the absolute path, or throws WorkspaceError.
 * Callers run this inside their try/catch so the throw becomes a result string.
 */
function safeResolve(workspace: string, userPath: string): string {
  const abs = resolveInWorkspace(workspace, userPath)
  assertRealpathInside(workspace, abs)
  return abs
}

/** Translate a glob (`*`, `**`, `?`) into a RegExp over POSIX-relative paths.
 *  `**` crosses directory separators; `*` and `?` do NOT cross `/`. */
function globToRegExp(pattern: string): RegExp {
  // Normalize separators so a Windows-style pattern still matches POSIX paths.
  const glob = pattern.split('\\').join('/')
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` (optionally followed by `/`) matches across directories.
        i++
        if (glob[i + 1] === '/') i++
        re += '.*'
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}` // escape regex metacharacters
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re)
}

/** Recursively collect workspace-relative POSIX file paths matching `regex`,
 *  skipping SKIP_DIRS + dotdirs, stopping once `limit` matches are found. */
async function walkGlob(
  root: string,
  dir: string,
  regex: RegExp,
  out: string[],
  limit: number
): Promise<void> {
  if (out.length >= limit) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable dir — skip rather than fail the whole glob
  }
  for (const entry of entries) {
    if (out.length >= limit) return
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walkGlob(root, abs, regex, out, limit)
    } else if (entry.isFile()) {
      const rel = relative(root, abs).split(sep).join(posix.sep)
      if (regex.test(rel)) out.push(rel)
    }
  }
}

// ── read_file ──────────────────────────────────────────────────────────────
const readFileTool: ToolDefinition = {
  id: TOOL_IDS.readFile,
  sideEffecting: false,
  requiresWorkspace: true,
  spec: {
    type: 'function',
    function: {
      name: TOOL_IDS.readFile,
      description:
        'Read a UTF-8 text file from the workspace and return its contents. ' +
        'Large files are truncated. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to the file.' }
        },
        required: ['path']
      }
    }
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.workspace) return 'Error: no workspace is set; file tools are unavailable.'
    const path = asNonEmptyString(args.path)
    if (!path) return 'Error: read_file requires a non-empty "path" string.'
    try {
      const abs = safeResolve(ctx.workspace, path)
      const buf = await readFile(abs)
      const label = workspaceLabel(ctx.workspace, abs)
      if (buf.byteLength > MAX_READ_BYTES) {
        return `${buf.subarray(0, MAX_READ_BYTES).toString('utf8')}\n${TRUNCATED} (${label} is ${buf.byteLength} bytes)`
      }
      return buf.toString('utf8')
    } catch (err) {
      return `Error reading "${path}": ${message(err)}`
    }
  }
}

// ── list_dir ───────────────────────────────────────────────────────────────
const listDirTool: ToolDefinition = {
  id: TOOL_IDS.listDir,
  sideEffecting: false,
  requiresWorkspace: true,
  spec: {
    type: 'function',
    function: {
      name: TOOL_IDS.listDir,
      description:
        'List the immediate entries of a workspace directory. Directories are ' +
        "marked with a trailing '/'. Defaults to the workspace root.",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: "Workspace-relative directory path. Defaults to '.' (the root)."
          }
        },
        required: []
      }
    }
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.workspace) return 'Error: no workspace is set; file tools are unavailable.'
    const path = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.'
    try {
      const abs = safeResolve(ctx.workspace, path)
      const entries = await readdir(abs, { withFileTypes: true })
      const label = workspaceLabel(ctx.workspace, abs)
      if (entries.length === 0) return `(${label} is empty)`
      const names = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b))
      const shown = names.slice(0, MAX_DIR_ENTRIES)
      const header = `${label} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}):`
      const more =
        names.length > shown.length ? `\n${TRUNCATED} (${names.length - shown.length} more)` : ''
      return `${header}\n${shown.join('\n')}${more}`
    } catch (err) {
      return `Error listing "${path}": ${message(err)}`
    }
  }
}

// ── glob ───────────────────────────────────────────────────────────────────
const globTool: ToolDefinition = {
  id: TOOL_IDS.glob,
  sideEffecting: false,
  requiresWorkspace: true,
  spec: {
    type: 'function',
    function: {
      name: TOOL_IDS.glob,
      description:
        'Recursively find files in the workspace matching a glob pattern ' +
        "(supports '*', '**', '?'). Skips node_modules/.git and hidden dirs. " +
        'Returns workspace-relative paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: "Glob pattern, e.g. 'src/**/*.ts' or '*.json'."
          }
        },
        required: ['pattern']
      }
    }
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.workspace) return 'Error: no workspace is set; file tools are unavailable.'
    const pattern = asNonEmptyString(args.pattern)
    if (!pattern) return 'Error: glob requires a non-empty "pattern" string.'
    try {
      const root = safeResolve(ctx.workspace, '.')
      let regex: RegExp
      try {
        regex = globToRegExp(pattern)
      } catch {
        return `Error: invalid glob pattern "${pattern}".`
      }
      const out: string[] = []
      await walkGlob(root, root, regex, out, MAX_GLOB_RESULTS)
      if (out.length === 0) return `No files match "${pattern}".`
      out.sort((a, b) => a.localeCompare(b))
      const capped =
        out.length >= MAX_GLOB_RESULTS ? `\n${TRUNCATED} (cap ${MAX_GLOB_RESULTS})` : ''
      return `${out.length} match${out.length === 1 ? '' : 'es'} for "${pattern}":\n${out.join('\n')}${capped}`
    } catch (err) {
      return `Error globbing "${pattern}": ${message(err)}`
    }
  }
}

// ── write_file ─────────────────────────────────────────────────────────────
const writeFileTool: ToolDefinition = {
  id: TOOL_IDS.writeFile,
  sideEffecting: true,
  // Creating/overwriting inside the workspace is not treated as destructive: the
  // user opted into write + autopilot knowingly, and we never touch outside it.
  destructive: () => false,
  requiresWorkspace: true,
  spec: {
    type: 'function',
    function: {
      name: TOOL_IDS.writeFile,
      description:
        'Create or overwrite a file in the workspace with the given content. ' +
        'Parent directories are created as needed. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to write.' },
          content: { type: 'string', description: 'Full file content to write (UTF-8).' }
        },
        required: ['path', 'content']
      }
    }
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.workspace) return 'Error: no workspace is set; file tools are unavailable.'
    const path = asNonEmptyString(args.path)
    if (!path) return 'Error: write_file requires a non-empty "path" string.'
    if (typeof args.content !== 'string') {
      return 'Error: write_file requires a "content" string.'
    }
    const content = args.content
    try {
      const abs = safeResolve(ctx.workspace, path)
      // The parent must also be inside the workspace (mkdir -p, rooted).
      const parent = dirname(abs)
      assertRealpathInside(ctx.workspace, parent)
      await mkdir(parent, { recursive: true })
      await writeFile(abs, content, 'utf8')
      const label = workspaceLabel(ctx.workspace, abs)
      return `Wrote ${content.length} character${content.length === 1 ? '' : 's'} to ${label}.`
    } catch (err) {
      return `Error writing "${path}": ${message(err)}`
    }
  }
}

// ── edit_file ──────────────────────────────────────────────────────────────
const editFileTool: ToolDefinition = {
  id: TOOL_IDS.editFile,
  sideEffecting: true,
  destructive: () => false,
  requiresWorkspace: true,
  spec: {
    type: 'function',
    function: {
      name: TOOL_IDS.editFile,
      description:
        'Replace the FIRST occurrence of old_string with new_string in a ' +
        'workspace file. Fails (without writing) if old_string is empty or not found.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to edit.' },
          old_string: { type: 'string', description: 'Exact text to find (first match).' },
          new_string: { type: 'string', description: 'Text to replace it with.' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!ctx.workspace) return 'Error: no workspace is set; file tools are unavailable.'
    const path = asNonEmptyString(args.path)
    if (!path) return 'Error: edit_file requires a non-empty "path" string.'
    if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
      return 'Error: edit_file requires a non-empty "old_string".'
    }
    if (typeof args.new_string !== 'string') {
      return 'Error: edit_file requires a "new_string" string.'
    }
    const oldStr = args.old_string
    const newStr = args.new_string
    try {
      const abs = safeResolve(ctx.workspace, path)
      const original = await readFile(abs, 'utf8')
      const idx = original.indexOf(oldStr)
      if (idx === -1) {
        return `Error: old_string not found in "${path}"; nothing was changed.`
      }
      const updated = original.slice(0, idx) + newStr + original.slice(idx + oldStr.length)
      await writeFile(abs, updated, 'utf8')
      return `Edited ${workspaceLabel(ctx.workspace, abs)} (replaced 1 occurrence).`
    } catch (err) {
      return `Error editing "${path}": ${message(err)}`
    }
  }
}

/** The five workspace-rooted filesystem tools advertised to agents. */
export const FS_TOOLS: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  globTool,
  writeFileTool,
  editFileTool
]

// Re-export the spec array type so consumers can treat these uniformly.
export type FsToolSpec = ToolSpec
