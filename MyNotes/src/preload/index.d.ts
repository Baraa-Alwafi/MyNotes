import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface MyNotesApi {
    fetchCalendar: (url: string) => Promise<string>
    syncTaskReminders: (
      tasks: {
        id: string
        title: string
        due: string
        dueTime?: string
        reminder?: '15m' | '1h' | '1d' | '1w' | null
        done: boolean
      }[]
    ) => void
  }

  interface Window {
    electron: ElectronAPI
    api: MyNotesApi
  }
}
