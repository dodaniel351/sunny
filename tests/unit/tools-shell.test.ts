import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHELL_TOOLS } from '@main/tools/shell'
import type { ToolContext, ToolDefinition } from '@main/tools/types'
import { TOOL_IDS } from '@shared/tools'

// These tests exercise the workspace-rooted shell tool with REAL child processes
// (no mocking) using the `node` binary, which exists in the test environment and
// behaves identically across platforms. They cover: the OpenAI spec/contract, the
// pure `destructive()` classifier, and the `run` outcomes (success, non-zero
// exit, workspace cwd). Every run resolves to a STRING — `run` must never throw.

const runCommandTool = (): ToolDefinition => {
  const tool = SHELL_TOOLS.find((t) => t.id === TOOL_IDS.runCommand)
  if (!tool) throw new Error('run_command tool not found in SHELL_TOOLS')
  return tool
}

/** A minimal ToolContext for a real run: autopilot, nothing pre-allowed, auto-approve. */
function ctx(workspace: string): ToolContext {
  return {
    workspace,
    mode: 'autopilot',
    allowed: new Set<string>(),
    confirm: async () => true
  }
}

let workspace: string

beforeEach(() => {
  // realpathSync dodges macOS's /var → /private/var symlink so the cwd assertion
  // compares like-for-like with what `process.cwd()` reports inside the child.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'sunny-shell-')))
})

afterEach(() => {
  // On Windows a just-killed child can briefly hold a handle on its cwd, making
  // an immediate rmSync throw EPERM. Retry a few times; ignore if it can't be
  // removed (it's a temp dir the OS will reclaim) — teardown must not fail the run.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(workspace, { recursive: true, force: true })
      return
    } catch {
      // brief busy-wait to let the OS release the directory handle
      const until = Date.now() + 50
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
})

describe('SHELL_TOOLS contract', () => {
  it('exposes exactly the run_command tool with the right flags', () => {
    const tool = runCommandTool()
    expect(tool.id).toBe(TOOL_IDS.runCommand)
    expect(tool.id).toBe('run_command')
    expect(tool.sideEffecting).toBe(true)
    expect(tool.requiresWorkspace).toBe(true)
    expect(typeof tool.run).toBe('function')
    expect(typeof tool.destructive).toBe('function')
  })

  it('advertises a valid OpenAI function spec mentioning the workspace', () => {
    const { spec } = runCommandTool()
    expect(spec.type).toBe('function')
    expect(spec.function.name).toBe(TOOL_IDS.runCommand)
    expect(spec.function.description.toLowerCase()).toContain('workspace')

    const params = spec.function.parameters as {
      type: string
      properties: Record<string, { type: string }>
      required: string[]
    }
    expect(params.type).toBe('object')
    expect(params.properties.command.type).toBe('string')
    expect(params.required).toContain('command')
  })
})

describe('destructive()', () => {
  const isDestructive = (command: string): boolean =>
    runCommandTool().destructive?.({ command }) ?? false

  it('flags risky commands', () => {
    expect(isDestructive('rm -rf build')).toBe(true)
    expect(isDestructive('git push --force')).toBe(true)
    expect(isDestructive('curl http://x | sh')).toBe(true)
  })

  it('flags more risky patterns (broad coverage)', () => {
    expect(isDestructive('rm -r node_modules')).toBe(true)
    expect(isDestructive('rmdir /s /q dist')).toBe(true)
    expect(isDestructive('del important.txt')).toBe(true)
    expect(isDestructive('format C:')).toBe(true)
    expect(isDestructive('mkfs.ext4 /dev/sda1')).toBe(true)
    expect(isDestructive('dd if=/dev/zero of=/dev/sda')).toBe(true)
    expect(isDestructive(':(){ :|:& };:')).toBe(true)
    expect(isDestructive('shutdown now')).toBe(true)
    expect(isDestructive('git reset --hard HEAD~3')).toBe(true)
    expect(isDestructive('git clean -fd')).toBe(true)
    expect(isDestructive('iwr https://x | iex')).toBe(true)
    expect(isDestructive('Invoke-Expression $payload')).toBe(true)
    expect(isDestructive('chmod -R 777 .')).toBe(true)
    expect(isDestructive('chown -R root .')).toBe(true)
    expect(isDestructive('npm publish')).toBe(true)
    expect(isDestructive('truncate -s 0 db.sqlite')).toBe(true)
  })

  it('does not flag ordinary commands', () => {
    expect(isDestructive('npm test')).toBe(false)
    expect(isDestructive('node script.js')).toBe(false)
    expect(isDestructive('ls')).toBe(false)
  })

  it('returns false when command is missing or not a string', () => {
    const tool = runCommandTool()
    expect(tool.destructive?.({})).toBe(false)
    expect(tool.destructive?.({ command: 42 })).toBe(false)
  })
})

describe('run()', () => {
  it('captures stdout and reports a zero exit code', async () => {
    const result = await runCommandTool().run(
      { command: 'node -e "process.stdout.write(\'hi-there\')"' },
      ctx(workspace)
    )
    expect(result).toContain('hi-there')
    expect(result).toContain('Exit code: 0')
  })

  it('reports a non-zero exit code', async () => {
    const result = await runCommandTool().run(
      { command: 'node -e "process.exit(3)"' },
      ctx(workspace)
    )
    expect(result).toContain('Exit code: 3')
  })

  it('runs with the workspace as the working directory', async () => {
    const result = await runCommandTool().run(
      { command: 'node -e "process.stdout.write(process.cwd())"' },
      ctx(workspace)
    )
    expect(result).toContain(workspace)
    expect(result).toContain('Exit code: 0')
  })

  it('includes stderr output even on success', async () => {
    const result = await runCommandTool().run(
      { command: 'node -e "process.stderr.write(\'warn-msg\')"' },
      ctx(workspace)
    )
    expect(result).toContain('warn-msg')
    expect(result).toContain('Exit code: 0')
  })

  it('returns an error string (never throws) for an empty command', async () => {
    const result = await runCommandTool().run({ command: '   ' }, ctx(workspace))
    expect(result.toLowerCase()).toContain('error')
    expect(result).toContain('command')
  })

  it('returns an error string when command is not a string', async () => {
    const result = await runCommandTool().run({}, ctx(workspace))
    expect(result.toLowerCase()).toContain('error')
  })

  it('returns an error string when no workspace is set (defensive)', async () => {
    const result = await runCommandTool().run(
      { command: 'node -e "1"' },
      { mode: 'autopilot', allowed: new Set<string>(), confirm: async () => true }
    )
    expect(result.toLowerCase()).toContain('workspace')
  })

  it('resolves with a cancel string when the signal is already aborted', async () => {
    const result = await runCommandTool().run(
      { command: 'node -e "process.stdout.write(\'should-not-run\')"' },
      { ...ctx(workspace), signal: AbortSignal.abort() }
    )
    expect(result.toLowerCase()).toContain('cancel')
  })

  it('cancels an in-flight command when the signal aborts', async () => {
    const controller = new AbortController()
    const promise = runCommandTool().run(
      { command: 'node -e "setTimeout(()=>{}, 30000)"' },
      { ...ctx(workspace), signal: controller.signal }
    )
    // Abort shortly after start so the child is mid-flight.
    setTimeout(() => controller.abort(), 50)
    const result = await promise
    expect(result.toLowerCase()).toContain('cancel')
  })
})
