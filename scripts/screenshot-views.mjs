// Dev helper: launch the built app and screenshot each main view.
// Usage: pnpm build && node scripts/screenshot-views.mjs
import { _electron as electron } from '@playwright/test'

const app = await electron.launch({
  args: ['out/main/index.js'],
  env: { ...process.env, NODE_ENV: 'test', CI: '1' }
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(900)

const routes = [
  ['', 'docs/views-dashboard.png'],
  ['board', 'docs/views-board.png'],
  ['agents', 'docs/views-agents.png'],
  ['memory', 'docs/views-memory.png'],
  ['settings', 'docs/views-settings.png']
]
for (const [route, out] of routes) {
  await win.evaluate((r) => {
    window.location.hash = '#/' + r
  }, route)
  await win.waitForTimeout(700)
  await win.screenshot({ path: out })
  console.log('shot', out)
}
await app.close()
