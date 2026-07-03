import { defineConfig } from '@playwright/test'

// E2E smoke tests drive the built Electron app directly (no web server).
// Run `pnpm build` first so out/main/index.js exists.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
