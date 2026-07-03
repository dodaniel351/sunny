// The shell tool: run an arbitrary command line in the agent's workspace folder.
// This is the most powerful (and most dangerous) agent tool, so it's the most
// heavily gated — see registry.ts for the permission flow:
//   • opt-in per agent  (it lives in the `shell` group; off by default)
//   • Ask mode          → every run is confirmed by a human
//   • Autopilot mode     → only DESTRUCTIVE-looking runs (see `destructive`) confirm
//
// SECURITY NOTE (accepted residual risk): a shell is inherently capable of
// escaping the workspace. We always set `cwd` to the workspace root, but a
// command can still `cd ..`, use absolute paths, or pipe to another shell. We do
// NOT try to sandbox the shell itself (no chroot / namespace / seccomp here) —
// that is out of scope for an Electron desktop app and would break legitimate
// dev workflows (compilers, package managers). The mitigations we DO apply are:
//   1. cwd is ALWAYS the workspace (the common case stays scoped),
//   2. a 60s wall-clock timeout (no runaway processes),
//   3. an output cap (~8 KB) so a chatty command can't blow up the context,
//   4. honoring ctx.signal so the user can cancel,
//   5. the per-agent opt-in + confirm gating above.
// The residual escape risk is accepted precisely because shell is opt-in AND
// confirmed in Ask mode / on destructive autopilot runs — a human is in the loop
// before anything risky executes.

import { spawn } from 'node:child_process'
import type { ToolSpec } from '@main/providers/types'
import type { ToolDefinition, ToolContext } from './types'
import { TOOL_IDS } from '@shared/tools'

/** Wall-clock cap for a single command. Long enough for installs/builds, short
 *  enough that a hung process doesn't wedge the turn forever. (Raised 60s→120s
 *  for unattended agent work — real installs/test runs routinely pass 60s.) */
const TIMEOUT_MS = 120_000

/** Cap on the COMBINED captured stdout+stderr. A chatty command (e.g. a verbose
 *  test runner) must not blow up the model's context, so we stop appending past
 *  this and note the truncation. ~16 KB (raised from 8 — an agent reacting to
 *  build/test output needs to actually see the failures). */
const MAX_OUTPUT_BYTES = 16 * 1024

/**
 * Patterns that mark a command as risky → triggers a confirm even in autopilot.
 * Intentionally inclusive: a false positive only causes a (safe) confirm prompt,
 * whereas a false negative could run something destructive unattended. Tested
 * directly via the exported `destructive` on the tool definition.
 *
 * Covers: recursive/forced delete (rm -r/-rf/-fr, rmdir, del/erase, rd /s),
 * disk/format/clobber (format, mkfs, dd, > /dev/, truncate), fork bomb,
 * power state (shutdown/reboot/halt), dangerous git (push -f/--force,
 * reset --hard, clean), pipe-into-a-shell / remote-code-exec (| sh, | bash,
 * curl ... |, iwr ... | iex, Invoke-Expression), broad permission/owner
 * changes (chmod -R, chown -R), and npm publish.
 */
