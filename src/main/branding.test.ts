import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logoDataUrl } from './branding'

/** A hand-built 2 x 3 PNG: signature + a complete IHDR chunk header. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0,
  3, 8, 6, 0, 0, 0, 0, 0, 0, 0
])
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

describe('logoDataUrl', () => {
  let lib: string
  beforeEach(async () => {
    lib = await mkdtemp(join(tmpdir(), 'logo-'))
  })
  afterEach(async () => {
    await rm(lib, { recursive: true, force: true })
  })

  it('is null with no branding folder, or an empty one', async () => {
    expect(await logoDataUrl(lib)).toBeNull()
    await mkdir(join(lib, 'branding'))
    expect(await logoDataUrl(lib)).toBeNull()
  })

  it('inlines branding/logo.png as a PNG data URI', async () => {
    await mkdir(join(lib, 'branding'))
    await writeFile(join(lib, 'branding', 'logo.png'), PNG)
    expect(await logoDataUrl(lib)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
  })

  it('inlines branding/logo.svg as an SVG data URI', async () => {
    await mkdir(join(lib, 'branding'))
    await writeFile(join(lib, 'branding', 'logo.svg'), SVG)
    expect(await logoDataUrl(lib)).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`)
  })

  it('prefers svg over png when both exist', async () => {
    await mkdir(join(lib, 'branding'))
    await writeFile(join(lib, 'branding', 'logo.png'), PNG)
    await writeFile(join(lib, 'branding', 'logo.svg'), SVG)
    expect(await logoDataUrl(lib)).toMatch(/^data:image\/svg\+xml;/)
  })

  it('rejects a file whose bytes do not match its extension', async () => {
    await mkdir(join(lib, 'branding'))
    await writeFile(join(lib, 'branding', 'logo.png'), 'not a png')
    expect(await logoDataUrl(lib)).toBeNull()
    await writeFile(join(lib, 'branding', 'logo.svg'), 'plain text')
    expect(await logoDataUrl(lib)).toBeNull()
  })

  it('rejects a file over the size cap, and a symlink out of the library', async () => {
    await mkdir(join(lib, 'branding'))
    await writeFile(join(lib, 'branding', 'logo.png'), PNG)
    expect(await logoDataUrl(lib, 10)).toBeNull()
    await rm(join(lib, 'branding', 'logo.png'))
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    await writeFile(join(outside, 'x.png'), PNG)
    await symlink(join(outside, 'x.png'), join(lib, 'branding', 'logo.png'))
    expect(await logoDataUrl(lib)).toBeNull()
    await rm(outside, { recursive: true, force: true })
  })
})
