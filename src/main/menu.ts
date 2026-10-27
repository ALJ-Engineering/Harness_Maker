import { app, Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { chooseLibraryDir } from './partsLibraryIpc'

export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'undo'
  | 'redo'
  | 'exportDrawingSet'
  | 'exportBom'
  | 'openLibrary'
  | 'refreshPartRefs'

/** Send a menu action to the focused window's renderer, which runs the flow. */
function send(action: MenuAction): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:action', action)
}

/**
 * Build the application menu. File actions are dispatched to the renderer (it
 * owns document state) and use CmdOrCtrl accelerators so the same shortcuts
 * work on macOS, Windows, and Linux.
 */
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
      { type: 'separator' },
      {
        label: 'Export',
        submenu: [
          { label: 'Drawing set (PDF)…', click: () => send('exportDrawingSet') },
          { type: 'separator' },
          { label: 'BOM & Cut List (CSV)…', click: () => send('exportBom') }
        ]
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  }

  // Custom Edit menu: our document Undo/Redo (NOT role:'undo', which is the
  // native text-field undo) plus the standard clipboard roles for text inputs.
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
      { type: 'separator' },
      {
        label: 'Update part descriptions from library',
        click: () => send('refreshPartRefs')
      },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  }

  // App-level preferences that main owns outright (no renderer round-trip).
  const settingsMenu: MenuItemConstructorOptions = {
    label: 'Settings',
    submenu: [
      { label: 'Parts library…', accelerator: 'CmdOrCtrl+L', click: () => send('openLibrary') },
      {
        label: 'Parts library folder…',
        click: () => {
          void chooseLibraryDir(BrowserWindow.getFocusedWindow() ?? undefined)
        }
      }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    fileMenu,
    editMenu,
    settingsMenu,
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.name = 'Harness Editor'
}
