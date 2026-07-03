import { describe, expect, it, vi } from 'vitest'
import {
  codexStatusWithRuntime,
  loginCodexWithRuntime,
  type CodexAccount,
  type CodexRuntime
} from '@main/providers/codex'

function makeRuntime(account: CodexAccount | null): {
  runtime: CodexRuntime
  server: CodexRuntime['server']
  login: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
} {
  const start = vi.fn(async () => {
    server.isStarted = true
  })
  const login = vi.fn(async () => undefined)
  const server: CodexRuntime['server'] = {
    isStarted: false,
    start,
    readAccount: vi.fn(async () => account),
    login
  }

  return {
    server,
    login,
    start,
    runtime: {
      isCliAvailable: vi.fn(async () => true),
      server
    }
  }
}

describe('Codex provider OAuth runtime', () => {
  it('status starts the app server so a cached CLI ChatGPT session is detected', async () => {
    const account: CodexAccount = { type: 'chatgpt', email: 'user@example.test', planType: 'pro' }
    const { runtime, start } = makeRuntime(account)

    await expect(codexStatusWithRuntime(runtime)).resolves.toEqual({
      cliAvailable: true,
      signedIn: true,
      account
    })
    expect(start).toHaveBeenCalledOnce()
  })

  it('login reuses an existing ChatGPT session without starting a new browser OAuth flow', async () => {
    const account: CodexAccount = { type: 'chatgpt', email: 'user@example.test', planType: 'pro' }
    const { runtime, login } = makeRuntime(account)
    const openUrl = vi.fn()

    await expect(loginCodexWithRuntime({ type: 'chatgpt', openUrl }, runtime)).resolves.toEqual({
      cliAvailable: true,
      signedIn: true,
      account
    })
    expect(login).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })
})
