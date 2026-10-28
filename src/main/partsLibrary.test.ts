import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SYMLINK_SKIP, trySymlink } from './testSymlink'
import {
  ensureLibraryDirs, listParts, readPart, writePart, deletePart,
  datasheetPath, importDatasheet, removeDatasheet
} from './partsLibrary'
import { newLibraryPart, type LibraryPart } from '../shared/parts/librarySchema'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lib-')); await ensureLibraryDirs(dir) })
afterEach(() => rm(dir, { recursive: true, force: true }))

const housing: LibraryPart = { ...newLibraryPart('connector', '39-01/3045'), description: 'Molex', connector: { cavities: [{ position: '1' }] } }
const PDF = Buffer.from('%PDF-1.4\n%fake\n')

describe('parts', () => {
  it('ensureLibraryDirs creates the three subfolders', async () => {
    expect((await readdir(dir)).sort()).toEqual(['branding', 'datasheets', 'images', 'parts'])
  })
  it('write → list → read, keyed by sanitised stem', async () => {
    await writePart(dir, housing)
    expect(await readdir(join(dir, 'parts'))).toEqual(['39-01_3045.json'])
    const l = await listParts(dir)
    expect(l.parts).toEqual([housing])
    expect(l.errors).toEqual([])
    expect(await readPart(dir, '39-01/3045')).toEqual(housing)
    expect(await readPart(dir, 'nope')).toBeNull()
  })
  it('write is atomic — no .tmp left behind, and rejects an invalid record', async () => {
    await writePart(dir, housing)
    expect((await readdir(join(dir, 'parts'))).some((f) => f.endsWith('.tmp'))).toBe(false)
    await expect(writePart(dir, { ...housing, connector: { cavities: [{ position: '1' }, { position: '1' }] } })).rejects.toThrow(/duplicate/)
  })
  it('overwriting the SAME part number at the same stem keeps working', async () => {
    await writePart(dir, housing)
    const updated = { ...housing, description: 'Molex v2' }
    await writePart(dir, updated)
    expect(await readPart(dir, '39-01/3045')).toEqual(updated)
  })
  it('writePart refuses a stem collision with a DIFFERENT part number', async () => {
    // "39-01/3045" and "39-01_3045" both sanitise to the same file stem.
    const other: LibraryPart = { ...newLibraryPart('connector', '39-01_3045'), description: 'Other', connector: { cavities: [] } }
    await writePart(dir, housing)
    await expect(writePart(dir, other)).rejects.toThrow(/collides with existing "39-01\/3045"/)
    // the original record must survive untouched
    expect(await readPart(dir, '39-01/3045')).toEqual(housing)
    expect(await readdir(join(dir, 'parts'))).toEqual(['39-01_3045.json'])
  })
  it('a corrupt file is reported, not thrown, and does not hide the others', async () => {
    await writePart(dir, housing)
    await writeFile(join(dir, 'parts', 'bad.json'), '{not json')
    await writeFile(join(dir, 'parts', 'MISMATCH.json'), JSON.stringify({ partNumber: 'other', kind: 'pin', description: '' }))
    await writeFile(join(dir, 'parts', 'notes.txt'), 'ignored')
    const l = await listParts(dir)
    expect(l.parts.map((p) => p.partNumber)).toEqual(['39-01/3045'])
    expect(l.errors.map((e) => e.file).sort()).toEqual(['MISMATCH.json', 'bad.json'])
  })
  it('lists datasheet stems', async () => {
    await writePart(dir, housing)
    await importDatasheet(dir, '39-01/3045', await tmpPdf())
    expect((await listParts(dir)).datasheets).toEqual(new Set(['39-01_3045']))
  })
  it('deletePart removes the record and, when asked, the files', async () => {
    await writePart(dir, housing)
    await importDatasheet(dir, '39-01/3045', await tmpPdf())
    await writeFile(join(dir, 'images', '39-01_3045.png'), 'x')
    expect(await deletePart(dir, '39-01/3045', false)).toBe(true)
    expect(await readdir(join(dir, 'datasheets'))).toEqual(['39-01_3045.pdf'])
    await writePart(dir, housing)
    expect(await deletePart(dir, '39-01/3045', true)).toBe(true)
    expect(await readdir(join(dir, 'datasheets'))).toEqual([])
    expect(await readdir(join(dir, 'images'))).toEqual([])
    expect(await deletePart(dir, '39-01/3045', true)).toBe(false)
  })
  it('a missing library folder lists as one error', async () => {
    const l = await listParts(join(dir, 'gone'))
    expect(l.parts).toEqual([])
    expect(l.errors).toHaveLength(1)
  })
})

