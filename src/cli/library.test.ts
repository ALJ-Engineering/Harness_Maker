import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newLibraryPart, serializeLibraryPart, type LibraryPart } from '@shared/parts/librarySchema'
import { datasheetPath, ensureLibraryDirs, importDatasheet, readPart, writePart } from '../main/partsLibrary'
import { fetchDatasheet, formatHit, libraryPut, librarySearch, libraryShow, type FetchLike } from './library'
import { full } from './testLibrary'

let tmp: string
let lib: string
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-lib-'))
  lib = join(tmp, 'lib')
  await ensureLibraryDirs(lib)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const conn = (over: Partial<LibraryPart> = {}): LibraryPart => {
  const c = { ...full(newLibraryPart('connector', 'HSG-1')), description: 'housing', ...over }
  c.connector = { cavities: [{ position: '1' }] }
  return c
}
const record = (p: LibraryPart, name = 'rec.json'): string => {
  const f = join(tmp, name)
  writeFileSync(f, serializeLibraryPart(p))
  return f
}
const pdf = (body = '%PDF-1.4\n%%EOF\n', name = 'ds.pdf'): string => {
  const f = join(tmp, name)
  writeFileSync(f, body)
  return f
}
const stub = (body: string | Uint8Array<ArrayBuffer>, status = 200): FetchLike => async () => new Response(body, { status })
const files = (): string[] =>
  ['parts', 'datasheets', 'images'].flatMap((d) => readdirSync(join(lib, d)).map((f) => `${d}/${f}`))
/** The smallest file `imageSize` reads as a PNG / a JPEG: just the header, `w` × `h` px. */
const pngBytes = (w = 4, h = 3): Uint8Array<ArrayBuffer> => {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return new Uint8Array(b)
}
const jpegBytes = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x07, 0x00, 0x05, ...new Array(12).fill(0)])
const picture = (bytes: Uint8Array | string, name: string): string => {
  const f = join(tmp, name)
  writeFileSync(f, bytes)
  return f
}

describe('libraryPut', () => {
  it('puts a complete connector with a local PDF; show reports complete', async () => {
    const r = await libraryPut(lib, record(conn()), { datasheet: pdf() })
    expect(r).toMatchObject({ ok: true, partNumber: 'HSG-1', created: true, problems: [] })
    expect(await datasheetPath(lib, 'HSG-1')).not.toBeNull()
    const s = await libraryShow(lib, 'HSG-1')
    expect(s).toMatchObject({ incomplete: [], hasDatasheet: true })
  })

  it('downloads a URL datasheet through the injected fetch', async () => {
    const r = await libraryPut(lib, record(conn()), { datasheet: 'https://x/ds.pdf', fetchImpl: stub('%PDF-1.7\n') })
    expect(r.ok).toBe(true)
    expect(readFileSync((await datasheetPath(lib, 'HSG-1'))!, 'latin1')).toBe('%PDF-1.7\n')
  })

  it('refuses an HTML URL response and writes nothing', async () => {
    const r = await libraryPut(lib, record(conn()), { datasheet: 'https://x/ds.pdf', fetchImpl: stub('<html></html>') })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('not a PDF file')
    expect(files()).toEqual([])
  })

  it('refuses a record without manufacturer and rolls back', async () => {
    const bad = conn()
    delete bad.manufacturer
    const r = await libraryPut(lib, record(bad), { datasheet: pdf() })
    expect(r.ok).toBe(false)
    expect(r.problems).toContain('HSG-1: missing manufacturer')
    expect(files()).toEqual([])
  })

  it('failed update restores the previous record and datasheet', async () => {
    expect((await libraryPut(lib, record(conn()), { datasheet: pdf('%PDF-1.4\nOLD\n') })).ok).toBe(true)
    const before = readFileSync(join(lib, 'parts', 'HSG-1.json'), 'utf8')
    const bad = conn({ description: 'changed' })
    delete bad.manufacturer
    const r = await libraryPut(lib, record(bad, 'bad.json'), { datasheet: pdf('%PDF-1.4\nNEW\n', 'new.pdf') })
    expect(r.ok).toBe(false)
    expect(readFileSync(join(lib, 'parts', 'HSG-1.json'), 'utf8')).toBe(before)
    expect(readFileSync((await datasheetPath(lib, 'HSG-1'))!, 'latin1')).toContain('OLD')
  })

  it('updating an incomplete record to complete succeeds; search flags it', async () => {
    const inc = conn()
    delete inc.manufacturer
    // seed incomplete directly (put itself would refuse it)
    const { writePart } = await import('../main/partsLibrary')
    await writePart(lib, inc)
    expect((await librarySearch(lib, 'hsg')).hits.map(formatHit)).toEqual(['HSG-1  connector    housing  [incomplete]'])
    const r = await libraryPut(lib, record(conn()), { datasheet: pdf() })
    expect(r).toMatchObject({ ok: true, created: false })
    expect((await librarySearch(lib, 'HOUSING')).hits.map((h) => [h.partNumber, h.complete])).toEqual([['HSG-1', true]])
    expect((await readPart(lib, 'HSG-1'))?.manufacturer).toBe('TE')
  })

  it('names an incomplete default pin and rolls back the connector', async () => {
    const c = conn()
    c.connector = { cavities: [{ position: '1', defaultPin: 'PIN-9' }] }
    const r = await libraryPut(lib, record(c), { datasheet: pdf() })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('PIN-9')
    expect(files()).toEqual([])
  })

  it('reports an unparseable record', async () => {
    const f = join(tmp, 'junk.json')
    writeFileSync(f, '{nope')
    const r = await libraryPut(lib, f)
    expect(r.ok).toBe(false)
    expect(existsSync(join(lib, 'parts', 'junk.json'))).toBe(false)
  })
})

