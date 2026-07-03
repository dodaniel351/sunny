import type { ElectronAPI } from '@electron-toolkit/preload'
import type { SunnyApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    sunny: SunnyApi
  }
}

export {}
