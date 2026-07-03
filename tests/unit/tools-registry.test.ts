import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentToolset } from '@main/tools/registry'
import type { ConfirmFn, ToolContext } from '@main/tools/types'
import { TOOL_IDS } from '@shared/tools'

// The registry is the security gate: allowlist + workspace + permission mode
// (plan blocks side effects, ask confirms them, autopilot confirms only the
// destructive ones). These tests drive the REAL fs/shell tools through it.

let ws: string
const ALL = new Set<string>([TOOL_IDS.readFile, TOOL_IDS.writeFile, TOOL_IDS.runCommand])

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'sunny-reg-'))
  writeFileSync(join(ws, 'a.txt'), 'hello')
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function ctx(over: Partial<ToolContext> & { confirm: ConfirmFn }): ToolContext {
  return { workspace: ws, mode: 'ask', allowed: ALL, ...over }
}

function call(name: string, args: object) {
  return { id: 'c1', name, arguments: JSON.stringify(args) }
}

describe('buildAgentToolset — allowlist + workspace gating', () => {
  it('only advertises allowed tools', () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(ctx({ allowed: new Set([TOOL_IDS.readFile]), confirm }))
    const names = ts.tools.map((t) => t.function.name)
    expect(names).toContain('read_file')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('run_command')
  })

  it('refuses a tool the agent is not allowed to use', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(ctx({ allowed: new Set([TOOL_IDS.readFile]), confirm }))
    const out = await ts.runTool(call('write_file', { path: 'x.txt', content: 'no' }))
    expect(out).toMatch(/not enabled/i)
    expect(existsSync(join(ws, 'x.txt'))).toBe(false)
  })

  it('drops fs/shell tools entirely when no workspace is set', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(ctx({ workspace: undefined, confirm }))
    expect(ts.tools).toHaveLength(0)
    const out = await ts.runTool(call('read_file', { path: 'a.txt' }))
    expect(out).toMatch(/not enabled/i)
  })
})

describe('permission modes', () => {
  it('read-only tools run in any mode without a confirm', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(ctx({ mode: 'ask', confirm }))
    const out = await ts.runTool(call('read_file', { path: 'a.txt' }))
    expect(out).toContain('hello')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('plan mode blocks side effects and never confirms or writes', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(ctx({ mode: 'plan', confirm }))
    const out = await ts.runTool(call('write_file', { path: 'b.txt', content: 'nope' }))
    expect(out).toMatch(/plan mode/i)
    expect(confirm).not.toHaveBeenCalled()
    expect(existsSync(join(ws, 'b.txt'))).toBe(false)
  })

  it('ask mode confirms a side effect — denied means no write', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => false)
    const ts = buildAgentToolset(ctx({ mode: 'ask', confirm }))
    const out = await ts.runTool(call('write_file', { path: 'c.txt', content: 'x' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(out).toMatch(/did not approve/i)
    expect(existsSync(join(ws, 'c.txt'))).toBe(false)
  })

  it('ask mode confirms a side effect — approved means it writes', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(ctx({ mode: 'ask', confirm }))
    await ts.runTool(call('write_file', { path: 'd.txt', content: 'yes' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(ws, 'd.txt'), 'utf8')).toBe('yes')
  })

  it('autopilot runs a non-destructive side effect without confirming', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => true)
    const ts = buildAgentToolset(ctx({ mode: 'autopilot', confirm }))
    await ts.runTool(call('write_file', { path: 'e.txt', content: 'auto' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'e.txt'), 'utf8')).toBe('auto')
  })

  it('autopilot still confirms a DESTRUCTIVE command — denied means it does not run', async () => {
    const confirm = vi.fn<ConfirmFn>(async () => false)
    const ts = buildAgentToolset(ctx({ mode: 'autopilot', confirm }))
    const out = await ts.runTool(call('run_command', { command: 'rm -rf build' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(out).toMatch(/did not approve/i)
  })
})
