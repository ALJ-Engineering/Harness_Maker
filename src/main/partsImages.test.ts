import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { imageSize } from './imageSize'
import { SYMLINK_SKIP, trySymlink } from './testSymlink'
import { join } from 'path'
import {
  sanitisePartNumber,
  resolveForPart,
  resolveImageFile,
  listImages,
  importImage,
  removeImage,
  imageDataUrl,
  imageHref,
  readHeader
} from './partsImages'

/** A hand-built 2 x 3 PNG: signature + a complete IHDR chunk header. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0,
  3, 8, 6, 0, 0, 0, 0, 0, 0, 0
])

/**
 * A JPEG whose SOF0 sits behind an APP1 segment of `pad` filler bytes — a real
 * camera file puts EXIF/ICC there, which is exactly why a header sniff has to
 * read more than the first few bytes. 5 x 7 px.
 */
function jpegWithPadding(pad: number): Uint8Array {
  const appLen = pad + 2 // the length word counts itself
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x07, 0x00, 0x05, 0x03]
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, (appLen >> 8) & 0xff, appLen & 0xff,
    ...new Array(pad).fill(0),
    ...sof,
    ...new Array(9).fill(0) // the rest of the SOF0 body
  ])
}

describe('partsImages', () => {
  it('sanitises part numbers', () => {
    expect(sanitisePartNumber('39-01-3045')).toBe('39-01-3045')
    expect(sanitisePartNumber('a/b:c d')).toBe('a_b_c_d')
    expect(sanitisePartNumber('../x')).toBe('.._x')
  })

  it('imageHref encodes', () => expect(imageHref('A&B/C')).toBe('parts-image://img/A%26B%2FC'))

  it('lists, imports, serves, removes, and guards paths', async ({ skip }) => {
    const dir = await mkdtemp(join(tmpdir(), 'hi-'))
    const out = await mkdtemp(join(tmpdir(), 'ho-'))
    try {
      await writeFile(join(dir, 'HSG-A.png'), PNG)
      await writeFile(join(dir, 'notes.txt'), 'x')
      expect(await listImages(dir)).toEqual({
        'HSG-A': { file: 'HSG-A.png', pxW: 2, pxH: 3, mtimeMs: expect.any(Number) }
      })

      await writeFile(join(out, 'src.png'), PNG)
      expect(await importImage(dir, 'X/1', join(out, 'src.png'))).toEqual({
        file: 'X_1.png',
        pxW: 2,
        pxH: 3,
        mtimeMs: expect.any(Number)
      })
      expect(Object.keys(await listImages(dir)).sort()).toEqual(['HSG-A', 'X_1'])

      expect(await imageDataUrl(dir, 'HSG-A')).toMatch(/^data:image\/png;base64,/)
      expect(await imageDataUrl(dir, 'HSG-A', 10)).toBeNull() // over the byte cap

      expect(await resolveForPart(dir, 'X/1')).toMatch(/X_1\.png$/)

      await writeFile(join(out, 'bad.png'), new Uint8Array([1, 2, 3]))
      await expect(importImage(dir, 'BAD', join(out, 'bad.png'))).rejects.toThrow()
      // A renderer-supplied src is checked before it is read: a directory (and
      // by the same isFile() test /dev/zero or a FIFO) never reaches readFile.
      await expect(importImage(dir, 'DIR', out)).rejects.toThrow('Not a regular file')
      await expect(importImage(dir, 'BIG', join(out, 'src.png'), 10)).rejects.toThrow()
      expect(Object.keys(await listImages(dir)).sort()).toEqual(['HSG-A', 'X_1'])

      expect(await resolveImageFile(dir, '../ho/src.png')).toBeNull()
      expect(await resolveImageFile(dir, '/etc/hosts')).toBeNull()
      await mkdir(join(dir, 'sub'))
      await writeFile(join(dir, 'sub', 'deep.png'), PNG)
      expect(await resolveImageFile(dir, 'sub/deep.png')).toBeNull() // the library is flat

      expect(await removeImage(dir, 'X_1')).toBe(true)
      expect(await removeImage(dir, 'X_1')).toBe(false)

      // Last, because it may skip the rest of the test (see testSymlink.ts).
      if (!(await trySymlink(join(out, 'src.png'), join(dir, 'LINK.png')))) return skip(SYMLINK_SKIP)
      expect(await resolveImageFile(dir, 'LINK.png')).toBeNull() // realpath escapes dir
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it('listImages reports each file mtime, and it moves when the file is replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hm-'))
    const out = await mkdtemp(join(tmpdir(), 'hn-'))
    try {
      await writeFile(join(out, 'src.png'), PNG)
      await importImage(dir, 'P1', join(out, 'src.png'))

      const first = (await listImages(dir))['P1']
      expect(typeof first.mtimeMs).toBe('number')
      expect(first.mtimeMs).toBeGreaterThan(0)
      // It is the real file mtime — that is what makes the `?v=` move.
      expect(first.mtimeMs).toBe((await stat(join(dir, 'P1.png'))).mtimeMs)

      // Age the library file, then re-import over it: the listed mtime must
      // follow the new copy, or the renderer's cache-busting href would not
      // change and Chromium would keep painting the previous bitmap.
      const old = new Date(Date.now() - 86_400_000)
      await utimes(join(dir, 'P1.png'), old, old)
      const aged = (await listImages(dir))['P1'].mtimeMs
      expect(aged).toBeLessThan(first.mtimeMs)

      await importImage(dir, 'P1', join(out, 'src.png'))
      expect((await listImages(dir))['P1'].mtimeMs).toBeGreaterThan(aged)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it('readHeader reads at most `bytes`, and nothing at all from a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hh-'))
    try {
      await writeFile(join(dir, 'P.png'), PNG)
      expect((await readHeader(join(dir, 'P.png'), 8)).length).toBe(8)
      // Shorter than the window ⇒ the whole file, never a zero-padded buffer.
      expect((await readHeader(join(dir, 'P.png'))).length).toBe(PNG.length)
      expect((await readHeader(join(dir, 'nope.png'))).length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('listImages sizes a JPEG whose SOF sits far behind the first bytes (I4)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hj-'))
    try {
      // 60 KiB of EXIF-shaped filler: well past a naive 24-byte sniff, well
      // inside the 128 KiB window listImages reads.
      const jpg = jpegWithPadding(60 * 1024)
      await writeFile(join(dir, 'CAM.jpg'), jpg)
      expect((await listImages(dir))['CAM']).toMatchObject({ file: 'CAM.jpg', pxW: 5, pxH: 7 })
      // The window is a real bound, not decoration: cut it below the SOF and
      // the sizer legitimately sees nothing.
      expect(imageSize(await readHeader(join(dir, 'CAM.jpg'), 64))).toBeNull()
      expect(imageSize(await readHeader(join(dir, 'CAM.jpg')))).toMatchObject({ w: 5, h: 7 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('imageDataUrl rejects an over-cap file on its SIZE, before reading it (I4)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hk-'))
    try {
      await writeFile(join(dir, 'BIG.png'), PNG)
      // The stat happens first, so the decision needs no bytes in memory; the
      // observable part is that the answer is still null at the boundary.
      expect(await imageDataUrl(dir, 'BIG', PNG.length - 1)).toBeNull()
      expect(await imageDataUrl(dir, 'BIG', PNG.length)).toMatch(/^data:image\/png;base64,/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