describe('libraryPut with a picture', () => {
  it('copies a local PNG in next to the record; show reports it', async () => {
    expect(await libraryShow(lib, 'HSG-1')).toBeNull()
    const r = await libraryPut(lib, record(conn()), { datasheet: pdf(), picture: picture(pngBytes(), 'photo.png') })
    expect(r).toMatchObject({ ok: true, partNumber: 'HSG-1', created: true })
    expect(files()).toContain('images/HSG-1.png')
    expect(await libraryShow(lib, 'HSG-1')).toMatchObject({ hasPicture: true, incomplete: [] })
  })

  it('a part without one shows hasPicture false: a picture is never required', async () => {
    expect((await libraryPut(lib, record(conn()), { datasheet: pdf() })).ok).toBe(true)
    expect(await libraryShow(lib, 'HSG-1')).toMatchObject({ hasPicture: false, incomplete: [] })
  })

  it('downloads a URL picture; a JPEG replaces an earlier PNG instead of sitting beside it', async () => {
    expect((await libraryPut(lib, record(conn()), { datasheet: pdf(), picture: picture(pngBytes(), 'photo.png') })).ok).toBe(true)
    const r = await libraryPut(lib, record(conn()), { picture: 'https://x/photo.jpg', fetchImpl: stub(jpegBytes()) })
    expect(r).toMatchObject({ ok: true, created: false })
    expect(files().filter((f) => f.startsWith('images/'))).toEqual(['images/HSG-1.jpg'])
  })

  it('refuses a picture that is not a PNG or JPEG, and writes nothing', async () => {
    const webp = picture('RIFF....WEBPVP8 ', 'photo.webp')
    const r = await libraryPut(lib, record(conn()), { datasheet: pdf(), picture: webp })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['HSG-1: picture: Not a PNG or JPEG image'])
    expect(files()).toEqual([])
  })

  it('a failed download names the picture and writes nothing', async () => {
    const r = await libraryPut(lib, record(conn()), { datasheet: pdf(), picture: 'https://x/p.png', fetchImpl: stub('', 404) })
    expect(r.problems).toEqual(['HSG-1: picture download failed: HTTP 404 for https://x/p.png'])
    expect(files()).toEqual([])
  })

  it('a failed update puts the previous picture back, byte for byte', async () => {
    const old = jpegBytes()
    expect((await libraryPut(lib, record(conn()), { datasheet: pdf(), picture: picture(old, 'old.jpg') })).ok).toBe(true)
    const bad = conn({ description: 'changed' })
    delete bad.manufacturer
    const r = await libraryPut(lib, record(bad, 'bad.json'), { picture: picture(pngBytes(), 'new.png') })
    expect(r.ok).toBe(false)
    expect(files().filter((f) => f.startsWith('images/'))).toEqual(['images/HSG-1.jpg'])
    expect(new Uint8Array(readFileSync(join(lib, 'images', 'HSG-1.jpg')))).toEqual(old)
  })
})

describe('fetchDatasheet', () => {
  it('enforces the size cap and HTTP status', async () => {
    const dest = join(tmp, 'o.pdf')
    await expect(fetchDatasheet('https://x', dest, stub('x'.repeat(20)), 10)).rejects.toThrow('over')
    await expect(fetchDatasheet('https://x', dest, stub('x', 404))).rejects.toThrow('HTTP 404')
    await fetchDatasheet('https://x', dest, stub('%PDF-ok'))
    expect(readFileSync(dest, 'latin1')).toBe('%PDF-ok')
  })
})

describe('libraryShow', () => {
  it('null for an unknown part', async () => {
    expect(await libraryShow(lib, 'NOPE')).toBeNull()
  })
})

