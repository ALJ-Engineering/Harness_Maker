import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'path'
import type { McpReply, ToolOutcome } from '../../shared/mcp'
import { settings } from '../partsImagesIpc'
import { broadcast } from '../partsLibraryIpc'
import { mcpPortOf } from '../settings'
import { createBridge } from './bridge'
import { startMcpServer, type RunningMcpServer } from './server'
import { INSTRUCTIONS, TOOLS, runLibraryTool } from './tools'

/**
 * Electron wiring for the in-app MCP server ("Agent access"): turns it on and
 * off from settings, routes each tool call — library tools run here, document
 * tools go to the document window over the bridge — and keeps the bridge in
 * step with that window's lifecycle. The parts that can be tested without
 * Electron are `bridge.ts`, `server.ts` and `tools.ts`.
 */

export type McpStatus =
  | { state: 'off' }
  | { state: 'listening'; port: number }
  | { state: 'failed'; port: number; message: string }

let docWindow: BrowserWindow | null = null
let running: RunningMcpServer | null = null
let status: McpStatus = { state: 'off' }
let changed: () => void = () => {}

const bridge = createBridge((call) => {
  if (!docWindow || docWindow.isDestroyed()) return false
  docWindow.webContents.send('mcp:call', call)
  return true
})

async function call(name: string, args: unknown): Promise<ToolOutcome> {
  const def = TOOLS.find((t) => t.name === name)
  if (!def) return { ok: false, errors: [`unknown tool '${name}'`] }
  if (def.runsIn === 'renderer') return bridge.call(name, args)
  const outcome = await runLibraryTool(name, args, (await settings.read()).partsLibraryDir)
  // The library dialog and the DRC catalog re-list on this, as after an edit in the dialog.
  if (name === 'library_put' && outcome.ok) broadcast('library:changed')
  return outcome
}

/** The IPC half of the bridge. `onStatus` runs whenever the server starts, stops or fails (the menu shows it). */
export function registerMcp(onStatus: () => void): void {
  changed = onStatus
  // Only the document window may answer: a PDF export window shares the preload.
  ipcMain.on('mcp:result', (e, reply: McpReply) => {
    if (e.sender === docWindow?.webContents) bridge.settle(reply.id, reply.outcome)
  })
  ipcMain.on('mcp:ready', (e, ready: boolean) => {
    if (e.sender === docWindow?.webContents) bridge.setReady(!!ready)
  })
}

/**
 * The window whose renderer holds the document — where document tools go. Set
 * explicitly because the menu's `getFocusedWindow()` is null exactly when an
 * agent is working (another app has focus).
 */
export function attachDocumentWindow(win: BrowserWindow): void {
  docWindow = win
  const lost = (reason: string): void => {
    bridge.setReady(false)
    bridge.rejectAll(reason)
  }
  win.webContents.on('did-start-loading', () => lost('the editor window reloaded'))
  win.webContents.on('render-process-gone', () => lost('the editor window crashed'))
  win.on('closed', () => {
    if (docWindow !== win) return
    docWindow = null
    lost('the editor window was closed')
  })
}

let queue: Promise<void> = Promise.resolve()

/** Start, stop or move the server to match settings. Serialised: menu clicks may come faster than a listen. */
export function applyMcpSettings(): Promise<void> {
  queue = queue.then(apply, apply)
  return queue
}

async function apply(): Promise<void> {
  const s = await settings.read()
  const want = s.mcpEnabled ? mcpPortOf(s) : null
  if (running && running.port !== want) {
    await running.close()
    running = null
  }
  if (want === null) status = { state: 'off' }
  else if (!running) {
    try {
      running = await startMcpServer({ port: want, tools: TOOLS, instructions: INSTRUCTIONS, version: app.getVersion(), call })
      status = { state: 'listening', port: want }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      const message = err.code === 'EADDRINUSE' ? `port ${want} is in use (another Harness Editor?)` : err.message
      status = { state: 'failed', port: want, message }
    }
  }
  changed()
}

export async function setMcpEnabled(on: boolean): Promise<void> {
  await settings.patch({ mcpEnabled: on })
  await applyMcpSettings()
}

export function mcpStatus(): McpStatus {
  return status
}

export async function stopMcp(): Promise<void> {
  await running?.close()
  running = null
}

export const mcpUrl = (port: number): string => `http://127.0.0.1:${port}/mcp`

/** What to paste into a terminal to give Claude Code this server. */
export function claudeCodeCommand(port: number): string {
  return `claude mcp add --transport http harness ${mcpUrl(port)}`
}

/**
 * A `claude_desktop_config.json` fragment: Claude Desktop starts local servers
 * over stdio, so it runs the CLI's `harness mcp` bridge. An installed app runs
 * it with its own executable as Node (no Node install needed); the bundle is
 * unpacked from the asar for that (`asarUnpack` in electron-builder.yml).
 */
export function claudeDesktopConfig(port: number): string {
  const args = ['mcp', '--port', String(port)]
  const server = app.isPackaged
    ? {
        command: process.execPath,
        args: [join(process.resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'harness.mjs'), ...args],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    : { command: 'node', args: [join(app.getAppPath(), 'out', 'cli', 'harness.mjs'), ...args] }
  return JSON.stringify({ mcpServers: { harness: server } }, null, 2)
}
