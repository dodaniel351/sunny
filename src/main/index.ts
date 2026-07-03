import {
  app,
  shell,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'path'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, runMigrations, migrations, getDbHealth, closeDatabase } from '@main/db'
import { createSecretStore, getSecretsHealth } from '@main/secrets'
import { createProviderRegistry } from '@main/providers'
import { disposeCodex } from '@main/providers/codex'
import { createRepositories, DEFAULT_AGENT_PRESETS } from '@main/repositories'
import { OLLAMA_DEFAULT_BASE_URL, OPENCODE_DEFAULT_BASE_URL } from '@main/providers'
import { resolveEmbedder } from '@main/memory/resolve-embedder'
import { reconcileVectorDimension } from '@main/memory/vector-store'
import { MemoryService } from '@main/memory/service'
import { TaskWorker } from '@main/worker/task-worker'
import { Scheduler } from '@main/scheduler/scheduler'
import { createNotifier } from '@main/notifications'
import { registerIpcHandlers } from '@main/ipc'
import { McpManager } from '@main/mcp/manager'
import { configureWebSearch, parseSearchProvider } from '@main/tools/search-config'

// Phase 1 main process: bring up the local-first data layer (SQLite + migrations
// and the OS-keychain secret store), register typed IPC, then create the secure
// window. All user data stays on the machine (spec §2).

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let taskWorker: TaskWorker | null = null
let scheduler: Scheduler | null = null
let mcpManager: McpManager | null = null
// True only when the user really wants to exit (tray "Quit Sunny" / OS quit), so
// the window's close button hides to the tray instead of quitting — keeping the
// worker + scheduler running in the background. `trayHintShown` gates the
// one-time "still running" balloon.
let isQuitting = false
let trayHintShown = false

// Persistent main-process log. console output is invisible in a packaged GUI
// app, so we also append to a file in the app-data dir — startup failures in a
// shipped build are diagnosable from `sunny-main.log` rather than a silent ghost.
function logMain(message: string, err?: unknown): void {
  const detail = err ? ` :: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` : ''
  const line = `[${new Date().toISOString()}] ${message}${detail}\n`
  try {
    const dir = app.isReady() ? app.getPath('userData') : tmpdir()
    appendFileSync(join(dir, 'sunny-main.log'), line)
  } catch {
    /* best effort — never let logging throw */
  }
  if (err) console.error('[sunny]', message, err)
  else console.log('[sunny]', message)
}

// A stray rejection/exception in the main process should be logged, never
// silently take the app (or a half-finished DB write) down without a trace.
process.on('unhandledRejection', (reason) => logMain('unhandledRejection', reason))
process.on('uncaughtException', (err) => logMain('uncaughtException', err))

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0d13',
    title: 'Sunny',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security posture (spec §11): renderer is fully locked down — OS sandbox on,
      // context isolation on, no Node integration. The preload only uses
      // contextBridge + ipcRenderer (+ a bundled @electron-toolkit/preload), all
      // sandbox-safe; its deps are bundled (see electron.vite.config.ts) so it
      // needs no node_modules require at runtime.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    logMain('window: ready-to-show')
    mainWindow?.show()
  })

  // Close-to-tray: the window's close button hides the app (the worker +
  // scheduler keep running) instead of quitting — unless we're really exiting
  // (tray "Quit Sunny" / OS quit) or the tray isn't available.
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault()
      mainWindow?.hide()
      showTrayHintOnce()
    }
  })
  // Safety net: if the renderer never reaches first paint (so ready-to-show
  // never fires), show the window anyway rather than leave an invisible process.
  // The load diagnostics below record WHY it failed to paint, if it did.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      logMain('window: ready-to-show did not fire within 6s — forcing show')
      mainWindow.show()
    }
  }, 6000)

  const wc = mainWindow.webContents
  wc.on('did-finish-load', () => logMain('renderer: did-finish-load'))
  wc.on('did-fail-load', (_e, code, desc, url) =>
    logMain(`renderer: did-fail-load code=${code} desc="${desc}" url=${url}`)
  )
  wc.on('render-process-gone', (_e, d) =>
    logMain(`renderer: render-process-gone reason=${d.reason} exitCode=${d.exitCode}`)
  )
  wc.on('preload-error', (_e, preloadPath, err) =>
    logMain(`renderer: preload-error ${preloadPath}`, err)
  )

  // Right-click edit menu. Electron's renderer has no native context menu, so we
  // build one in the main process (sandbox-safe). The edit *roles* auto-wire the
  // clipboard actions, labels, and accelerators; we enable each from the event's
  // editFlags so the menu stays context-aware, and only pop it when there is
  // something to act on (an editable field or a non-empty selection).
  wc.on('context-menu', (_e, params) => {
    const hasSelection = params.selectionText.trim().length > 0
    if (!params.isEditable && !hasSelection) return
    const { editFlags } = params
    const template: MenuItemConstructorOptions[] = [
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll }
    ]
    Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined })
  })

  // Open external links in the user's browser, never in-app — and only real web
  // links: refuse custom schemes (javascript:, file:, protocol handlers) that a
  // compromised renderer might try to launch via the OS.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite injects the dev server URL in development; load the built
  // file in production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Bring the window to the foreground — show a hidden/minimized one, or recreate
