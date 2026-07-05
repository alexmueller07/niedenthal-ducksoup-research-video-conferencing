// Electron main process for the lab video call.
//
// One binary, two personas decided at sign-in:
//   participant → the window becomes a locked kiosk (fullscreen, frameless,
//                 unclosable, key combos swallowed). The only way out is
//                 Ctrl+Shift+Q → type "Confirm".
//   researcher  → a normal window, plus this process starts the SessionServer
//                 (WebSocket room + CSV logging) and accepts streamed
//                 recording chunks from the dashboard.

import path from 'path'
import fs from 'fs'
import os from 'os'
import {
  app,
  ipcMain,
  dialog,
  shell,
  globalShortcut,
  powerSaveBlocker,
  session,
  systemPreferences,
  BrowserWindow,
} from 'electron'
import serve from 'electron-serve'
import Store from 'electron-store'
import { createWindow } from './helpers/create-window'
import { SessionServer, lanIps } from './server'
import { SessionLogger } from './logger'
import { DEFAULT_PORT } from './protocol'

const isProd = process.env.NODE_ENV === 'production'
const store = new Store<Record<string, unknown>>({ name: 'lab-video-call' })

// Participants must hear the researcher without ever clicking the page first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

if (isProd) {
  serve({ directory: 'app' })
} else {
  app.setPath('userData', `${app.getPath('userData')} (development)`)
}

let devPort = '8888'
let mainWin: BrowserWindow | null = null
let lockedDown = false
let allowQuit = false
let powerBlockerId: number | null = null
let server: SessionServer | null = null

function loadRoute(win: BrowserWindow, route: string) {
  if (isProd) return win.loadURL(`app://./${route}`)
  return win.loadURL(`http://localhost:${devPort}/${route}`)
}

;(async () => {
  await app.whenReady()
  devPort = process.argv[2] || devPort

  // ---- Camera/mic permissions (fixes the macOS "allow access" prompt spam) ----
  //
  // Two layers were prompting independently:
  //  1. macOS TCC: ask once, up front, via the system API instead of letting
  //     each getUserMedia call race its own prompt.
  //  2. Chromium's own permission check: grant media requests outright — this
  //     is a kiosk lab app, the OS-level permission is the real gate.
  // Note for Ben: on an UNSIGNED (ad-hoc) build, macOS forgets the grant when a
  // differently-signed build replaces the app, so a fresh install may ask once
  // more. That's a code-signing limitation, not an app bug.
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone')
      await systemPreferences.askForMediaAccess('camera')
    } catch {
      /* user denied — getUserMedia will surface the error in-app */
    }
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'fullscreen', 'display-capture'].includes(permission))
  })

  const win = createWindow('lab-call', {
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    title: 'Video Call',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  })
  mainWin = win
  win.setMenuBarVisibility(false)

  win.on('close', (e) => {
    if (allowQuit) return
    if (lockedDown) {
      // Participants cannot close the window. Ctrl+Shift+Q is the only exit.
      e.preventDefault()
      return
    }
    // Researcher closing mid-session gets one confirmation.
    if (server && server.currentPhase === 'live') {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Stay in session', 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Session is live',
        message:
          'The conversation is still running. Closing this window shuts down the session server for everyone.',
      })
      if (choice === 0) e.preventDefault()
    }
  })

  await loadRoute(win, '')
  if (!isProd) win.webContents.openDevTools({ mode: 'detach' })
})()

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  globalShortcuts.unregister()
})

app.on('before-quit', () => {
  allowQuit = true
  void shutdownServer()
  closeAllRecordings()
})

async function shutdownServer() {
  const s = server
  server = null
  if (s) {
    try {
      await s.stop()
    } catch {
      /* already down */
    }
  }
}

// ---- Kiosk lockdown (participant) ----

const globalShortcuts = {
  register() {
    globalShortcut.register('Control+Shift+Q', () => {
      mainWin?.webContents.send('escape:open')
    })
  },
  unregister() {
    globalShortcut.unregisterAll()
  },
}

const BLOCKED_KEYS = new Set(['F5', 'F11', 'F12'])

function lockdown(win: BrowserWindow) {
  if (lockedDown) return
  lockedDown = true
  win.setMinimumSize(800, 600)
  win.setKiosk(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setClosable(false)
  globalShortcuts.register()
  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const ctrlish = input.control || input.meta
    if (BLOCKED_KEYS.has(input.key)) event.preventDefault()
    // Reload, close-tab, new-window, devtools, zoom — all swallowed.
    if (ctrlish && ['r', 'R', 'w', 'W', 'n', 'N', '+', '-', '0'].includes(input.key)) {
      event.preventDefault()
    }
    if (ctrlish && input.shift && ['i', 'I', 'j', 'J', 'c', 'C'].includes(input.key)) {
      if (isProd) event.preventDefault()
    }
  })
}

ipcMain.handle('role:participant', () => {
  if (mainWin) lockdown(mainWin)
  return true
})

ipcMain.handle('role:admin', () => {
  mainWin?.maximize()
  return true
})

