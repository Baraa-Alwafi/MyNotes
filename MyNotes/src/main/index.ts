import { app, shell, BrowserWindow, ipcMain, net, Menu, Notification, Tray } from 'electron'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const maxCalendarBytes = 5 * 1024 * 1024
const maxCalendarRedirects = 5
type ReminderOffset = '15m' | '1h' | '1d' | '1w'

const reminderOffsets: Record<ReminderOffset, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000
}

type TaskReminder = {
  id: string
  title: string
  due: string
  dueTime?: string
  reminder?: '15m' | '1h' | '1d' | '1w' | null
  done: boolean
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let scheduledTasks: TaskReminder[] = []
let firedReminderKeys = new Set<string>()
let reminderTimer: NodeJS.Timeout | null = null
let reminderSweepRunning = false

function isAppFrame(url: string | undefined): boolean {
  if (!url) return false
  try {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      return new URL(url).origin === new URL(process.env['ELECTRON_RENDERER_URL']).origin
    }
    return new URL(url).protocol === 'file:'
  } catch {
    return false
  }
}

function isReminderOffset(value: unknown): value is ReminderOffset {
  return typeof value === 'string' && Object.hasOwn(reminderOffsets, value)
}

function isValidDueDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function isValidDueTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false
  const [hours, minutes] = value.split(':').map(Number)
  return hours < 24 && minutes < 60
}

function parseReminderTasks(value: unknown): TaskReminder[] {
  if (!Array.isArray(value) || value.length > 5000) {
    throw new Error('Invalid task reminder data.')
  }

  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Invalid task reminder data.')
    }

    const record = item as Record<string, unknown>
    const reminder = record.reminder
    if (
      typeof record.id !== 'string' ||
      typeof record.title !== 'string' ||
      record.title.length > 500 ||
      typeof record.due !== 'string' ||
      !isValidDueDate(record.due) ||
      (record.dueTime !== undefined &&
        (typeof record.dueTime !== 'string' || !isValidDueTime(record.dueTime))) ||
      (reminder !== undefined && reminder !== null && !isReminderOffset(reminder)) ||
      typeof record.done !== 'boolean'
    ) {
      throw new Error('Invalid task reminder data.')
    }

    return {
      id: record.id,
      title: record.title,
      due: record.due,
      dueTime: typeof record.dueTime === 'string' ? record.dueTime : undefined,
      reminder: isReminderOffset(reminder) ? reminder : null,
      done: record.done
    }
  })
}

function reminderKey(task: TaskReminder): string {
  return `${task.id}:${task.due}:${task.dueTime ?? ''}:${task.reminder}`
}

async function persistFiredReminders(): Promise<void> {
  const statePath = join(app.getPath('userData'), 'fired-task-reminders.json')
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(statePath, JSON.stringify([...firedReminderKeys]), 'utf8')
  } catch (error) {
    console.error('Unable to persist sent task reminders', error)
  }
}

async function loadFiredReminders(): Promise<void> {
  const statePath = join(app.getPath('userData'), 'fired-task-reminders.json')
  try {
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as unknown
    if (Array.isArray(stored) && stored.every((key) => typeof key === 'string')) {
      firedReminderKeys = new Set(stored.slice(-2000))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Unable to load sent task reminders', error)
    }
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  mainWindow.show()
  mainWindow.focus()
}

async function checkTaskReminders(): Promise<void> {
  if (reminderSweepRunning || !Notification.isSupported()) return
  reminderSweepRunning = true
  const now = Date.now()
  let stateChanged = false

  try {
    for (const task of scheduledTasks) {
      if (task.done || !task.reminder || firedReminderKeys.has(reminderKey(task))) continue
      const dueTime = task.dueTime || '23:59'
      const dueAt = new Date(`${task.due}T${dueTime}:00`).getTime()
      if (!Number.isFinite(dueAt)) continue
      const reminderAt = dueAt - reminderOffsets[task.reminder]
      if (now < reminderAt || now >= dueAt) continue

      const notification = new Notification({
        title: 'MyNotes task reminder',
        body: `${task.title} is due${task.dueTime ? ` at ${task.dueTime}` : ' today'}.`
      })
      notification.on('click', showMainWindow)
      notification.show()
      firedReminderKeys.add(reminderKey(task))
      stateChanged = true
    }
  } catch (error) {
    console.error('Unable to send a task reminder', error)
  } finally {
    reminderSweepRunning = false
  }

  if (stateChanged) await persistFiredReminders()
}

function isPublicIpAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const octets = address.split('.').map(Number)
    const [first, second] = octets
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0) ||
      first >= 224
    )
  }

  if (version === 6) {
    const normalized = address.toLowerCase()
    const firstWord = Number.parseInt(normalized.split(':')[0] || '0', 16)
    return firstWord >= 0x2000 && firstWord <= 0x3fff && !normalized.startsWith('2001:db8:')
  }

  return false
}

