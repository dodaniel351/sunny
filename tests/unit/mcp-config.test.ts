import { describe, it, expect } from 'vitest'
import {
  parseMcpServers,
  serializeMcpServers,
  mcpToolFullName,
  parseMcpToolFullName,
  type McpServerConfig
} from '@main/mcp/config'

// config.ts is a pure module (no electron/SDK imports) so it's unit-testable
// without booting Electron — see src/main/mcp/config.ts.

describe('parseMcpServers', () => {
  it('returns [] for null', () => {
    expect(parseMcpServers(null)).toEqual([])
  })

  it('returns [] for malformed JSON', () => {
    expect(parseMcpServers('not json{')).toEqual([])
  })

  it('returns [] for valid JSON that is not an array', () => {
    expect(parseMcpServers('{"id":"x"}')).toEqual([])
  })

  it('parses a valid server list', () => {
    const json = JSON.stringify([
      { id: 'fs', name: 'Filesystem', command: 'npx', args: ['-y', 'server-fs'], enabled: false }
    ])
    expect(parseMcpServers(json)).toEqual([
      { id: 'fs', name: 'Filesystem', command: 'npx', args: ['-y', 'server-fs'], enabled: false }
    ])
  })

  it('defaults enabled to true when absent', () => {
    const json = JSON.stringify([{ id: 'fs', name: 'Filesystem', command: 'npx' }])
    expect(parseMcpServers(json)).toEqual([
      { id: 'fs', name: 'Filesystem', command: 'npx', args: [], enabled: true }
    ])
  })

  it('coerces non-string args entries away', () => {
    const json = JSON.stringify([
      { id: 'fs', name: 'Filesystem', command: 'npx', args: ['-y', 42, null, 'ok'] }
    ])
    expect(parseMcpServers(json)).toEqual([
      { id: 'fs', name: 'Filesystem', command: 'npx', args: ['-y', 'ok'], enabled: true }
    ])
  })

  it('skips entries missing id, name, or command', () => {
    const json = JSON.stringify([
      { id: 'fs', name: 'Filesystem' }, // no command
      { id: 'fs2', command: 'npx' }, // no name
      { name: 'Filesystem3', command: 'npx' }, // no id
      { id: 'ok', name: 'OK', command: 'npx' }
    ])
    expect(parseMcpServers(json)).toEqual([
      { id: 'ok', name: 'OK', command: 'npx', args: [], enabled: true }
    ])
  })

  it('skips non-object entries in the array', () => {
    const json = JSON.stringify([null, 'foo', 42, { id: 'ok', name: 'OK', command: 'npx' }])
    expect(parseMcpServers(json)).toEqual([
      { id: 'ok', name: 'OK', command: 'npx', args: [], enabled: true }
    ])
  })
})

describe('serializeMcpServers', () => {
  it('round-trips through parseMcpServers', () => {
    const servers: McpServerConfig[] = [
      { id: 'fs', name: 'Filesystem', command: 'npx', args: ['-y', 'x'], enabled: true },
      { id: 'gh', name: 'GitHub', command: 'node', args: [], enabled: false }
    ]
    expect(parseMcpServers(serializeMcpServers(servers))).toEqual(servers)
  })

  it('serializes an empty list', () => {
    expect(serializeMcpServers([])).toBe('[]')
  })
})

describe('mcpToolFullName', () => {
  it('builds the mcp__<serverId>__<toolName> shape', () => {
    expect(mcpToolFullName('fs', 'read_file')).toBe('mcp__fs__read_file')
  })

  it('sanitizes spaces and dots in the serverId to safe chars', () => {
    const full = mcpToolFullName('my server.v2', 'read_file')
    expect(full).toMatch(/^mcp__[a-zA-Z0-9_-]+__read_file$/)
    // Spaces/dots must not survive as literal characters.
    expect(full).not.toContain(' ')
    expect(full).not.toContain('.')
  })

  it('sanitizes spaces and dots in the toolName to safe chars', () => {
    const full = mcpToolFullName('fs', 'read file.txt')
    expect(full).toBe('mcp__fs__read_file_txt')
  })

  it('never produces an ambiguous "__" inside the sanitized serverId', () => {
    // A raw serverId that already contains adjacent underscores (or would map
    // to them via sanitization) must still collapse to a single delimiter.
    const full = mcpToolFullName('my__server', 'tool')
    const serverIdPart = full.slice('mcp__'.length, full.length - '__tool'.length)
    expect(serverIdPart).not.toContain('__')
  })
})

describe('parseMcpToolFullName', () => {
  it('round-trips a simple name', () => {
    const full = mcpToolFullName('fs', 'read_file')
    expect(parseMcpToolFullName(full)).toEqual({ serverId: 'fs', toolName: 'read_file' })
  })

  it('round-trips when the toolName itself contains "__"', () => {
    const full = mcpToolFullName('github', 'list__pull__requests')
    expect(parseMcpToolFullName(full)).toEqual({
      serverId: 'github',
      toolName: 'list__pull__requests'
    })
  })

  it('round-trips a sanitized serverId with dashes', () => {
    const full = mcpToolFullName('my server.v2', 'search')
    const parsed = parseMcpToolFullName(full)
    expect(parsed).not.toBeNull()
    expect(parsed?.toolName).toBe('search')
    expect(parsed?.serverId).not.toContain('__')
  })

  it('returns null for a name without the mcp__ prefix', () => {
    expect(parseMcpToolFullName('read_file')).toBeNull()
  })

  it('returns null for a name missing the second delimiter', () => {
    expect(parseMcpToolFullName('mcp__fs_read_file')).toBeNull()
  })
})
