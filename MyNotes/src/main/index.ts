import { app, shell, BrowserWindow, ipcMain, net } from 'electron'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const maxCalendarBytes = 5 * 1024 * 1024
const maxCalendarRedirects = 5

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
  // Create the browser window.
  const mainWindow = new BrowserWindow({
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
    mainWindow.show()
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

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

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
    if (!senderUrl) throw new Error('Calendar links can only be loaded by the app window.')
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      const expectedOrigin = new URL(process.env['ELECTRON_RENDERER_URL']).origin
      if (new URL(senderUrl).origin !== expectedOrigin) {
        throw new Error('Calendar links can only be loaded by the app window.')
      }
    } else if (new URL(senderUrl).protocol !== 'file:') {
      throw new Error('Calendar links can only be loaded by the app window.')
    }
    if (typeof calendarUrl !== 'string') throw new Error('Enter a valid calendar link.')
    return fetchCalendarText(calendarUrl)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
