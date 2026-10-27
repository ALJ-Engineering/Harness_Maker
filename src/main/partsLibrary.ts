import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, join, resolve, sep } from 'path'
import { LIBRARY_SUBDIRS } from './settings'
import { readHeader } from './partsImages'
import { sanitisePartNumber } from '../shared/parts/images'
import { parseLibraryPart, serializeLibraryPart, type LibraryPart } from '../shared/parts/librarySchema'

/**
 * The parts library on disk: `<dir>/parts/<stem>.json`, `<dir>/images/<stem>.*`
 * (handled by partsImages.ts), `<dir>/datasheets/<stem>.pdf`. Electron-free.
 * Every path derived from a part number goes through `insideDir`, the same
 * realpath+basename guard `partsImages.ts` uses.
 */
export const DATASHEET_MAX_BYTES = 50 * 1024 * 1024

export interface LibraryListing {
  parts: LibraryPart[]
  /** Stems that have a `datasheets/<stem>.pdf`. */
  datasheets: Set<string>
  errors: { file: string; error: string }[]
}

export async function ensureLibraryDirs(dir: string): Promise<void> {
  for (const sub of Object.values(LIBRARY_SUBDIRS)) await mkdir(join(dir, sub), { recursive: true })
}

/** Absolute path of `fileName` if it is a regular file INSIDE `<dir>/<sub>`; else null. */
async function insideDir(dir: string, sub: string, fileName: string): Promise<string | null> {
  if (!fileName || fileName !== basename(fileName)) return null
  const root = await realpath(resolve(join(dir, sub))).catch(() => null)
  if (!root) return null
  const p = await realpath(join(root, fileName)).catch(() => null)
  if (!p || !p.startsWith(root + sep)) return null
  const s = await stat(p).catch(() => null)
  return s?.isFile() ? p : null
}

/**
 * `mkdir`s `<dir>/<sub>` then realpath-verifies it still resolves INSIDE
 * `dir` before any write touches it — a symlinked subfolder (e.g. `datasheets`
 * pointed outside the library) must not become a write target just because
 * `insideDir`'s read-side check never ran on it. Throws rather than returning
 * null: every caller is about to write and has no other way to signal this.
 */
async function writableSubdir(dir: string, sub: string): Promise<string> {
  await mkdir(join(dir, sub), { recursive: true })
  const root = await realpath(resolve(dir)).catch(() => null)
  const subReal = await realpath(join(dir, sub)).catch(() => null)
  if (!root || !subReal || !subReal.startsWith(root + sep)) throw new Error('library folder is not writable here')
  return subReal
}

const stemOf = sanitisePartNumber

export async function listParts(dir: string): Promise<LibraryListing> {
  const out: LibraryListing = { parts: [], datasheets: new Set(), errors: [] }
  const partsDir = join(dir, LIBRARY_SUBDIRS.parts)
  let files: string[]
  try {
    files = await readdir(partsDir)
  } catch (e) {
    out.errors.push({ file: partsDir, error: (e as Error).message })
    return out
  }
  for (const f of files.sort()) {
    if (extname(f) !== '.json') continue
    const text = await readFile(join(partsDir, f), 'utf-8').catch((e: Error) => e)
    if (text instanceof Error) { out.errors.push({ file: f, error: text.message }); continue }
    const r = parseLibraryPart(text, basename(f, '.json'))
    if ('error' in r) out.errors.push({ file: f, error: r.error })
    else out.parts.push(r.part)
  }
  const ds = await readdir(join(dir, LIBRARY_SUBDIRS.datasheets)).catch(() => [] as string[])
  for (const f of ds) if (extname(f).toLowerCase() === '.pdf') out.datasheets.add(basename(f, extname(f)))
  return out
}

export async function readPart(dir: string, partNumber: string): Promise<LibraryPart | null> {
  const stem = stemOf(partNumber)
  const p = await insideDir(dir, LIBRARY_SUBDIRS.parts, `${stem}.json`)
  if (!p) return null
  const r = parseLibraryPart(await readFile(p, 'utf-8'), stem)
  return 'part' in r ? r.part : null
}