ipcMain.handle('app:request-quit', () => {
  allowQuit = true
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId)
  }
  // setClosable(false) would make close() a no-op on Windows.
  mainWin?.setClosable(true)
  app.quit()
  return true
})

// ---- Preferences (server URL, output root, last study IDs…) ----

ipcMain.handle('prefs:get', (_e, key: string) => store.get(`prefs.${key}`, null))
ipcMain.handle('prefs:set', (_e, key: string, value: unknown) => {
  store.set(`prefs.${key}`, value)
  return true
})

// ---- Session server (researcher machine only) ----

function defaultOutputRoot(): string {
  return path.join(app.getPath('documents'), 'NiedenthalLab', 'video-call-sessions')
}

ipcMain.handle(
  'server:start',
  async (_e, opts: { outputRoot?: string | null; port?: number } = {}) => {
    if (server) return server.status()
    const root = opts.outputRoot || (store.get('prefs.outputRoot', null) as string | null) || defaultOutputRoot()
    const logger = await SessionLogger.create(root)
    const s = new SessionServer(opts.port ?? DEFAULT_PORT, logger)
    await s.start()
    server = s
    store.set('prefs.outputRoot', root)
    return s.status()
  },
)

ipcMain.handle('server:status', () => (server ? server.status() : null))

ipcMain.handle('server:write-manifest', async (_e, manifest: unknown) => {
  if (!server) return null
  return server.logger.writeManifest(manifest)
})

ipcMain.handle('server:stop', async () => {
  await shutdownServer()
  return true
})

ipcMain.handle('net:lan-ips', () => lanIps())
ipcMain.handle('net:hostname', () => os.hostname())

// ---- Streamed session recordings (researcher machine) ----
//
// The dashboard's MediaRecorders push 1 s chunks here; each goes straight to
// disk so a crash never loses more than the last second.

interface RecSink {
  stream: fs.WriteStream
  path: string
  bytes: number
}
const recordings = new Map<string, RecSink>()
let nextRecId = 1

ipcMain.handle('rec:open', (_e, label: string, ext?: string) => {
  if (!server) throw new Error('Session server is not running')
  const filePath = server.logger.recordingPath(label, ext ?? 'webm')
  const id = `rec${nextRecId++}`
  recordings.set(id, { stream: fs.createWriteStream(filePath), path: filePath, bytes: 0 })
  server.logger.event({ event: 'recording_started', target: label, detail: { path: filePath } })
  return { id, path: filePath }
})

ipcMain.handle('rec:append', (_e, id: string, chunk: ArrayBuffer) => {
  const sink = recordings.get(id)
  if (!sink) return 0
  const buf = Buffer.from(chunk)
  sink.stream.write(buf)
  sink.bytes += buf.length
  return sink.bytes
})

ipcMain.handle('rec:close', async (_e, id: string) => {
  const sink = recordings.get(id)
  if (!sink) return null
  recordings.delete(id)
  await new Promise<void>((r) => sink.stream.end(() => r()))
  server?.logger.event({
    event: 'recording_stopped',
    target: path.basename(sink.path),
    value: sink.bytes,
    detail: { path: sink.path, bytes: sink.bytes },
  })
  return { path: sink.path, bytes: sink.bytes }
})

function closeAllRecordings() {
  for (const sink of recordings.values()) sink.stream.end()
  recordings.clear()
}

// ---- Folder selection & shell ----

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select session output root (e.g. the Research Drive study folder)',
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('shell:open-path', async (_e, p: string) => {
  await shell.openPath(p)
  return true
})

// ---- Legacy capture-station handlers (the /dashboard page, kept intact) ----

ipcMain.handle('config:get', () => store.get('config', null))
ipcMain.handle('config:set', (_e, config) => {
  store.set('config', config)
  return true
})

function sanitize(part: string): string {
  return String(part).replace(/[^A-Za-z0-9_-]/g, '_')
}

ipcMain.handle(
  'session:create-dir',
  async (_e, { saveRoot, studyId, dyadId, participantId }) => {
    const fsp = await import('fs/promises')
    if (!saveRoot) throw new Error('No save root selected')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(
      saveRoot,
      `study_${sanitize(studyId)}`,
      `dyad_${sanitize(dyadId)}`,
      `p_${sanitize(participantId)}_${stamp}`,
    )
    await fsp.mkdir(dir, { recursive: true })
    return dir
  },
)

ipcMain.handle(
  'session:save-recording',
  async (
    _e,
    { dir, filename, buffer }: { dir: string; filename: string; buffer: ArrayBuffer },
  ) => {
    const fsp = await import('fs/promises')
    const filePath = path.join(dir, filename)
    await fsp.writeFile(filePath, Buffer.from(buffer))
    return filePath
  },
)

ipcMain.handle('session:write-manifest', async (_e, { dir, manifest }) => {
  const fsp = await import('fs/promises')
  const filePath = path.join(dir, 'session.json')
  await fsp.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8')
  return filePath
})
