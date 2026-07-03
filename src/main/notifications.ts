import { Notification } from 'electron'
import type { SettingsRepo } from '@main/repositories'

// OS-level notifications for the autonomous runtime (autonomy hardening,
// 0.4.3). Sunny lives in the tray; without these, a pending approval or a
// blocked task produces zero external signal and unattended work stalls
// unnoticed until the user happens to open the app. Gated by the
// `notifications_enabled` setting (default ON — 'off' disables) so the user
// can silence them. Clicking a notification raises the main window.
//
// Kept as an injected function (not imported directly by the worker/scheduler)
// so those modules stay free of electron imports and unit-testable.

const SETTING = 'notifications_enabled'

export type Notify = (n: { title: string; body: string }) => void

export function createNotifier(deps: {
  settings: SettingsRepo
  onClick?: () => void
}): Notify {
  return ({ title, body }) => {
    try {
      if (deps.settings.get(SETTING) === 'off') return
      if (!Notification.isSupported()) return
      // Bodies can carry long block reasons; keep the toast readable.
      const trimmed = body.length > 200 ? body.slice(0, 200) + '…' : body
      const notification = new Notification({ title, body: trimmed, silent: false })
      if (deps.onClick) notification.on('click', deps.onClick)
      notification.show()
    } catch (err) {
      // Notifications are best-effort — never let them break the runtime.
      console.error('[sunny] notification failed', err)
    }
  }
}