/**
 * Validate then write atomically (`.tmp` → rename). Throws with the validation
 * message. Two DIFFERENT part numbers can sanitise to the same file stem (e.g.
 * `39-01/3045` and `39-01_3045` both become `39-01_3045`) — writing the second
 * over the first would silently destroy it (and a later `deletePart(...,
 * {withFiles: true})` on the survivor would then remove the other part's
 * picture/datasheet too). Guard by reading whatever is already at the target
 * stem: overwriting the SAME part number is the normal edit-and-save path and
 * must keep working; a DIFFERENT part number at that stem is refused outright.
 */
export async function writePart(dir: string, part: LibraryPart): Promise<void> {
  const text = serializeLibraryPart(part)
  const stem = stemOf(part.partNumber)
  const r = parseLibraryPart(text, stem)
  if ('error' in r) throw new Error(r.error)
  const partsDir = await writableSubdir(dir, LIBRARY_SUBDIRS.parts)
  const target = join(partsDir, `${stem}.json`)
  const existingText = await readFile(target, 'utf-8').catch(() => null)
  if (existingText !== null) {
    const existing = parseLibraryPart(existingText, stem)
    if ('part' in existing && existing.part.partNumber !== part.partNumber) {
      throw new Error(
        `part number "${part.partNumber}" collides with existing "${existing.part.partNumber}" (same file name "${stem}.json")`
      )
    }
  }
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, serializeLibraryPart(r.part), 'utf-8')
  await rename(tmp, target)
}

export async function deletePart(dir: string, partNumber: string, withFiles: boolean): Promise<boolean> {
  const stem = stemOf(partNumber)
  const p = await insideDir(dir, LIBRARY_SUBDIRS.parts, `${stem}.json`)
  if (!p) return false
  await rm(p)
  if (withFiles) {
    await removeDatasheet(dir, partNumber)
    for (const ext of ['.png', '.jpg', '.jpeg']) {
      const img = await insideDir(dir, LIBRARY_SUBDIRS.images, `${stem}${ext}`)
      if (img) await rm(img)
    }
  }
  return true
}

/**
 * `listParts` finds a datasheet stem with a case-INSENSITIVE `.pdf` glyph
 * check (`extname(f).toLowerCase() === '.pdf'`), so a file dropped in from
 * Finder as `<stem>.PDF` still shows the glyph. On a case-sensitive filesystem
 * `insideDir` would then disagree and `Open` would 404 — probe both cases so
 * the listing glyph and `Open` always agree.
 */
export async function datasheetPath(dir: string, partNumber: string): Promise<string | null> {
  const stem = stemOf(partNumber)
  return (
    (await insideDir(dir, LIBRARY_SUBDIRS.datasheets, `${stem}.pdf`)) ??
    (await insideDir(dir, LIBRARY_SUBDIRS.datasheets, `${stem}.PDF`))
  )
}

/** Copy `srcPath` in as this part's datasheet. Rejects non-files, non-PDFs, > `maxBytes` (default 50 MB). */
export async function importDatasheet(
  dir: string,
  partNumber: string,
  srcPath: string,
  maxBytes = DATASHEET_MAX_BYTES
): Promise<void> {
  const s = await stat(srcPath).catch(() => null)
  if (!s?.isFile()) throw new Error('not a regular file')
  if (s.size > maxBytes) throw new Error(`file is over ${maxBytes / 1024 / 1024} MB`)
  const head = await readHeader(srcPath, 8)
  if (head.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF file')
  const dsDir = await writableSubdir(dir, LIBRARY_SUBDIRS.datasheets)
  const target = join(dsDir, `${stemOf(partNumber)}.pdf`)
  const tmp = `${target}.${process.pid}.tmp`
  await copyFile(srcPath, tmp)
  await rename(tmp, target)
}

export async function removeDatasheet(dir: string, partNumber: string): Promise<boolean> {
  const p = await datasheetPath(dir, partNumber)
  if (!p) return false
  await rm(p)
  return true
}
