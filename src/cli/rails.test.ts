import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newLibraryPart, type LibraryPart } from '@shared/parts/librarySchema'
import { incompleteReasons } from './rails'
import { full, makeLibrary as makeLib } from './testLibrary'
import { openLibrary } from './session'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-rails-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const makeLibrary = (parts: LibraryPart[], withDatasheets: string[]) => makeLib(tmp, parts, withDatasheets)

const conn = (pin?: string): LibraryPart => {
  const c = full(newLibraryPart('connector', 'HSG-1'))
  c.connector = { cavities: [{ position: '1', ...(pin ? { defaultPin: pin } : {}) }] }
  return c
}

describe('incompleteReasons', () => {
  it('complete connector with complete pin', async () => {
    const lib = await makeLibrary([conn('PIN-1'), full(newLibraryPart('pin', 'PIN-1'))], ['HSG-1', 'PIN-1'])
    expect(incompleteReasons('HSG-1', lib, 'connector')).toEqual([])
  })
  it('names the pin lacking a datasheet', async () => {
    const lib = await makeLibrary([conn('PIN-1'), full(newLibraryPart('pin', 'PIN-1'))], ['HSG-1'])
    expect(incompleteReasons('HSG-1', lib)).toEqual(['HSG-1: default pin PIN-1 — no datasheet file'])
  })
  it('unknown pn, wrong kind, missing manufacturer', async () => {
    const lib = await makeLibrary([newLibraryPart('pin', 'PIN-1')], ['PIN-1'])
    expect(incompleteReasons('NOPE', lib)).toEqual(['NOPE: not in library'])
    expect(incompleteReasons('PIN-1', lib, 'connector')).toContain('PIN-1: is a pin, expected connector')
    expect(incompleteReasons('PIN-1', lib)).toContain('PIN-1: missing manufacturer')
  })
  it('empty cable, cavity-less connector and gauge-less wire are incomplete', async () => {
    const w = full(newLibraryPart('wire', 'W-1'))
    const lib = await makeLibrary(
      [full(newLibraryPart('cable', 'C-1')), full(newLibraryPart('connector', 'H-0')), w],
      ['C-1', 'H-0', 'W-1']
    )
    expect(incompleteReasons('C-1', lib)).toEqual(['C-1: cable has no cores'])
    expect(incompleteReasons('H-0', lib)).toEqual(['H-0: connector has no cavities'])
    expect(incompleteReasons('W-1', lib)).toEqual(['W-1: wire has no gauge'])
  })
  it('recurses into a cavity default seal', async () => {
    const c = full(newLibraryPart('connector', 'HSG-1'))
    c.connector = { cavities: [{ position: '1', defaultSeal: 'SEAL-1' }] }
    const lib = await makeLibrary([c, { ...newLibraryPart('seal', 'SEAL-1'), datasheetUrl: 'https://x/s.pdf' }], ['HSG-1', 'SEAL-1'])
    expect(incompleteReasons('HSG-1', lib)).toEqual(['HSG-1: default seal SEAL-1 — missing manufacturer'])
  })
  it('a record without a datasheet URL is incomplete', async () => {
    const p = { ...newLibraryPart('pin', 'PIN-1'), manufacturer: 'TE' }
    const lib = await makeLibrary([p], ['PIN-1'])
    expect(incompleteReasons('PIN-1', lib)).toEqual(['PIN-1: missing datasheet URL'])
  })
  it('terminates on a pin/seal reference cycle', async () => {
    const a = full(newLibraryPart('connector', 'A'))
    a.connector = { cavities: [{ position: '1', defaultPin: 'B' }] }
    const b = full(newLibraryPart('connector', 'B'))
    b.connector = { cavities: [{ position: '1', defaultPin: 'A' }] }
    const lib = await makeLibrary([a, b], ['A', 'B'])
    // Terminates (no infinite recursion); a connector named as a default pin is a kind error.
    expect(incompleteReasons('A', lib)).toEqual([
      'A: default pin B — is a connector, expected pin',
      'A: default pin B — default pin A — is a connector, expected pin'
    ])
  })
  it('a cable with cores and a wire with a gauge are complete', async () => {
    const cab = full(newLibraryPart('cable', 'C-1'))
    cab.cable = { cores: [{ name: '1', color: 'WH', gauge: { value: 0.5, unit: 'mm2' } }] }
    const w = full(newLibraryPart('wire', 'W-1'))
    w.wire = { gauge: { value: 0.5, unit: 'mm2' } }
    const lib = await makeLibrary([cab, w], ['C-1', 'W-1'])
    expect(incompleteReasons('C-1', lib, 'cable')).toEqual([])
    expect(incompleteReasons('W-1', lib, 'wire')).toEqual([])
  })
  it('a slash part number with its datasheet imported is complete', async () => {
    const lib = await makeLibrary([full(newLibraryPart('pin', '39-01/3045'))], ['39-01/3045'])
    expect(incompleteReasons('39-01/3045', lib, 'pin')).toEqual([])
  })
  it('reports a pin shared by many cavities once', async () => {
    const c = full(newLibraryPart('connector', 'HSG-3'))
    c.connector = { cavities: ['1', '2', '3'].map((position) => ({ position, defaultPin: 'PIN-1' })) }
    const lib = await makeLibrary([c, full(newLibraryPart('pin', 'PIN-1'))], ['HSG-3'])
    expect(incompleteReasons('HSG-3', lib)).toEqual(['HSG-3: default pin PIN-1 — no datasheet file'])
  })
})

