import { readdir, readFile, copyFile, open, realpath, rm, stat } from 'fs/promises'
import { basename, extname, join, resolve, sep } from 'path'
import { imageSize } from './imageSize'
import { sanitisePartNumber } from '../shared/parts/images'

/**
 * The parts-image library: a flat folder of `<stem>.<png|jpg|jpeg>` files, one
 * per part number. Electron-free so vitest can exercise it — the dialogs, IPC
 * and `parts-image://` protocol live in `partsImagesIpc.ts`.
 *
 * Every read goes through `resolveImageFile`, so no caller can be talked into
 * serving a file outside the configured folder.
 */
export { sanitisePartNumber, imageHref, PARTS_IMAGE_SCHEME } from '../shared/parts/images'

/** The only extensions the library uses — probe order for a lookup, filter for a listing. */
const IMAGE_EXTS: readonly string[] = ['.png', '.jpg', '.jpeg']
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg' }
/** The largest picture the library takes (the Library dialog, `library put --picture`, MCP). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
/**
 * How much of a file `listImages` reads to size it. `imageSize` needs 24 bytes
 * for a PNG and, for a JPEG, everything up to the first SOF marker — which sits
 * behind whatever EXIF/ICC/thumbnail segments the camera wrote. 128 KiB clears
 * a full 64 KiB APP1 plus an ICC profile with room to spare, while a folder of
 * 200 five-megapixel photos costs a few MB to list instead of a gigabyte.
 */
const HEADER_BYTES = 128 * 1024

export interface LibraryImage {
  file: string
  pxW: number
  pxH: number
  /**
   * File mtime, epoch ms. Carried so the IPC layer can hang a `?v=` on the
   * `parts-image://` href: re-importing a photo reuses the SAME url, and
   * Chromium would otherwise keep painting the cached bitmap while the plan
   * (and the exported PDF, which reads bytes fresh) uses the new one.
   */
  mtimeMs: number
}

/**
 * Absolute path of `fileName` inside `dir`, or null if it is not a regular file
 * INSIDE dir. `realpath` on both sides is what makes a symlink pointing out of
 * the library fail too — a prefix check on the unresolved path would not.
 */
export async function resolveImageFile(dir: string, fileName: string): Promise<string | null> {
  if (!fileName || fileName !== basename(fileName)) return null
  const root = await realpath(resolve(dir)).catch(() => null)
  if (!root) return null
  const p = await realpath(join(root, fileName)).catch(() => null)
  if (!p || !p.startsWith(root + sep)) return null
  const s = await stat(p).catch(() => null)
  return s?.isFile() ? p : null
}

/**
 * The first `bytes` of `path` (fewer if the file is shorter). Empty on any
 * open/read failure — every caller treats "no header" as "not an image".
 *
 * Exists so header sniffing does not pull whole photos into memory: the
 * listing needs 24 bytes of a PNG, and a folder of DSLR JPEGs is easily a
 * gigabyte of `readFile` for that.
 */
export async function readHeader(path: string, bytes = HEADER_BYTES): Promise<Buffer> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return Buffer.alloc(0)
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Every readable PNG/JPEG in `dir`, keyed by file STEM (= sanitised part number). */
export async function listImages(dir: string): Promise<Record<string, LibraryImage>> {
  const out: Record<string, LibraryImage> = {}
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const ext = extname(name).toLowerCase()
    if (!IMAGE_EXTS.includes(ext)) continue
    const p = await resolveImageFile(dir, name)
    if (!p) continue
    // Header only — the dimensions are all the listing wants (see readHeader).
    const size = imageSize(await readHeader(p))
    if (!size) continue
    const st = await stat(p).catch(() => null)
    if (!st) continue
    const stem = name.slice(0, -ext.length)
    // Two extensions for one stem: first in directory order wins (spec 5.2).
    if (!(stem in out))
      out[stem] = { file: name, pxW: size.w, pxH: size.h, mtimeMs: st.mtimeMs }
  }
  return out
}

/**
 * The library file for a part number, or null if it has none. The one place the
 * extension probe lives — the protocol handler serves through this too, so it
 * cannot drift from what `removeImage` / `imageDataUrl` see.
 */
export async function resolveForPart(dir: string, pn: string): Promise<string | null> {
  const stem = sanitisePartNumber(pn)
  for (const ext of IMAGE_EXTS) {
    const p = await resolveImageFile(dir, stem + ext)
    if (p) return p
  }
  return null
}

/**
 * Copy `src` into the library as `<sanitised pn>.<ext by header>`; rejects
 * non-PNG/JPEG.
 *
 * `src` comes from the renderer (a drag-and-drop path) so it is checked BEFORE
 * it is read: a `stat` that is not a regular file rules out `/dev/zero`, which
 * would grow the main process's buffer to the 2 GiB limit, and a FIFO, which
 * would hang the `invoke` forever with no writer. The size cap then bounds the
 * read itself.
 */
export async function importImage(
  dir: string,
  pn: string,
  src: string,
  maxBytes = IMAGE_MAX_BYTES
): Promise<LibraryImage> {
  const st = await stat(src).catch(() => null)
  if (!st?.isFile()) throw new Error('Not a regular file')
  if (st.size > maxBytes) throw new Error(`Image is larger than ${maxBytes} bytes`)
  const buf = await readFile(src)
  const size = imageSize(buf)
  if (!size) throw new Error('Not a PNG or JPEG image')
  const stem = sanitisePartNumber(pn)
  // Drop every extension for this stem first, so an import never leaves a
  // stale .jpg shadowing the new .png.
  for (const ext of IMAGE_EXTS) await rm(join(dir, stem + ext), { force: true })
  const file = `${stem}.${size.type === 'png' ? 'png' : 'jpg'}`
  const dest = join(dir, file)
  await copyFile(src, dest)
  // mtime of the COPY, not of `src` — it is what the cache-busting `?v=` keys
  // on, so it has to move every time the library file is rewritten.
  const destSt = await stat(dest)
  return { file, pxW: size.w, pxH: size.h, mtimeMs: destSt.mtimeMs }
}

/** Delete this part's library file. False if it had none. */
export async function removeImage(dir: string, pn: string): Promise<boolean> {
  const p = await resolveForPart(dir, pn)
  if (!p) return false
  await rm(p)
  return true
}

/** Inline the picture for export. Null when absent, unreadable, or over `maxBytes`. */
export async function imageDataUrl(
  dir: string,
  pn: string,
  maxBytes = IMAGE_MAX_BYTES
): Promise<string | null> {
  const p = await resolveForPart(dir, pn)
  if (!p) return null
  // Cap BEFORE the read, not after: a 400 MB file over the cap was being read
  // into the main process in full only to be thrown away.
  const st = await stat(p).catch(() => null)
  if (!st || st.size > maxBytes) return null
  const buf = await readFile(p)
  const size = imageSize(buf)
  return size ? `data:${MIME[size.type]};base64,${buf.toString('base64')}` : null
}
