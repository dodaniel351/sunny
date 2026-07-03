// Dev helper: launch the built Electron app and screenshot the dashboard.
// Usage: pnpm build && node scripts/screenshot.mjs [outPath]
import { _electron as electron } from '@playwright/test'

const out = process.argv[2] ?? 'docs/phase1-dashboard.png'

const app = await electron.launch({
  args: ['out/main/index.js'],
  env: { ...process.env, NODE_ENV: 'test', CI: '1' }
})

const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
// Give the IPC ping + first paint a moment to settle.
await win.waitForTimeout(900)
await win.screenshot({ path: out })
console.log(`screenshot written to ${out}`)
await app.close()
