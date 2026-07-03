// Workspace rooting — the security boundary for every agent file/shell tool.
// All paths an agent supplies are resolved against the chosen workspace root and
// REFUSED if they escape it (via `..`, an absolute path, or — best effort — a
// symlink that points outside). This keeps agents away from the rest of the disk
// (system files, the user's compliance/PHI work), per the "workspace-only" policy.

import { resolve, relative, isAbsolute, sep } from 'node:path'
import { realpathSync } from 'node:fs'

/** Thrown when a tool argument resolves outside the workspace root. */
export class WorkspaceError extends Error {}

/**
 * Resolve `userPath` (relative or absolute) against `workspace` and assert the
 * result stays inside the workspace. Returns the absolute, normalized path.
 * Throws WorkspaceError on escape. An empty/'.' path resolves to the root itself.
 */
export function resolveInWorkspace(workspace: string, userPath: string): string {
  const root = resolve(workspace)
  const abs = resolve(root, userPath ?? '')
  if (abs !== root) {
    const rel = relative(root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceError(
        `Path "${userPath}" is outside the workspace. Agents may only access the workspace folder.`
      )
    }
  }
  return abs
}

/**
 * Defense-in-depth against symlink escapes: if the path (or its nearest existing
 * ancestor) realpath-resolves outside the workspace's realpath, reject it. Best
 * effort — if realpath can't be computed (path doesn't exist yet, etc.) we fall
 * back to the lexical check already done by resolveInWorkspace.
 */
export function assertRealpathInside(workspace: string, abs: string): void {
  let rootReal: string
  try {
    rootReal = realpathSync(resolve(workspace))
  } catch {
    return // can't resolve the root — rely on the lexical check
  }
  // Walk up to the nearest existing ancestor and realpath that.
  let probe = abs
  for (;;) {
    try {
      const real = realpathSync(probe)
      const rel = relative(rootReal, real)
      if (real !== rootReal && (rel.startsWith('..') || isAbsolute(rel))) {
        throw new WorkspaceError(
          'Resolved path escapes the workspace (symlink). Refused for safety.'
        )
      }
      return
    } catch (err) {
      if (err instanceof WorkspaceError) throw err
      const parent = resolve(probe, '..')
      if (parent === probe) return // reached filesystem root without resolving
      probe = parent
    }
  }
}

/** A short workspace-relative label for a path (for status lines / confirms). */
export function workspaceLabel(workspace: string, abs: string): string {
  const rel = relative(resolve(workspace), abs)
  return rel === '' ? '.' : rel.split(sep).join('/')
}
