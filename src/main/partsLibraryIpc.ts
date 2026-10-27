import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { settings } from './partsImagesIpc'
import {
  datasheetPath,
  deletePart,
  ensureLibraryDirs,
  importDatasheet,
  listParts,
  readPart,
  removeDatasheet,
  writePart
} from './partsLibrary'
import type { LibraryPart } from '../shared/parts/librarySchema'

/**
 * Electron wiring for the parts library: folder picker, the `library:*` IPC
 * surface, and the `library:changed` broadcast. Everything that can be tested
 * without Electron lives in `partsLibrary.ts`.
 */

export function broadcast(channel: 'settings:changed' | 'library:changed'): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel)
}

async function showOpen(
  win: BrowserWindow | undefined,
  opts: OpenDialogOptions
): Promise<string | null> {
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

/** Pick the library folder and create its subfolders. */
export async function chooseLibraryDir(win?: BrowserWindow): Promise<string | null> {
  const dir = await showOpen(win, {
    title: 'Parts library folder',
    properties: ['openDirectory', 'createDirectory']
  })
  if (!dir) return null
  await ensureLibraryDirs(dir)
  await settings.patch({ partsLibraryDir: dir })
  broadcast('settings:changed')
  broadcast('library:changed')
  return dir
}

const libDir = async (): Promise<string | undefined> => (await settings.read()).partsLibraryDir

export function registerPartsLibraryHandlers(): void {
  ipcMain.handle('library:getDir', async () => (await libDir()) ?? null)

  ipcMain.handle('library:chooseDir', (e) =>
    chooseLibraryDir(BrowserWindow.fromWebContents(e.sender) ?? undefined)
  )

  ipcMain.handle('library:list', async () => {
    const dir = await libDir()
    if (!dir) return { parts: [], datasheets: [], errors: [] }
    const l = await listParts(dir)
    return { parts: l.parts, datasheets: [...l.datasheets], errors: l.errors }
  })

  ipcMain.handle('library:writePart', async (_e, part: LibraryPart) => {
    const dir = await libDir()
    if (!dir) return { error: 'no library folder set' }
    try {
      await writePart(dir, part)
      broadcast('library:changed')
      return { ok: true }
    } catch (e) {
      return { error: (e as Error).message || 'write failed' }
    }
  })

  ipcMain.handle('library:deletePart', async (_e, partNumber: string, withFiles: boolean) => {
    const dir = await libDir()
    if (!dir || typeof partNumber !== 'string') return false
    const ok = await deletePart(dir, partNumber, withFiles === true)
    if (ok) broadcast('library:changed')
    return ok
  })

  ipcMain.handle(
    'library:importDatasheet',
    async (e, args: { partNumber: string; srcPath?: string }) => {
      const dir = await libDir()
      if (!dir || typeof args?.partNumber !== 'string') return null
      if (args.srcPath !== undefined && typeof args.srcPath !== 'string') return null
      let src = args.srcPath
      if (!src) {
        src =
          (await showOpen(BrowserWindow.fromWebContents(e.sender) ?? undefined, {
            title: `Datasheet for ${args.partNumber}`,
            properties: ['openFile'],
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          })) ?? undefined
        if (!src) return null
      }
      try {
        await importDatasheet(dir, args.partNumber, src)
        broadcast('library:changed')
        return { ok: true }
      } catch (err) {
        return { error: (err as Error).message || 'import failed' }
      }
    }
  )

  ipcMain.handle('library:openDatasheet', async (_e, partNumber: string) => {
    const dir = await libDir()
    if (!dir || typeof partNumber !== 'string') return { error: 'no library folder set' }
    const p = await datasheetPath(dir, partNumber)
    if (p) {
      const err = await shell.openPath(p)
      return err ? { error: err } : { ok: true }
    }
    const url = (await readPart(dir, partNumber))?.datasheetUrl
    if (url && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
      return { ok: true }
    }
    return { error: 'no datasheet for this part' }
  })

  ipcMain.handle('library:removeDatasheet', async (_e, partNumber: string) => {
    const dir = await libDir()
    if (!dir || typeof partNumber !== 'string') return false
    const ok = await removeDatasheet(dir, partNumber)
    if (ok) broadcast('library:changed')
    return ok
  })
}