async function validateCalendarUrl(value: string): Promise<URL> {
  if (value.length > 2048) throw new Error('The calendar link is too long.')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a valid calendar link.')
  }

  if (url.protocol === 'webcal:' || url.protocol === 'webcals:') {
    url.protocol = url.protocol === 'webcals:' ? 'https:' : 'http:'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Calendar links must use http, https, or webcal.')
  }
  if (url.username || url.password) {
    throw new Error('Calendar links cannot contain account credentials.')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'home.arpa'
  ) {
    throw new Error('This address is not a public calendar host.')
  }

  const version = isIP(hostname)
  const addresses = version
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('This address is not a public calendar host.')
  }

  url.hash = ''
  return url
}

async function readCalendarResponse(url: URL, signal: AbortSignal): Promise<Response> {
  let currentUrl = url
  for (let redirects = 0; ; redirects += 1) {
    const response = await net.fetch(currentUrl.toString(), {
      redirect: 'manual',
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
      signal
    })
    if (response.status < 300 || response.status >= 400) return response
    if (redirects >= maxCalendarRedirects) {
      throw new Error('The calendar link redirected too many times.')
    }

    const location = response.headers.get('location')
    if (!location) throw new Error('The calendar link redirected without a destination.')
    currentUrl = await validateCalendarUrl(new URL(location, currentUrl).toString())
  }
}

async function fetchCalendarText(value: string): Promise<string> {
  const url = await validateCalendarUrl(value.trim())
  const signal = AbortSignal.timeout(15000)
  const response = await readCalendarResponse(url, signal)
  if (!response.ok) {
    throw new Error(`The calendar server responded with ${response.status}.`)
  }

  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxCalendarBytes) {
    throw new Error('The calendar file is larger than 5 MB.')
  }
  if (!response.body) throw new Error('The calendar server returned an empty response.')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    totalBytes += chunk.byteLength
    if (totalBytes > maxCalendarBytes) {
      await reader.cancel()
      throw new Error('The calendar file is larger than 5 MB.')
    }
    chunks.push(chunk)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const calendarText = new TextDecoder().decode(bytes)
  if (!calendarText.includes('BEGIN:VCALENDAR')) {
    throw new Error('The link did not return an iCalendar feed.')
  }
  return calendarText
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  tray = new Tray(icon)
  tray.setToolTip('MyNotes')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open MyNotes', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Quit MyNotes',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', showMainWindow)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  await loadFiredReminders()

  // Set app user model id for Windows
  electronApp.setAppUserModelId('com.electron.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('calendar:fetch', async (event, calendarUrl: unknown) => {
    const senderUrl = event.senderFrame?.url
    if (!isAppFrame(senderUrl)) {
      throw new Error('Calendar links can only be loaded by the app window.')
    }
    if (typeof calendarUrl !== 'string') throw new Error('Enter a valid calendar link.')
    return fetchCalendarText(calendarUrl)
  })

  ipcMain.on('reminders:sync', (event, rawTasks: unknown) => {
    if (!isAppFrame(event.senderFrame?.url)) {
      console.error('Rejected task reminders from an untrusted frame.')
      return
    }
    try {
      scheduledTasks = parseReminderTasks(rawTasks)
      void checkTaskReminders()
    } catch (error) {
      console.error('Unable to update task reminders', error)
    }
  })

  createTray()
  createWindow()
  reminderTimer = setInterval(() => {
    void checkTaskReminders()
  }, 15_000)

  app.on('activate', function () {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  if (reminderTimer) clearInterval(reminderTimer)
  tray?.destroy()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
