import { dialog, ipcMain, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join, basename, extname } from 'path'

const FILTERS = [
  { name: 'Harness Document', extensions: ['harness.json', 'json'] },
  { name: 'All Files', extensions: ['*'] }
]

/** One file to write in an export, named by appending `suffix` to a base path. */
interface ExportFile {
  suffix: string
  content: string
}

export interface OpenResult {
  path: string
  content: string
}

/**
 * Register the open/save IPC handlers. The renderer never touches the
 * filesystem directly — it asks main, which owns the native dialogs and fs.
 */
export function registerFileHandlers(): void {
  // Show open dialog, read the chosen file. Returns null if cancelled.
  ipcMain.handle('doc:open', async (event): Promise<OpenResult | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: 'Open harness',
      filters: FILTERS,
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return null
    const path = filePaths[0]
    const content = await readFile(path, 'utf-8')
    return { path, content }
  })

  // Write content to a known path. Returns the path written.
  ipcMain.handle('doc:save', async (_event, args: { path: string; content: string }) => {
    await writeFile(args.path, args.content, 'utf-8')
    return args.path
  })

  // Show save dialog, write content. Returns the path, or null if cancelled.
  ipcMain.handle(
    'doc:saveAs',
    async (event, args: { content: string; defaultPath?: string }): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Save harness as',
        defaultPath: args.defaultPath ?? 'untitled.harness.json',
        filters: FILTERS
      })
      if (canceled || !filePath) return null
      await writeFile(filePath, args.content, 'utf-8')
      return filePath
    }
  )

  // Export one or more derived files (SVG, CSVs, HTML) from a single save dialog.
  // The chosen path gives a base name (its extension stripped); each file is
  // written as base+suffix. Returns the written paths, or null if cancelled.
  ipcMain.handle(
    'doc:exportFiles',
    async (
      event,
      args: { files: ExportFile[]; defaultPath?: string; title?: string }
    ): Promise<string[] | null> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: args.title ?? 'Export',
        defaultPath: args.defaultPath ?? 'harness',
        filters: [{ name: 'All Files', extensions: ['*'] }]
      })
      if (canceled || !filePath) return null
      const dir = dirname(filePath)
      const base = basename(filePath, extname(filePath))
      const written: string[] = []
      for (const f of args.files) {
        const p = join(dir, base + f.suffix)
        await writeFile(p, f.content, 'utf-8')
        written.push(p)
      }
      return written
    }
  )
}
