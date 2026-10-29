/**
 * `library put | show | search` — pure functions (wiring and output formatting are
 * Task 5's). Results are structured; problems are one string per line.
 */
import { readFile, writeFile, mkdtemp, realpath, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import { parseLibraryPart, type LibraryPart } from '@shared/parts/librarySchema'
import { sanitisePartNumber } from '@shared/parts/images'
import { LIBRARY_SUBDIRS } from '../main/settings'
import {
  DATASHEET_MAX_BYTES,
  datasheetPath,
  importDatasheet,
  importPicture,
  listParts,
  picturePath,
  removeDatasheet,
  removePicture,
  writePart
} from '../main/partsLibrary'
import { IMAGE_MAX_BYTES } from '../main/partsImages'
import { renameWithRetry } from '../main/renameRetry'
import { incompleteReasons, unreadableRecord } from './rails'
import { openLibrary } from './session'

export type FetchLike = (url: string, init?: { redirect?: 'follow'; signal?: AbortSignal }) => Promise<Response>

/** How long a datasheet download may take, start to last byte. */
export const DATASHEET_TIMEOUT_MS = 60_000

/**
 * Download `url` to `dest` (redirects followed, 50 MB cap, `timeoutMs` for the whole
 * download). Does not check the bytes are a PDF — `importDatasheet` does that. A
 * picture comes down through here too, capped at 5 MB, and `importPicture` checks it.
 */
export async function fetchDatasheet(
  url: string,
  dest: string,
  fetchImpl: FetchLike = fetch as FetchLike,
  maxBytes = DATASHEET_MAX_BYTES,
  timeoutMs = DATASHEET_TIMEOUT_MS
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs)
  const timedOut = () => new Error(`download timed out after ${timeoutMs / 1000} s for ${url}`)
  // A fetch that ignores the signal still loses the race.
  const aborted = new Promise<never>((_, rej) => {
    if (signal.aborted) rej(timedOut())
    signal.addEventListener('abort', () => rej(timedOut()), { once: true })
  })
  aborted.catch(() => {})
  let res: Response
  try {
    res = await Promise.race([fetchImpl(url, { redirect: 'follow', signal }), aborted])
  } catch (e) {
    if (signal.aborted) throw timedOut()
    throw e
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  const tooBig = () => new Error(`download is over ${maxBytes / 1024 / 1024} MB`)
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig()
  const chunks: Uint8Array[] = []
  let total = 0
  if (!res.body) throw new Error(`download failed: empty body for ${url}`)
  const reader = res.body.getReader()
  try {
    for (;;) {
      // A stalled body must not hang the CLI, nor end as a truncated file.
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw tooBig()
      chunks.push(value)
    }
  } catch (e) {
    await reader.cancel().catch(() => {})
    throw e
  }
  await writeFile(dest, Buffer.concat(chunks))
}

export interface PutResult {
  ok: boolean
  partNumber?: string
  created?: boolean
  /** One problem per entry; empty when ok. */
  problems: string[]
}

/** The exact bytes of a file, or null when it does not exist. Other read errors throw. */
async function bytesOf(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Write `bytes` to `path` via a temp file + rename (never a half-written file). */
async function putBytes(path: string, bytes: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.rollback.tmp`
  await writeFile(tmp, bytes)
  await renameWithRetry(tmp, path)
}

/**
 * `<dir>/parts/<stem>.json`, refusing (as `writePart` would) a `parts` folder or record file
 * that resolves outside the library — so the snapshot and rollback never touch a file there.
 */
async function recordFileIn(dir: string, stem: string): Promise<{ path: string } | { error: string }> {
  const root = await realpath(resolve(dir)).catch(() => null)
  if (!root) return { error: 'library folder is not writable here' }
  const sub = join(root, LIBRARY_SUBDIRS.parts)
  if (!existsSync(sub)) return { path: join(sub, `${stem}.json`) } // writePart creates the folder
  const partsDir = await realpath(sub).catch(() => null)
  if (!partsDir || !partsDir.startsWith(root + sep)) return { error: 'library folder is not writable here' }
  const path = join(partsDir, `${stem}.json`)
  const real = await realpath(path).catch(() => null)
  if (real && !real.startsWith(partsDir + sep)) return { error: `${stem}.json resolves outside the library` }
  return { path }
}

/** `datasheet` (a PDF) and `picture` (a PNG or JPEG) are each a local path or an http(s) URL. */
type PutOpts = { datasheet?: string; picture?: string; fetchImpl?: FetchLike; timeoutMs?: number }

const fail = (problems: string[], partNumber?: string): PutResult => ({ ok: false, partNumber, problems })

export async function libraryPut(dir: string, recordPath: string, opts: PutOpts = {}): Promise<PutResult> {
  let text: string
  try {
    text = await readFile(recordPath, 'utf8')
  } catch (e) {
    return fail([`${recordPath}: ${(e as Error).message}`])
  }
  return libraryPutText(dir, text, recordPath, opts)
}

/**
 * `libraryPut` with the record's JSON already in hand (the app's MCP `library_put`);
 * `source` names it in a parse problem, as the record file's path does for the CLI.
 */
export async function libraryPutText(dir: string, text: string, source: string, opts: PutOpts = {}): Promise<PutResult> {
  const parsed = parseLibraryPart(text)
  if ('error' in parsed) return fail([`${source}: ${parsed.error}`])
  const part = parsed.part
  const pn = part.partNumber
  const stem = sanitisePartNumber(pn)
  const recordFile = await recordFileIn(dir, stem)
  if ('error' in recordFile) return fail([`${pn}: ${recordFile.error}`], pn)

  // Whatever is at the target stem decides, BEFORE anything is written (no transient
  // overwrite of another part's record or datasheet): an unreadable file is the user's to
  // repair, a different part number there is a collision. Its exact bytes are the rollback.
  let prevRecord: Buffer | null
  try {
    prevRecord = await bytesOf(recordFile.path)
  } catch (e) {
    return fail([`${pn}: existing ${stem}.json is unreadable: ${(e as Error).message} — fix or remove it by hand`], pn)
  }
  if (prevRecord) {
    const existing = parseLibraryPart(prevRecord.toString('utf8'), stem)
    if ('error' in existing)
      return fail([`${pn}: existing ${stem}.json is unreadable: ${existing.error} — fix or remove it by hand`], pn)
    if (existing.part.partNumber !== pn)
      return fail(
        [`${pn}: part number "${pn}" collides with existing "${existing.part.partNumber}" (same file name "${stem}.json")`],
        pn
      )
  }

  const scratch = await mkdtemp(join(tmpdir(), 'harness-put-'))
  try {
    // Resolve the new datasheet and picture to local files before touching the library.
    const local = async (src: string, name: string, maxBytes?: number): Promise<string> => {
      if (!/^https?:\/\//i.test(src)) return src
      const dest = join(scratch, name)
      await fetchDatasheet(src, dest, opts.fetchImpl, maxBytes, opts.timeoutMs)
      return dest
    }
    let newSheet: string | undefined
    let newPicture: string | undefined
    try {
      if (opts.datasheet) newSheet = await local(opts.datasheet, 'new.pdf')
    } catch (e) {
      return fail([`${pn}: datasheet ${(e as Error).message}`], pn)
    }
    try {
      if (opts.picture) newPicture = await local(opts.picture, 'new-picture', IMAGE_MAX_BYTES)
    } catch (e) {
      return fail([`${pn}: picture ${(e as Error).message}`], pn)
    }

    // Snapshot the datasheet and picture (exact bytes, at their own paths) for rollback.
    let prevSheetPath: string | null
    let prevSheet: Buffer | null = null
    let prevPicturePath: string | null = null
    let prevPicture: Buffer | null = null
    try {
      prevSheetPath = await datasheetPath(dir, pn)
      if (prevSheetPath) prevSheet = await readFile(prevSheetPath)
    } catch (e) {
      return fail([`${pn}: cannot read the existing datasheet: ${(e as Error).message}`], pn)
    }
    try {
      if (newPicture) prevPicturePath = await picturePath(dir, pn)
      if (prevPicturePath) prevPicture = await readFile(prevPicturePath)
    } catch (e) {
      return fail([`${pn}: cannot read the existing picture: ${(e as Error).message}`], pn)
    }

    let sheetTouched = false
    let pictureTouched = false
    let recordTouched = false
    /** Undo what this put wrote; never throws — a failure is reported as a problem. */
    const rollback = async (problems: string[]): Promise<PutResult> => {
      try {
        if (recordTouched) {
          if (prevRecord) await putBytes(recordFile.path, prevRecord)
          else await rm(recordFile.path, { force: true })
        }
        if (sheetTouched) {
          await removeDatasheet(dir, pn)
          if (prevSheetPath && prevSheet) await putBytes(prevSheetPath, prevSheet)
        }
        if (pictureTouched) {
          await removePicture(dir, pn)
          if (prevPicturePath && prevPicture) await putBytes(prevPicturePath, prevPicture)
        }
      } catch (e) {
        problems = [
          ...problems,
          `ROLLBACK FAILED: ${(e as Error).message} — check ${recordFile.path}, its datasheet and its picture by hand`
        ]
      }
      return fail(problems, pn)
    }

    try {
      if (newSheet) {
        sheetTouched = true
        await importDatasheet(dir, pn, newSheet)
      }
      if (newPicture) {
        pictureTouched = true
        await importPicture(dir, pn, newPicture).catch((e: Error) => {
          throw new Error(`picture: ${e.message}`)
        })
      }
      recordTouched = true
      await writePart(dir, part)
    } catch (e) {
      return rollback([`${pn}: ${(e as Error).message}`])
    }
    let reasons: string[]
    try {
      reasons = incompleteReasons(pn, await openLibrary(dir))
    } catch (e) {
      return rollback([`${pn}: ${(e as Error).message}`])
    }
    if (reasons.length > 0) return rollback(reasons)
    return { ok: true, partNumber: pn, created: !prevRecord, problems: [] }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export interface ShowResult {
  part: LibraryPart
  hasDatasheet: boolean
  /** A picture is never required; this says whether the part has one. */
  hasPicture: boolean
  incomplete: string[]
}

/** `{ unreadable }`: `parts/<stem>.json` exists but does not load — not the same as absent. */
export async function libraryShow(dir: string, pn: string): Promise<ShowResult | { unreadable: string } | null> {
  const lib = await openLibrary(dir)
  const part = lib.catalog.part(pn)
  if (!part) {
    const bad = unreadableRecord(lib, pn)
    return bad === null ? null : { unreadable: bad }
  }
  return {
    part,
    hasDatasheet: lib.datasheets.has(sanitisePartNumber(part.partNumber)),
    hasPicture: (await picturePath(dir, part.partNumber)) !== null,
    incomplete: incompleteReasons(part.partNumber, lib)
  }
}

export interface SearchHit {
  partNumber: string
  kind: string
  manufacturer: string
  description: string
  complete: boolean
}

export interface SearchResult {
  hits: SearchHit[]
  /** Every record file under `parts/` that exists but did not load — it cannot be searched, so it is always listed. */
  unreadable: { file: string; error: string }[]
}

export async function librarySearch(dir: string, text: string): Promise<SearchResult> {
  const lib = await openLibrary(dir)
  const q = text.trim().toLowerCase()
  const listing = await listParts(dir)
  const hits = listing.parts
    .filter((p) =>
      [p.partNumber, p.manufacturer ?? '', p.description ?? ''].some((f) => f.toLowerCase().includes(q))
    )
    .map((p) => ({
      partNumber: p.partNumber,
      kind: p.kind,
      manufacturer: p.manufacturer ?? '',
      description: p.description ?? '',
      complete: incompleteReasons(p.partNumber, lib).length === 0
    }))
    .sort((a, b) => a.partNumber.localeCompare(b.partNumber))
  return { hits, unreadable: listing.errors }
}

/** One line per hit: `<pn>  <kind>  <manufacturer>  <description>  [complete|incomplete]`. */
export const formatHit = (h: SearchHit): string =>
  `${h.partNumber}  ${h.kind}  ${h.manufacturer}  ${h.description}  [${h.complete ? 'complete' : 'incomplete'}]`
