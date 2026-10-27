import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { registerFileHandlers } from './fileDialogs'
import { registerPdfHandlers } from './pdf'
import { buildAppMenu } from './menu'
import { registerPartsImageHandlers, registerPartsImageScheme } from './partsImagesIpc'
import { registerPartsLibraryHandlers } from './partsLibraryIpc'

// Last-known dirty flag per window, pushed from the renderer via `doc:dirty`.
// Read synchronously in the `close` handler to guard against silent data loss.
const dirtyByWindow = new WeakMap<BrowserWindow, boolean>()
ipcMain.on('doc:dirty', (event, dirty: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) dirtyByWindow.set(win, !!dirty)
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'Harness Editor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Guard the most common exit path (window close / Cmd-W / Cmd-Q): if the
  // renderer reported unsaved changes, confirm before discarding them. Mirrors
  // the renderer's open/new "Discard unsaved changes?" prompt.
  win.on('close', (e) => {
    if (!dirtyByWindow.get(win)) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', "Don't Save"],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Close without saving? This cannot be undone.'
    })
    if (choice === 0) e.preventDefault() // Cancel → keep the window open
    else dirtyByWindow.delete(win) // Don't Save → allow the close to proceed
  })

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // In dev, electron-vite serves the renderer over HTTP; in prod, load the file.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Privileged schemes must be declared before the app is ready — see
// `registerPartsImageScheme`.
registerPartsImageScheme()

app.whenReady().then(() => {
  // Windows groups taskbar buttons and pins by AppUserModelID. The installer stamps its
  // shortcuts with electron-builder's `appId`, so the running app must claim the same one or a
  // pinned shortcut and the open window show up as two separate taskbar icons.
  if (process.platform === 'win32') app.setAppUserModelId('com.aljengineering.harness-editor')
  registerFileHandlers()
  registerPdfHandlers()
  registerPartsImageHandlers()
  registerPartsLibraryHandlers()
  buildAppMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// On macOS apps stay active until Cmd+Q; elsewhere quit when all windows close.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