// it if it was destroyed. Used by the tray, dock activate, and second-instance.
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// System-tray icon so Sunny keeps running (agents + schedules) after the window
// is closed; the only true exit is the tray's "Quit Sunny". If the icon can't be
// loaded we skip the tray so the user is never stranded without a way to quit
// (window-all-closed then falls back to quitting normally).
function createTray(): void {
  if (tray) return
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) {
    logMain(`tray: icon not found at ${iconPath} — tray disabled (close will quit)`)
    return
  }
  tray = new Tray(source.resize({ width: 16, height: 16 }))
  tray.setToolTip('Sunny — running in the background')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Sunny', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: 'Quit Sunny',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

// One-time hint (Windows) that closing didn't quit — Sunny is in the tray.
function showTrayHintOnce(): void {
  if (trayHintShown || process.platform !== 'win32' || !tray) return
  trayHintShown = true
  try {
    tray.displayBalloon({
      title: 'Sunny is still running',
      content:
        'Sunny keeps running in the background so agents and schedules continue. ' +
        'Right-click the tray icon to quit.'
    })
  } catch {
    /* best effort — balloons are non-critical */
  }
}

// Single-instance lock — Sunny is a local-first single-user app.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.sunny.commandcenter')
    logMain('whenReady: start')

    // Bring up services. Wrapped so a failure (e.g. a native module, a corrupt
    // DB) still opens the window in a degraded state instead of an invisible,
    // process-alive ghost — and the cause lands in sunny-main.log.
    try {
      // Local-first data layer. The DB and the safeStorage fallback both live
      // under the OS app-data dir; secrets themselves go to the keychain (§2).
      const userDataDir = app.getPath('userData')
      const db = initDatabase(join(userDataDir, 'sunny.sqlite'))
      const migrationResult = runMigrations(db, migrations)
      const secretStore = createSecretStore({ userDataDir })
      const repos = createRepositories(db)
      // Seed/refresh the built-in agent presets. The version gate re-applies the
      // latest preset definitions (role/system-prompt) when they change in code,
      // without clobbering user-created agents or pinned provider/model.
      const PRESETS_VERSION = '3'
      if (repos.settings.get('presets_version') !== PRESETS_VERSION) {
        repos.agents.upsertPresets(DEFAULT_AGENT_PRESETS)
        repos.settings.set('presets_version', PRESETS_VERSION)
      }
      // The network-free fake provider is opt-in (e2e/offline dev) so it never
      // appears in production. The smoke test sets SUNNY_ENABLE_FAKE_PROVIDER=1.
      const ollamaBaseUrl = repos.settings.get('ollama_base_url') ?? OLLAMA_DEFAULT_BASE_URL
      const registry = createProviderRegistry({
        includeFake: process.env['SUNNY_ENABLE_FAKE_PROVIDER'] === '1',
        // Live getter so a Base URL change in Settings applies without a restart,
        // and chat hits the same server the model list came from.
        ollamaBaseUrl: () => repos.settings.get('ollama_base_url') ?? OLLAMA_DEFAULT_BASE_URL,
        // Same for the local opencode server (+ optional basic-auth password).
        opencodeBaseUrl: () => repos.settings.get('opencode_base_url') ?? OPENCODE_DEFAULT_BASE_URL,
        opencodePassword: () => repos.settings.get('opencode_password') ?? ''
      })

      // Memory embedder (spec §5/§2): resolve from the user's choice in Settings
      // (or the legacy auto chain — local Ollama embed model → OpenAI key → off).
      // Resolution PROBES the model with a live /embeddings call (up to a 20s
      // ceiling), so we must NOT block window creation on it. Start with
      // embeddings off and switch them on in the background via the same live
      // `configure()` path the Memory picker uses.
      const memory = new MemoryService({
        graph: repos.memoryGraph,
        memories: repos.memories,
        settings: repos.settings,
        embedder: { provider: 'none', model: '', embed: async () => [] },
        hasEmbeddings: () => false
      })
      // Fire-and-forget: size the sqlite-vec table to the active model's dimension
      // and swap the real embedder in once it resolves. Never awaited here, so the
      // window opens immediately regardless of network latency.
      void (async () => {
        try {
          const resolved = await resolveEmbedder({
            settings: repos.settings,
            providers: repos.providers,
            secretStore,
            ollamaBaseUrl
          })
          if (resolved.available) reconcileVectorDimension(db, repos.settings, resolved.dim)
          memory.configure(resolved.embedder, resolved.available)
          console.log(
            `[sunny] memory embeddings: ${
              resolved.available
                ? `${resolved.embedder.provider}/${resolved.embedder.model} (${resolved.dim}d)`
                : 'off'
            }`
          )
        } catch (err) {
          console.error('[sunny] memory embedder resolution failed', err)
        }
      })()

      // OS notifications for the autonomous runtime — Sunny lives in the tray,
      // so a pending approval / blocked task / finished run needs an external
      // signal or unattended work stalls unnoticed. Click raises the window.
      const notify = createNotifier({ settings: repos.settings, onClick: showMainWindow })

      // Web search provider (0.5.1): live getters, so changing the provider/key
      // in Settings applies to the next search with no restart. Keyless DDG
      // remains the default and the fallback when an API provider fails.
      configureWebSearch({
        getProvider: () => parseSearchProvider(repos.settings.get('search_provider')),
        getKey: () => repos.settings.get('search_api_key') ?? ''
      })

      // MCP (Model Context Protocol) client manager (structure layer): connects
      // to the user's configured stdio servers so agents can call external tools
      // (email, GitHub, databases, etc.). Constructed BEFORE the worker so the
      // worker's toolset can reach MCP tools. refresh() spawns child processes
      // and talks over stdio, so it's fired void — a slow/bad server must never
      // delay window creation.
      const mcp = new McpManager({ settings: repos.settings })
      mcpManager = mcp
      void mcp.refresh().catch((err) => console.error('[sunny] mcp refresh failed', err))

      // Autonomous task worker (spec §7): scans the board on an interval and works
      // tasks with the assigned/default agent. Off by default (makes model calls
      // on a timer) — the user enables it from the Board.
      const worker = new TaskWorker({
        repos,
        registry,
        secretStore,
        memory,
        generatedDir: join(userDataDir, 'generated'),
        notify,
        mcp
      })
      taskWorker = worker

      // Scheduler (spec §7): fires due schedules by creating a task and running it
      // through the worker. The tick loop always runs (cheap); each schedule's own
      // enabled flag gates firing — independent of the auto-scan worker toggle.
      const sched = new Scheduler({ repos, worker, notify })
      scheduler = sched

      registerIpcHandlers({
        db,
        secretStore,
        registry,
        repos,
        memory,
        worker,
        scheduler: sched,
        mcp
      })
      worker.start()
      sched.start()

      const dbHealth = getDbHealth(db)
      logMain(
        `data layer ready — db v${migrationResult.currentVersion}` +
          ` (${dbHealth.tables.length} tables, vec=${dbHealth.vecAvailable}),` +
          ` secrets=${getSecretsHealth().backend}`
      )
    } catch (err) {
      logMain('whenReady: service initialization FAILED — opening window in degraded mode', err)
    }

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    createWindow()
    createTray()
    logMain('whenReady: createWindow() called')

    app.on('activate', () => {
      // A hidden window still exists, so just show it; recreate only if gone.
      showMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    // With a tray, Sunny stays resident (close-to-tray) so agents + schedules
    // keep running; the only quit is the tray's "Quit Sunny". Without a tray
    // (icon missing) fall back to the normal quit-on-last-window behavior.
    if (!tray && process.platform !== 'darwin') app.quit()
  })

  // Any genuine quit path (tray Quit, OS shutdown, app.quit() elsewhere) must let
  // the window actually close instead of hiding back to the tray.
  app.on('before-quit', () => {
    isQuitting = true
  })

  // Flush and close the SQLite connection cleanly so WAL is checkpointed, and
  // tear down the Codex App Server child process if one was started.
  app.on('will-quit', () => {
    tray?.destroy()
    tray = null
    scheduler?.stop()
    taskWorker?.stop()
    mcpManager?.dispose()
    disposeCodex()
    closeDatabase()
  })
}
