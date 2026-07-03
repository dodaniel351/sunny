import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Vitest runs under system Node, NOT Electron. The native modules
// (better-sqlite3, keytar) are compiled for Electron's ABI and must NOT be
// imported in unit tests — they would fail to load. Keep unit tests on pure
// logic with injected fakes; the real native modules are verified through the
// Electron runtime in the Playwright smoke test (tests/e2e).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'out/**'],
    globals: true
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      // Renderer pure-logic helpers (no React/DOM) are unit-tested too; the
      // native-module caveat above still applies — keep tested modules pure.
      '@renderer': resolve('src/renderer/src')
    }
  }
})
