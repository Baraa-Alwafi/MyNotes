import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface MyNotesApi {
    fetchCalendar: (url: string) => Promise<string>
  }

  interface Window {
    electron: ElectronAPI
    api: MyNotesApi
  }
}