const RISKY_PATTERNS: RegExp[] = [
  // rm with a recursive and/or force flag (rm -r, rm -rf, rm -fr, rm -f -r, …).
  /\brm\b[^\n|&;]*\s-[a-z]*[rf][a-z]*/i,
  // rmdir (POSIX) and `rd /s` (Windows recursive directory delete).
  /\brmdir\b/i,
  /\brd\b[^\n]*\/s/i,
  // del / erase (Windows file delete).
  /\b(del|erase)\s/i,
  // Disk format / make filesystem.
  /\bformat\s/i,
  /\bmkfs\b/i,
  // Raw disk copy.
  /\bdd\s/i,
  // Classic fork bomb.
  /:\(\)\s*\{/,
  // Power state changes.
  /\b(shutdown|reboot|halt)\b/i,
  // git push --force / push -f.
  /\bgit\s+push\b[^\n]*\s(-f\b|--force\b)/i,
  // git reset --hard.
  /\bgit\s+reset\b[^\n]*--hard\b/i,
  // git clean (removes untracked files).
  /\bgit\s+clean\b/i,
  // Pipe into a shell, or download-and-execute.
  /\|\s*(sh|bash|zsh)\b/i,
  /\bcurl\b[^\n]*\|/i,
  /\bwget\b[^\n]*\|/i,
  // PowerShell download-and-run: iwr ... | iex, and Invoke-Expression generally.
  /\biwr\b[^\n]*\|\s*iex\b/i,
  /\b(iex|Invoke-Expression)\b/i,
  // Recursive permission / ownership changes.
  /\bchmod\b[^\n]*\s-R\b/i,
  /\bchown\b[^\n]*\s-R\b/i,
  // Redirect that clobbers a device node.
  />\s*\/dev\//i,
  // Publishing a package.
  /\bnpm\s+publish\b/i,
  // Truncate a file/device.
  /\btruncate\b/i
]

/** True when the command string looks destructive (matches any risky pattern). */
function isDestructiveCommand(command: string): boolean {
  return RISKY_PATTERNS.some((re) => re.test(command))
}

/** Append `chunk` to `acc` but never exceed MAX_OUTPUT_BYTES; flags truncation. */
function appendCapped(
  acc: { text: string; bytes: number; truncated: boolean },
  chunk: string
): void {
  if (acc.truncated) return
  const remaining = MAX_OUTPUT_BYTES - acc.bytes
  if (remaining <= 0) {
    acc.truncated = true
    return
  }
  const buf = Buffer.from(chunk, 'utf8')
  if (buf.length <= remaining) {
    acc.text += chunk
    acc.bytes += buf.length
  } else {
    acc.text += buf.subarray(0, remaining).toString('utf8')
    acc.bytes = MAX_OUTPUT_BYTES
    acc.truncated = true
  }
}

/**
 * Run `command` via the platform shell with cwd pinned to the workspace.
 * Resolves to a single result STRING for EVERY outcome (success, non-zero exit,
 * spawn failure, timeout, cancel) — it must never throw, since the result is fed
 * straight back to the model as a tool message.
 */
async function runCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = args.command
  if (typeof command !== 'string' || command.trim() === '') {
    return 'Error: run_command requires a non-empty "command" string.'
  }
  // Defensive: the registry already withholds this tool when no workspace is set,
  // but a tool must never assume its preconditions held.
  if (!ctx.workspace) {
    return 'Error: no workspace is set, so commands cannot be run.'
  }
  if (ctx.signal?.aborted) {
    return 'Command cancelled before it started.'
  }

  return new Promise<string>((resolvePromise) => {
    // shell:true is REQUIRED so cmd.exe (Windows) / /bin/sh (POSIX) parses the
    // full command line — pipes, quotes, &&, etc. windowsHide stops a console
    // window flashing up. cwd is ALWAYS the workspace (the scoping mitigation).
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, {
        shell: true,
        cwd: ctx.workspace,
        windowsHide: true
      })
    } catch (err) {
      resolvePromise(`Failed to start command: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const output = { text: '', bytes: 0, truncated: false }
    let settled = false
    let timedOut = false
    let cancelled = false

    const onAbort = (): void => {
      cancelled = true
      child.kill() // best-effort tree-kill: kill the shell we spawned
      finish('Command cancelled by the user.')
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onAbort)
    }

    const finish = (message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(message)
    }

    const formatOutput = (): string => {
      const body = output.text.length > 0 ? output.text : '(no output)'
      return output.truncated ? `${body}\n…[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : body
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill() // best-effort: terminate the runaway process
      finish(`Command timed out after ${TIMEOUT_MS / 1000}s and was killed.\n\n${formatOutput()}`)
    }, TIMEOUT_MS)

    ctx.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => appendCapped(output, d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => appendCapped(output, d.toString('utf8')))

    child.on('error', (err) => {
      // Spawn-time errors (e.g. shell missing) surface here on some platforms.
      finish(`Failed to run command: ${err instanceof Error ? err.message : String(err)}`)
    })

    child.on('close', (code, signal) => {
      if (timedOut || cancelled) return // already settled with a specific message
      const exit = code !== null ? String(code) : `killed by signal ${signal ?? 'unknown'}`
      finish(`Exit code: ${exit}\n\n${formatOutput()}`)
    })
  })
}

/** The single shell tool advertised to the model. */
const RUN_COMMAND_SPEC: ToolSpec = {
  type: 'function',
  function: {
    name: TOOL_IDS.runCommand,
    description:
      'Run a shell command. It executes via the system shell with the working ' +
      "directory set to the agent's workspace folder, so relative paths are " +
      'resolved from the workspace root. Captures stdout and stderr (combined, ' +
      'capped) and returns the exit code. There is a 60-second timeout. Use this ' +
      'for builds, tests, package managers, git, and other CLI tasks.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The command line to run in the workspace folder (e.g. "npm test" or "git status").'
        }
      },
      required: ['command']
    }
  }
}

export const SHELL_TOOLS: ToolDefinition[] = [
  {
    spec: RUN_COMMAND_SPEC,
    id: TOOL_IDS.runCommand,
    sideEffecting: true,
    requiresWorkspace: true,
    destructive: (args) =>
      typeof args.command === 'string' ? isDestructiveCommand(args.command) : false,
    run: runCommand
  }
]
