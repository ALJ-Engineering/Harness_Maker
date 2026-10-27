import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { imageSize } from './imageSize'
import { resolveImageFile } from './partsImages'
import { LIBRARY_SUBDIRS } from './settings'

/**
 * The title-block logo, from the parts library: `<lib>/branding/logo.svg`, else
 * `logo.png`, else `logo.jpg` / `logo.jpeg`. The app ships with no logo of its
 * own — no logo in the library means an empty logo cell. Electron-free so
 * vitest can exercise it; the IPC lives in `partsImagesIpc.ts`.
 */
const LOGO_FILES = ['logo.svg', 'logo.png', 'logo.jpg', 'logo.jpeg'] as const
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/**
 * The logo as a `data:` URI for the canvas and the print window, or null when
 * there is none, it is over `maxBytes`, or its bytes are not the image its
 * extension claims. Reads only inside `<lib>/branding` (`resolveImageFile`
 * refuses a symlink out of it).
 */
export async function logoDataUrl(libDir: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string | null> {
  const dir = join(libDir, LIBRARY_SUBDIRS.branding)
  for (const name of LOGO_FILES) {
    const p = await resolveImageFile(dir, name)
    if (!p) continue
    const st = await stat(p).catch(() => null)
    if (!st || st.size > maxBytes) return null
    const buf = await readFile(p)
    if (name.endsWith('.svg')) {
      return /<svg[\s>]/.test(buf.toString('utf8')) ? `data:image/svg+xml;base64,${buf.toString('base64')}` : null
    }
    const size = imageSize(buf)
    if (!size) return null
    return `data:image/${size.type === 'png' ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`
  }
  return null
}
