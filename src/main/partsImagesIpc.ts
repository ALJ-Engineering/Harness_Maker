import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  type OpenDialogOptions
} from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { imageDirOf, SettingsFile, themeOf } from './settings'
import {
  PARTS_IMAGE_SCHEME,
  imageHref,
  imageDataUrl,
  importImage,
  listImages,
  removeImage,
  resolveForPart,
  sanitisePartNumber
} from './partsImages'
import { logoDataUrl } from './branding'

/**
 * Electron wiring for the parts-image library: settings persistence, the
 * `parts:*` IPC surface, and the `parts-image://` protocol. Everything that can
 * be tested without Electron lives in `settings.ts` / `partsImages.ts`.
 */
export const settings = new SettingsFile(join(app.getPath('userData'), 'settings.json'))

/**
 * Must run BEFORE `app.whenReady()` — Chromium fixes its scheme registry at
 * startup, so a privileged scheme registered later is simply ignored.
 * `standard` + `secure` is what lets the main window (contextIsolation on) load
 * these URLs from `<img>` / `<image href>`.
 */
export function registerPartsImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PARTS_IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false }
    }
  ])
}

/**
 * `parts-image://img/<stem>?v=<mtime>` — the href the RENDERER paints from.
 *
 * Re-importing a photo for a part reuses the same stem, so without the `?v=`
 * Chromium repaints the cached bitmap: measured on a re-import, the picture
 * block resized to the new photo's aspect (the plan reads fresh `pxW`/`pxH`)
 * while the pixels stayed the old image — and the exported PDF, which inlines
 * bytes read from disk, disagreed with the canvas.
 *
 * The query is display-only: `protocol.handle` resolves the part from
 * `new URL(req.url).pathname`, which excludes `search`, so a stale or absent
 * `?v=` still serves the right file. `imageHref` itself is left alone — the
 * print path builds `data:` URIs and has no cache to bust.
 */
function versionedHref(stem: string, mtimeMs: number): string {
  return `${imageHref(stem)}?v=${Math.round(mtimeMs)}`
}

/**
 * Register after `app.whenReady()`. The protocol handler serves only files that
 * resolve INSIDE the configured folder (`resolveForPart` does the guarding),
 * and `net.fetch` on a file URL supplies the Content-Type.
 */
export function registerPartsImageHandlers(): void {
  const notFound = (): Response => new Response('', { status: 404 })

  protocol.handle(PARTS_IMAGE_SCHEME, async (req) => {
    const partsImageDir = imageDirOf(await settings.read())
    // A malformed escape (`parts-image://img/%`) makes decodeURIComponent throw;
    // an unhandled rejection here would fail the request with no status at all.
    let pn: string
    try {
      pn = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
    } catch {
      return notFound()
    }
    if (!partsImageDir || !pn) return notFound()
    const p = await resolveForPart(partsImageDir, pn)
    return p ? net.fetch(pathToFileURL(p).toString()) : notFound()
  })

  ipcMain.handle('parts:getImageDir', async () => imageDirOf(await settings.read()) ?? null)

  ipcMain.handle('settings:getTheme', async () => themeOf(await settings.read()))
  ipcMain.handle('settings:setTheme', async (_e, theme: 'dark' | 'light') => {
    await settings.patch({ theme: theme === 'light' ? 'light' : 'dark' })
  })

  // Keyed by library STEM (= sanitisePartNumber(partNumber)) — the renderer
  // looks a part up as images[sanitisePartNumber(pn)].
  ipcMain.handle('parts:listImages', async () => {
    const partsImageDir = imageDirOf(await settings.read())
    if (!partsImageDir) return {}
    const lib = await listImages(partsImageDir)
    return Object.fromEntries(
      Object.entries(lib).map(([stem, v]) => [
        stem,
        { href: versionedHref(stem, v.mtimeMs), pxW: v.pxW, pxH: v.pxH }
      ])
    )
  })

  ipcMain.handle(
    'parts:importImage',
    async (e, args: { partNumber: string; srcPath?: string }) => {
      const partsImageDir = imageDirOf(await settings.read())
      if (!partsImageDir || typeof args?.partNumber !== 'string') return null
      // `srcPath` is renderer-supplied (a dropped file's path): accept only a
      // string or nothing. `importImage` then stats it before reading it.
      if (args.srcPath !== undefined && typeof args.srcPath !== 'string') return null
      let src = args.srcPath
      if (!src) {
        const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
        const opts: OpenDialogOptions = {
          title: `Picture for ${args.partNumber}`,
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
        }
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (r.canceled || !r.filePaths[0]) return null
        src = r.filePaths[0]
      }
      // `importImage` REJECTS a bad drop (not a regular file, over the size
      // cap, not PNG/JPEG). Left uncaught that became an unhandled rejection in
      // the renderer's `void parts.importFor(...)` and the picture just never
      // appeared, with nothing said. Hand the message back instead — the
      // renderer alerts with it. `null` still means "cancelled / no library".
      try {
        const v = await importImage(partsImageDir, args.partNumber, src)
        return {
          href: versionedHref(sanitisePartNumber(args.partNumber), v.mtimeMs),
          pxW: v.pxW,
          pxH: v.pxH
        }
      } catch (e) {
        return { error: (e as Error).message || 'Import failed' }
      }
    }
  )

  ipcMain.handle('parts:removeImage', async (_e, partNumber: string) => {
    const partsImageDir = imageDirOf(await settings.read())
    return partsImageDir && typeof partNumber === 'string'
      ? removeImage(partsImageDir, partNumber)
      : false
  })

  ipcMain.handle('library:logoDataUrl', async () => {
    const lib = (await settings.read()).partsLibraryDir
    return lib ? logoDataUrl(lib) : null
  })

  ipcMain.handle('parts:imageDataUrl', async (_e, partNumber: string) => {
    const partsImageDir = imageDirOf(await settings.read())
    return partsImageDir && typeof partNumber === 'string'
      ? imageDataUrl(partsImageDir, partNumber)
      : null
  })
}
