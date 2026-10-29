import { BrowserWindow, ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { settings } from './partsImagesIpc'
import type { OpenResult } from './fileDialogs'
import { samePath, withoutRecent, withRecent } from './recentFiles'

/**
 * File ▸ Open Recent, the Electron half. The list lives in settings.json
 * (`recentFiles`); `list` is its in-memory copy, because `buildAppMenu` is
 * synchronous. The renderer reports each successful open and save
 * (`recent:add`) — only it knows a file parsed as a harness — and clicking an
 * entry sends `menu:openRecent` to it, which runs the same discard check as
 * File ▸ Open before asking main to read the file (`doc:openRecent`).
 */
let list: string[] = []
let rebuildMenu: () => void = () => {}
// Read-modify-write of settings.json, one at a time: two saves in quick
// succession must not drop each other's entry.
let queue: Promise<void> = Promise.resolve()

/** The recent files, most recent first, for the menu. */
export function recentFiles(): readonly string[] {
  return list
}

function update(change: (cur: string[]) => string[]): Promise<void> {
  queue = queue
    .then(async () => {
      const next = change((await settings.read()).recentFiles ?? [])
      list = (await settings.patch({ recentFiles: next.length ? next : undefined })).recentFiles ?? []
      rebuildMenu()
    })
    .catch(() => {})
  return queue
}

/** Menu click: hand the path to the focused window, which owns the document. */
export function openRecent(path: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:openRecent', path)
}

export function clearRecentFiles(): void {
  void update(() => [])
}

/**
 * Register the IPC and load the stored list, then rebuild the menu with it.
 * `doc:openRecent` reads only a path that IS on the list — it is not a general
 * file reader for the renderer. A file that is gone is dropped from the list.
 */
export async function registerRecentFiles(onChange: () => void): Promise<void> {
  rebuildMenu = onChange
  ipcMain.handle('recent:add', (_event, path: unknown) =>
    typeof path === 'string' && path ? update((cur) => withRecent(cur, path, process.platform)) : undefined
  )
  ipcMain.handle(
    'doc:openRecent',
    async (_event, path: string): Promise<OpenResult | { error: string }> => {
      if (!list.some((p) => samePath(p, path, process.platform)))
        return { error: `${path} is not in the recent files list.` }
      try {
        return { path, content: await readFile(path, 'utf-8') }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { error: (e as Error).message }
        await update((cur) => withoutRecent(cur, path, process.platform))
        return { error: `${path} no longer exists, so it was removed from the recent files.` }
      }
    }
  )
  list = (await settings.read()).recentFiles ?? []
  rebuildMenu()
}
