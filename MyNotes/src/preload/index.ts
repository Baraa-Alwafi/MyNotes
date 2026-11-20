import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type TaskReminderNotice = {
  title: string
  body: string
}

// Custom APIs for renderer
const api = {
  fetchCalendar: (url: string): Promise<string> => ipcRenderer.invoke('calendar:fetch', url),
  syncTaskReminders: (
    tasks: {
      id: string
      title: string
      due: string
      dueTime?: string
      reminder?: '15m' | '1h' | '1d' | '1w' | null
      done: boolean
    }[]
  ): void => ipcRenderer.send('reminders:sync', tasks),
  onTaskReminder: (callback: (notice: TaskReminderNotice) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, notice: TaskReminderNotice): void =>
      callback(notice)
    ipcRenderer.on('reminders:notification', listener)
    return () => ipcRenderer.removeListener('reminders:notification', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