describe('libraryPut — final review I1/I2', () => {
  const recFile = (stem: string) => join(lib, 'parts', `${stem}.json`)

  it('refuses a connector whose default pin is a wire record', async () => {
    const w = full(newLibraryPart('wire', 'W-1'))
    w.wire = { gauge: { value: 0.5, unit: 'mm2' } }
    expect((await libraryPut(lib, record(w, 'w.json'), { datasheet: pdf() })).ok).toBe(true)
    const c = conn()
    c.connector = { cavities: [{ position: '1', defaultPin: 'W-1' }] }
    const r = await libraryPut(lib, record(c), { datasheet: pdf() })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['HSG-1: default pin W-1 — is a wire, expected pin'])
    expect(existsSync(recFile('HSG-1'))).toBe(false)
  })

  it('an unreadable existing record: put refuses and leaves it byte-identical; show and search report it', async () => {
    const truncated = '{"partNumber": "SEAL-2", "kind": "se'
    writeFileSync(recFile('SEAL-2'), truncated)
    const seal = full(newLibraryPart('seal', 'SEAL-2'))
    const r = await libraryPut(lib, record(seal), { datasheet: pdf() })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['SEAL-2: existing SEAL-2.json is unreadable: not valid JSON — fix or remove it by hand'])
    expect(readFileSync(recFile('SEAL-2'), 'utf8')).toBe(truncated)
    expect(files()).toEqual(['parts/SEAL-2.json']) // no datasheet imported either
    expect(await libraryShow(lib, 'SEAL-2')).toEqual({ unreadable: 'not valid JSON' })
    expect(await libraryShow(lib, 'SEAL-9')).toBeNull()
    const found = await librarySearch(lib, 'zzz')
    expect(found).toEqual({ hits: [], unreadable: [{ file: 'SEAL-2.json', error: 'not valid JSON' }] })
  })

  it('a part-number / file-stem collision is refused up front: the other part\'s record and datasheet are never replaced', async () => {
    const other = full(newLibraryPart('pin', '39-01/3045'))
    expect((await libraryPut(lib, record(other, 'o.json'), { datasheet: pdf('%PDF-1.4\nOTHER\n', 'o.pdf') })).ok).toBe(true)
    const recBefore = readFileSync(recFile('39-01_3045'))
    const sheet = (await datasheetPath(lib, '39-01/3045'))!
    const sheetBefore = readFileSync(sheet)
    const inodes = [statSync(recFile('39-01_3045')).ino, statSync(sheet).ino]
    const mine = full(newLibraryPart('pin', '39-01_3045'))
    const r = await libraryPut(lib, record(mine), { datasheet: pdf('%PDF-1.4\nMINE\n', 'm.pdf') })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual([
      '39-01_3045: part number "39-01_3045" collides with existing "39-01/3045" (same file name "39-01_3045.json")'
    ])
    expect(readFileSync(recFile('39-01_3045')).equals(recBefore)).toBe(true)
    expect(readFileSync(sheet).equals(sheetBefore)).toBe(true)
    // Same inodes: neither file was replaced, not even transiently and then restored.
    expect([statSync(recFile('39-01_3045')).ino, statSync(sheet).ino]).toEqual(inodes)
  })

  it('a failed update without a new datasheet restores the record\'s exact bytes (not a re-serialisation)', async () => {
    await writePart(lib, conn())
    const stub = join(tmp, 's.pdf')
    writeFileSync(stub, '%PDF-1.4\n')
    await importDatasheet(lib, 'HSG-1', stub)
    // A hand-edited file: its own formatting and key order, which a re-serialise would change.
    const handEdited =
      '{ "kind": "connector", "partNumber": "HSG-1", "description": "housing",\n  "manufacturer": "TE", "datasheetUrl": "https://x/ds.pdf",\n  "connector": { "cavities": [ { "position": "1" } ] } }\n'
    writeFileSync(recFile('HSG-1'), handEdited)
    expect((await libraryShow(lib, 'HSG-1'))).toMatchObject({ incomplete: [] })
    const bad = conn({ description: 'changed' })
    delete bad.manufacturer
    const r = await libraryPut(lib, record(bad, 'bad.json'))
    expect(r).toMatchObject({ ok: false, problems: ['HSG-1: missing manufacturer'] })
    expect(readFileSync(recFile('HSG-1'), 'utf8')).toBe(handEdited)
  })

  it('a datasheet download that never answers times out: refused, nothing written', async () => {
    const hang: FetchLike = () => new Promise<Response>(() => {})
    const r = await libraryPut(lib, record(conn()), { datasheet: 'https://x/ds.pdf', fetchImpl: hang, timeoutMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['HSG-1: datasheet download timed out after 0.05 s for https://x/ds.pdf'])
    expect(files()).toEqual([])
  })

  it('a datasheet body that stalls times out too (no truncated file)', async () => {
    const stall: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('%PDF-1.4\n'))
          }
        }),
        { status: 200 }
      )
    const r = await libraryPut(lib, record(conn()), { datasheet: 'https://x/ds.pdf', fetchImpl: stall, timeoutMs: 50 })
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('timed out')
    expect(files()).toEqual([])
  })
})
