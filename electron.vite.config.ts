import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite builds three targets: main (Node), preload (Node, sandbox-aware),
// and renderer (browser). Native + heavy node-only deps are externalized so they
// are required at runtime from node_modules rather than bundled.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    // A SANDBOXED preload (sandbox:true) may only `require('electron')` — it
    // cannot require node_modules at runtime. So we BUNDLE the preload's deps
    // (@electron-toolkit/preload + zod, pulled in via the shared contract)
    // instead of externalizing them; only 'electron' stays external.
    plugins: [externalizeDepsPlugin({ exclude: ['@electron-toolkit/preload', 'zod'] })],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
