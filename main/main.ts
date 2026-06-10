import path from 'path'
import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import serve from 'electron-serve'
import Store from 'electron-store'
import { createWindow } from './helpers/create-window'

const isProd = process.env.NODE_ENV === 'production'
const store = new Store<{ config: unknown }>({ name: 'pps-station-config' })

if (isProd) {
  serve({ directory: 'app' })
} else {
  app.setPath('userData', `${app.getPath('userData')} (development)`)
}

let devPort = '8888'

function loadRoute(win: BrowserWindow, route: string) {
  if (isProd) {
    return win.loadURL(`app://./${route}`)
  }
  return win.loadURL(`http://localhost:${devPort}/${route}`)
}

;(async () => {
  await app.whenReady()
  devPort = process.argv[2] || devPort

  const win = createWindow('dashboard', {
    width: 1360,
    height: 900,
    title: 'DuckSoup — Experimenter Dashboard',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
    },
  })
  await loadRoute(win, 'dashboard')
  if (!isProd) win.webContents.openDevTools({ mode: 'detach' })
})()

app.on('window-all-closed', () => {
  app.quit()
})

// ---- Persisted config ----

ipcMain.handle('config:get', () => store.get('config', null))
ipcMain.handle('config:set', (_e, config) => {
  store.set('config', config)
  return true
})

// ---- Folder selection & structured session output ----

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select session output root (e.g. the Research Drive study folder)',
  })
  return result.canceled ? null : result.filePaths[0]
})

function sanitize(part: string): string {
  return String(part).replace(/[^A-Za-z0-9_-]/g, '_')
}

ipcMain.handle(
  'session:create-dir',
  async (_e, { saveRoot, studyId, dyadId, participantId }) => {
    const fs = await import('fs/promises')
    if (!saveRoot) throw new Error('No save root selected')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(
      saveRoot,
      `study_${sanitize(studyId)}`,
      `dyad_${sanitize(dyadId)}`,
      `p_${sanitize(participantId)}_${stamp}`,
    )
    await fs.mkdir(dir, { recursive: true })
    return dir
  },
)

ipcMain.handle(
  'session:save-recording',
  async (
    _e,
    { dir, filename, buffer }: { dir: string; filename: string; buffer: ArrayBuffer },
  ) => {
    const fs = await import('fs/promises')
    const filePath = path.join(dir, filename)
    await fs.writeFile(filePath, Buffer.from(buffer))
    return filePath
  },
)

ipcMain.handle('session:write-manifest', async (_e, { dir, manifest }) => {
  const fs = await import('fs/promises')
  const filePath = path.join(dir, 'session.json')
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8')
  return filePath
})

ipcMain.handle('shell:open-path', async (_e, p: string) => {
  await shell.openPath(p)
  return true
})
