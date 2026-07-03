import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

// "Chat in Folder" (spec §9): the user picks a working folder and its file
// structure is injected into the chat as context, so the assistant understands
// the project it's helping with. We read a filtered, depth- and count-capped
// tree plus the project's root README (the canonical "what is this" file, capped)
// for high-signal context; deeper file contents are the agent read-tool's job.
// Nothing here touches the network.

// Directories that are noise for project context — skipped entirely.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'release',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.DS_Store',
  'target',
  'vendor'
])

const MAX_ENTRIES = 300
const MAX_DEPTH = 4
const MAX_README_CHARS = 4000
// Root files (case-insensitive) treated as the project's README, in priority order.
const README_NAMES = ['readme.md', 'readme.markdown', 'readme.txt', 'readme', 'readme.rst']

export interface FolderContext {
  path: string
  name: string
  fileCount: number
  /** Indented text tree of the folder's structure (filtered + capped). */
  tree: string
  truncated: boolean
  /** The root README's text (capped), or null if there isn't one. */
  readme: string | null
}

/** Read a root-level README (first match by priority), capped. Null if none. */
function readRootReadme(folderPath: string): string | null {
  let items: string[]
  try {
    items = readdirSync(folderPath)
  } catch {
    return null
  }
  const lowered = new Map(items.map((i) => [i.toLowerCase(), i]))
  const match = README_NAMES.map((n) => lowered.get(n)).find((v): v is string => Boolean(v))
  if (!match) return null
  try {
    const full = join(folderPath, match)
    if (!statSync(full).isFile()) return null
    const text = readFileSync(full, 'utf8')
    return text.length > MAX_README_CHARS
      ? `${text.slice(0, MAX_README_CHARS)}\n…[truncated]`
      : text
  } catch {
    return null
  }
}

/** Build a compact, filtered text tree of a folder for chat context. */
export function readFolderContext(folderPath: string): FolderContext {
  const lines: string[] = []
  let count = 0
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let items: string[]
    try {
      items = readdirSync(dir)
    } catch {
      return
    }
    items.sort((a, b) => a.localeCompare(b))
    for (const item of items) {
      if (count >= MAX_ENTRIES) {
        truncated = true
        return
      }
      if (SKIP_DIRS.has(item)) continue
      const full = join(dir, item)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      const indent = '  '.repeat(depth)
      if (st.isDirectory()) {
        lines.push(`${indent}${item}/`)
        count++
        walk(full, depth + 1)
      } else {
        lines.push(`${indent}${item}`)
        count++
      }
    }
  }

  walk(folderPath, 0)
  return {
    path: folderPath,
    name: basename(folderPath) || folderPath,
    fileCount: count,
    tree: lines.join('\n'),
    truncated,
    readme: readRootReadme(folderPath)
  }
}
