import { app, clipboard, Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { chooseLibraryDir } from './partsLibraryIpc'
import { claudeCodeCommand, claudeDesktopConfig, mcpStatus, mcpUrl, setMcpEnabled, type McpStatus } from './mcp'

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

/** One line of state for the Agent access submenu. */
function statusLine(st: McpStatus): string {
  if (st.state === 'listening') return `Listening on ${mcpUrl(st.port)}`
  if (st.state === 'failed') return `Not running: ${st.message}`
  return 'Off: no agent can reach the open document'
}

/**
 * Settings ▸ Agent access (MCP): let AI agents (Claude Code, Claude Desktop) read
 * and edit the open document through the in-app MCP server. Rebuilt whenever
 * the server's state changes (`registerMcp(buildAppMenu)`).
 */
function agentAccessMenu(st: McpStatus): MenuItemConstructorOptions {
  const port = st.state === 'off' ? null : st.port
  return {
    label: 'Agent access (MCP)',
    submenu: [
      {
        label: 'Let AI agents edit the open document',
        type: 'checkbox',
        checked: st.state !== 'off',
        click: (item) => void setMcpEnabled(item.checked)
      },
      { label: statusLine(st), enabled: false },
      { type: 'separator' },
      {
        label: 'Copy Claude Code command',
        enabled: st.state === 'listening',
        click: () => {
          if (port) clipboard.writeText(claudeCodeCommand(port))
        }
      },
      {
        label: 'Copy Claude Desktop config',
        enabled: st.state === 'listening',
        click: () => {
          if (port) clipboard.writeText(claudeDesktopConfig(port))
        }
      }
    ]
  }
}

/**
 * Build the application menu. File actions are dispatched to the renderer (it
 * owns document state) and use CmdOrCtrl accelerators so the same shortcuts
 * work on macOS, Windows, and Linux.
 */
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  // Top-level labels carry an `&` access key off macOS, so Alt+F etc. open the menus on
  // Windows and Linux. macOS menus have no access keys.
  const top = (label: string): string => (isMac ? label : `&${label}`)

  const fileMenu: MenuItemConstructorOptions = {
    label: top('File'),
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
    label: top('Edit'),
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
    label: top('Settings'),
    submenu: [
      { label: 'Parts library…', accelerator: 'CmdOrCtrl+L', click: () => send('openLibrary') },
      {
        label: 'Parts library folder…',
        click: () => {
          void chooseLibraryDir(BrowserWindow.getFocusedWindow() ?? undefined)
        }
      },
      { type: 'separator' },
      agentAccessMenu(mcpStatus())
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    fileMenu,
    editMenu,
    settingsMenu,
    { role: 'viewMenu', label: top('View') },
    { role: 'windowMenu', label: top('Window') }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.name = 'Harness Editor'
}