describe('incompleteReasons — default pin/seal kinds (final review I1)', () => {
  const housing = (cav: { defaultPin?: string; defaultSeal?: string }): LibraryPart => {
    const c = full(newLibraryPart('connector', 'HSG-K'))
    c.connector = { cavities: [{ position: '1', ...cav }] }
    return c
  }
  const wire = (): LibraryPart => {
    const w = full(newLibraryPart('wire', 'W-1'))
    w.wire = { gauge: { value: 0.5, unit: 'mm2' } }
    return w
  }
  const others = (): LibraryPart[] => [
    wire(),
    full(newLibraryPart('plug', 'PLUG-1')),
    full(newLibraryPart('pin', 'PIN-1')),
    full(newLibraryPart('seal', 'SEAL-1'))
  ]
  const all = ['HSG-K', 'W-1', 'PLUG-1', 'PIN-1', 'SEAL-1']

  it('a wire or a plug record as the default pin is incomplete, naming the kind', async () => {
    const lib = await makeLibrary([housing({ defaultPin: 'W-1' }), ...others()], all)
    expect(incompleteReasons('HSG-K', lib, 'connector')).toEqual(['HSG-K: default pin W-1 — is a wire, expected pin'])
    rmSync(join(tmp, 'lib'), { recursive: true, force: true })
    const lib2 = await makeLibrary([housing({ defaultPin: 'PLUG-1' }), ...others()], all)
    expect(incompleteReasons('HSG-K', lib2, 'connector')).toEqual(['HSG-K: default pin PLUG-1 — is a plug, expected pin'])
  })
  it('a connector or a plug record as the default seal is incomplete, naming the kind', async () => {
    const other = full(newLibraryPart('connector', 'HSG-O'))
    other.connector = { cavities: [{ position: '1' }] }
    const lib = await makeLibrary([housing({ defaultSeal: 'HSG-O' }), other, ...others()], [...all, 'HSG-O'])
    expect(incompleteReasons('HSG-K', lib, 'connector')).toEqual(['HSG-K: default seal HSG-O — is a connector, expected seal'])
    rmSync(join(tmp, 'lib'), { recursive: true, force: true })
    const lib2 = await makeLibrary([housing({ defaultSeal: 'PLUG-1' }), ...others()], all)
    expect(incompleteReasons('HSG-K', lib2, 'connector')).toEqual(['HSG-K: default seal PLUG-1 — is a plug, expected seal'])
  })
  it('pin and seal swapped: both reported', async () => {
    const lib = await makeLibrary([housing({ defaultPin: 'SEAL-1', defaultSeal: 'PIN-1' }), ...others()], all)
    expect(incompleteReasons('HSG-K', lib, 'connector')).toEqual([
      'HSG-K: default pin SEAL-1 — is a seal, expected pin',
      'HSG-K: default seal PIN-1 — is a pin, expected seal'
    ])
  })
  it('correct kinds are complete', async () => {
    const lib = await makeLibrary([housing({ defaultPin: 'PIN-1', defaultSeal: 'SEAL-1' }), ...others()], all)
    expect(incompleteReasons('HSG-K', lib, 'connector')).toEqual([])
  })
})

describe('incompleteReasons — an unreadable record file (final review I2)', () => {
  it('a default pin whose record file will not parse is "present but unreadable", not "not in library"', async () => {
    const c = full(newLibraryPart('connector', 'HSG-1'))
    c.connector = { cavities: [{ position: '1', defaultPin: 'PIN-1' }] }
    await makeLibrary([c], ['HSG-1'])
    writeFileSync(join(tmp, 'lib', 'parts', 'PIN-1.json'), '{"partNumber": "PIN-1", "ki')
    const lib = await openLibrary(join(tmp, 'lib'))
    const r = incompleteReasons('HSG-1', lib)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/^HSG-1: default pin PIN-1 — present but unreadable: /)
  })
})
