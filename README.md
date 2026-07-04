# Sunny — Standalone Agentic AI Command Center

Sunny is a **local-first, standalone desktop command center for agentic AI work**. You install it, add your own provider OAuth logins or API keys, and get real work done — multi-provider chat, persistent memory, a task/Kanban board the agents read and write, and multi-agent execution. Everything (keys, chat history, tasks, memory) lives on your machine. No required hosted backend, no account, no telemetry.

## ⬇️ Download

**[Get the latest release →](https://github.com/dodaniel351/sunny/releases/latest)** — pick the build for your platform:

- **macOS** — `Sunny-<version>-arm64.dmg` for **Apple Silicon** (M1/M2/M3/M4) or `Sunny-<version>-x64.dmg` for **Intel** Macs. Signed & notarized by Apple: open the dmg and drag **Sunny** to Applications. (Not sure which? Apple menu → About This Mac — "Apple M…" = arm64, "Intel" = x64.)
- **Windows** — `Sunny-<version>-setup-x64.exe`. The installer is **unsigned**, so SmartScreen will warn on first run — choose **More info → Run anyway**.
- **Linux (Debian/Ubuntu)** — `Sunny-<version>-amd64.deb`. Install with `sudo apt install ./Sunny-<version>-amd64.deb`; needs a desktop keyring (GNOME Keyring, default on Ubuntu) for secret storage.

> When upgrading, **quit Sunny first** (from the system tray on Windows/Linux, or ⌘Q on macOS) before reinstalling — see the [User Guide](docs/USER-GUIDE.md#1-getting-started).

## 📖 Documentation

**[User Guide →](docs/USER-GUIDE.md)** — the complete guide to using Sunny: connecting providers, chat, agents and permission modes, the autonomous board, approvals, schedules, memory, MCP servers, budgets, and troubleshooting.

> **Status:** all nine spec phases plus the "structure layer" (goals, delegation, approvals, team, scheduler) and the autonomy tier (iterative agent loop with verification, MCP client, board-manipulation tools, cost/budget metering) are implemented. Multi-provider chat, persistent graph memory, an autonomous task worker, and installers for macOS (signed & notarized), Windows, and Linux all work. See the [User Guide](docs/USER-GUIDE.md) for the full feature set.

## Tech stack

- **Shell:** Electron + [electron-vite](https://electron-vite.org), packaged with electron-builder
- **Renderer:** React + TypeScript + Vite, Tailwind CSS, Zustand, React Router (HashRouter), lucide-react
- **Main process:** Node + TypeScript — houses the data layer, secret store, and (in later phases) the agent runtime, provider adapters, and OAuth flows
- **Persistence:** SQLite via `better-sqlite3`; vector search via the `sqlite-vec` loadable extension; a versioned migration runner
- **Secrets:** `keytar` (OS keychain) with Electron `safeStorage` as a fallback
- **Validation:** Zod on every IPC boundary
- **Tests:** Vitest (unit) + Playwright (Electron end-to-end smoke)

## Architecture (Phase 1)

```
src/
  main/            # Node/Electron main process
    index.ts       #   app lifecycle, secure window, startup wiring
    db/            #   better-sqlite3 connection, migration runner, v1 schema
    secrets/       #   SecretStore + keytar / safeStorage backends
    ipc/           #   typed, Zod-validated IPC handlers
  preload/         # narrow context-isolated bridge (window.sunny)
  renderer/        # React UI — dashboard shell + routed views
  shared/          # cross-process types (Zod): db row types, IPC contract
tests/
  unit/            # Vitest — pure logic (migration runner, secret store) with fakes
  e2e/             # Playwright — launches the real app, asserts boot + IPC + DB + keychain
```

**Security posture:** the renderer is untrusted — `contextIsolation: true`, `nodeIntegration: false`, and a narrow preload bridge. The renderer never holds a raw key or makes a direct provider call; it talks to main over typed IPC only.

**Native modules & testing:** `better-sqlite3`, `keytar`, and `sqlite-vec` are compiled for Electron's ABI, so they can't load under plain Node (which Vitest uses). The migration runner and secret store are therefore **backend-agnostic** (dependency-injected) so their logic is unit-tested with in-memory fakes; the real native modules are verified through the Electron runtime by the Playwright smoke test.

## Prerequisites

- **Node.js** ≥ 20 (developed on 24)
- **pnpm** ≥ 10 (`npm i -g pnpm`)
- **Native build toolchain** (only needed if a prebuilt binary isn't available for your platform): on Windows, Visual Studio Build Tools with the "Desktop development with C++" workload + Python 3; on macOS, Xcode Command Line Tools; on Linux, `build-essential` + `libsecret-1-dev` (for keytar).

## Getting started

```bash
pnpm install        # installs deps and rebuilds native modules for Electron's ABI
pnpm dev            # launch the app in development (HMR)
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the app in development with hot reload |
| `pnpm build` | Typecheck + build all three targets into `out/` |
| `pnpm typecheck` | Strict TypeScript check (main/preload + renderer) |
| `pnpm lint` | ESLint over `.ts`/`.tsx` |
| `pnpm format` | Prettier write |
| `pnpm test` | Vitest unit tests |
| `pnpm test:e2e` | Playwright Electron smoke test (run `pnpm build` first) |
| `pnpm package:win` / `:mac` / `:linux` | Build a distributable installer |

> The first `pnpm test:e2e` requires a prior `pnpm build` (it launches the built `out/main/index.js`).

## Data location

All user data is stored locally under the OS app-data directory (`app.getPath('userData')`):

- `sunny.sqlite` — the local database (chats, tasks, memory, providers, settings)
- `secrets.enc.json` — encrypted secret store **only** when the safeStorage fallback is in use; otherwise secrets live in the OS keychain via keytar

Secrets (API keys / OAuth tokens) are **never** stored in the SQLite file, never written in plaintext, and never logged. The database references a secret only by an opaque id.

## Packaging

```bash
pnpm package:win     # NSIS installer (Windows x64)
pnpm package:mac     # DMG (arm64 + x64)
pnpm package:linux   # .deb
```

Output lands in `release/<version>/`.

## License

Private / UNLICENSED (personal project).