async function tmpPdf(bytes: Buffer = PDF): Promise<string> {
  const p = join(dir, 'src.pdf')
  await writeFile(p, bytes)
  return p
}

describe('datasheets', () => {
  it('imports a PDF, resolves its path, removes it', async () => {
    await importDatasheet(dir, 'PN-1', await tmpPdf())
    const p = await datasheetPath(dir, 'PN-1')
    expect(p).toBe(join(await realDir(), 'datasheets', 'PN-1.pdf'))
    expect(await removeDatasheet(dir, 'PN-1')).toBe(true)
    expect(await datasheetPath(dir, 'PN-1')).toBeNull()
    expect(await removeDatasheet(dir, 'PN-1')).toBe(false)
  })
  it('rejects a non-PDF, a directory and an oversized file', async () => {
    await expect(importDatasheet(dir, 'A', await tmpPdf(Buffer.from('hello')))).rejects.toThrow(/PDF/)
    await expect(importDatasheet(dir, 'A', dir)).rejects.toThrow()
    await expect(importDatasheet(dir, 'A', join(dir, 'missing.pdf'))).rejects.toThrow()
  })
  it('rejects a file over the caller-supplied maxBytes, default unchanged', async () => {
    const src = await tmpPdf()
    await expect(importDatasheet(dir, 'A', src, PDF.length - 1)).rejects.toThrow(/MB/)
    await expect(datasheetPath(dir, 'A')).resolves.toBeNull()
    await importDatasheet(dir, 'A', src) // default DATASHEET_MAX_BYTES still accepts it
    await expect(datasheetPath(dir, 'A')).resolves.not.toBeNull()
  })
  it('resolves an uppercase .PDF extension too, so the case-insensitive listing glyph and Open agree', async () => {
    await writeFile(join(dir, 'datasheets', 'UP-1.PDF'), PDF)
    expect(await datasheetPath(dir, 'UP-1')).toBe(join(await realDir(), 'datasheets', 'UP-1.PDF'))
  })
  it('a symlink out of the folder does not resolve', async ({ skip }) => {
    const outside = join(dir, 'outside.pdf')
    await writeFile(outside, PDF)
    if (!(await trySymlink(outside, join(dir, 'datasheets', 'EVIL.pdf')))) return skip(SYMLINK_SKIP)
    expect(await datasheetPath(dir, 'EVIL')).toBeNull()
  })
  it('a part number that sanitises to a path escape stays inside', async () => {
    expect(await datasheetPath(dir, '../../etc/passwd')).toBeNull()
  })
  it('a symlinked write target pointing outside the library is refused, nothing written outside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    try {
      await rm(join(dir, 'datasheets'), { recursive: true, force: true })
      // A junction on Windows, so this one runs without Developer Mode (see testSymlink.ts).
      expect(await trySymlink(outside, join(dir, 'datasheets'), 'dir')).toBe(true)
      await expect(importDatasheet(dir, 'A', await tmpPdf())).rejects.toThrow(/not writable/)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

async function realDir(): Promise<string> {
  const { realpath } = await import('fs/promises')
  return realpath(dir)
}
