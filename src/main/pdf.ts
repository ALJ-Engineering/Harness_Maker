import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { htmlFileNameFor, validateExportPdfArgs, type ExportPdfArgs, type PdfPart } from './pdfArgs'
import { mergePdfs } from './pdfMerge'

export type { ExportPdfArgs, PdfPart }

const MM_PER_INCH = 25.4

/**
 * Render ONE part (already paginated into exact-sheet `.page` divs) to a PDF
 * buffer. `printToPDF` takes a single page size, so one part = one paper size.
 *
 * Two non-obvious choices, both measured on Electron 42 / Chromium 148:
 *
 * - **Always load from a temp file, never a `data:` URL.** Chromium caps URLs at
 *   ~2 MB, so a large drawing set fails the navigation outright with
 *   `ERR_INVALID_URL (-300)` (a 1.49 MB HTML encodes to 2.18 MB and does fail);
 *   and even when it fits, the whole data URL is embedded as the PDF's `/Title`.
 * - **`close()`, not `destroy()`.** Destroying the window immediately after
 *   `printToPDF` resolves leaves Chromium's print path wedged: every *later*
 *   load in the same process fails with `ERR_FAILED (-2)` and the process then
 *   dies on a SIGTRAP. `close()` unloads cleanly and repeated exports work.
 */
export async function renderPartToPdf(
  part: PdfPart,
  defaultPath: string | undefined
): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
  })
  let tmp: string | null = null
  try {
    tmp = await mkdtemp(join(tmpdir(), 'harness-pdf-'))
    const file = join(tmp, htmlFileNameFor(defaultPath))
    await writeFile(file, part.html, 'utf-8')
    await win.loadFile(file)
    return await win.webContents.printToPDF({
      pageSize: { width: part.widthMm / MM_PER_INCH, height: part.heightMm / MM_PER_INCH },
      margins: { marginType: 'none' },
      printBackground: true,
      preferCSSPageSize: true
    })
  } finally {
    // The temp dir must go even if closing the window throws, so it gets its
    // own `finally` rather than trailing the close.
    try {
      if (!win.isDestroyed()) win.close()
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true })
    }
  }
}

/**
 * Render every part and return the one PDF the user asked for.
 *
 * The parts are rendered SEQUENTIALLY on purpose: each one opens a hidden
 * `BrowserWindow` and runs Chromium's print path, and that path is the fragile
 * thing documented on `renderPartToPdf` — one window at a time, closed before
 * the next opens, is the arrangement that has been measured to work. A single
 * part is returned as-is; merging a lone PDF would only re-write it through
 * `pdf-lib` for no gain.
 */
export async function renderExportToPdf(args: ExportPdfArgs): Promise<Uint8Array> {
  const buffers: Uint8Array[] = []
  for (const part of args.parts) buffers.push(await renderPartToPdf(part, args.defaultPath))
  return args.parts.length === 1 ? buffers[0] : mergePdfs(buffers)
}

/** Register the PDF export IPC handler: validate + save dialog + render + write. */
export function registerPdfHandlers(): void {
  ipcMain.handle('doc:exportPdf', async (event, raw: unknown): Promise<string | null> => {
    // Validate before anything user-visible happens: a malformed payload must
    // not get as far as a save dialog, let alone into `printToPDF`.
    const args = validateExportPdfArgs(raw)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: args.title ?? 'Export PDF',
      defaultPath: args.defaultPath ?? 'harness.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    const { canceled, filePath } = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    // `writeFile` takes the Uint8Array as it is — no Buffer copy of a
    // multi-megabyte PDF just to change the wrapper type.
    await writeFile(filePath, await renderExportToPdf({ ...args, defaultPath: filePath }))
    return filePath
  })
}
