import { describe, it, expect } from 'vitest'
import {
  LIBRARY_VERSION,
  parseLibraryPart,
  serializeLibraryPart,
  refOf,
  newLibraryPart,
  type LibraryCableCore,
  type LibraryPart
} from './librarySchema'

const housing: LibraryPart = {
  libraryVersion: LIBRARY_VERSION,
  partNumber: 'PN-0001',
  kind: 'connector',
  description: 'Deutsch DT04-2P receptacle',
  manufacturer: 'TE',
  connector: {
    gender: 'male',
    cavities: [
      { position: '1', defaultPin: 'PN-0100', defaultSeal: 'PN-0200' },
      { position: '2', defaultPin: 'PN-0100' }
    ]
  }
}

describe('parseLibraryPart', () => {
  it('round-trips through serialize', () => {
    const r = parseLibraryPart(serializeLibraryPart(housing))
    expect(r).toEqual({ part: housing })
  })

  it('rejects non-JSON and non-objects', () => {
    expect(parseLibraryPart('nope')).toHaveProperty('error')
    expect(parseLibraryPart('[]')).toHaveProperty('error')
    expect(parseLibraryPart('null')).toHaveProperty('error')
  })

  it('requires partNumber, kind and description', () => {
    expect(parseLibraryPart(JSON.stringify({ kind: 'pin', description: 'x' }))).toHaveProperty('error')
    expect(parseLibraryPart(JSON.stringify({ partNumber: 'A', description: 'x' }))).toHaveProperty('error')
    expect(parseLibraryPart(JSON.stringify({ partNumber: 'A', kind: 'pin' }))).toHaveProperty('error')
    expect(parseLibraryPart(JSON.stringify({ partNumber: 'A', kind: 'bogus', description: 'x' }))).toHaveProperty('error')
  })

  it('drops unknown keys and fills libraryVersion', () => {
    const r = parseLibraryPart(JSON.stringify({ partNumber: 'A', kind: 'pin', description: 'x', junk: 1 }))
    expect(r).toEqual({ part: { libraryVersion: LIBRARY_VERSION, partNumber: 'A', kind: 'pin', description: 'x' } })
  })

  it('rejects a connector without cavities, or with duplicate positions', () => {
    const noCav = { ...housing, connector: { gender: 'male' } }
    expect(parseLibraryPart(JSON.stringify(noCav))).toHaveProperty('error')
    const dup = { ...housing, connector: { cavities: [{ position: '1' }, { position: '1' }] } }
    expect(parseLibraryPart(JSON.stringify(dup))).toHaveProperty('error')
  })

  it('rejects a non-string cavity position', () => {
    const bad = { ...housing, connector: { cavities: [{ position: 1 }] } }
    expect(parseLibraryPart(JSON.stringify(bad))).toHaveProperty('error')
  })

  it('drops kind detail that does not belong to the kind', () => {
    const r = parseLibraryPart(JSON.stringify({ partNumber: 'A', kind: 'pin', description: 'x', connector: { cavities: [] } }))
    expect(r).toEqual({ part: { libraryVersion: LIBRARY_VERSION, partNumber: 'A', kind: 'pin', description: 'x' } })
  })

  it('rejects when the file stem does not match the part number', () => {
    expect(parseLibraryPart(serializeLibraryPart(housing), 'PN-0001')).toEqual({ part: housing })
    expect(parseLibraryPart(serializeLibraryPart(housing), 'other')).toHaveProperty('error')
  })

  it('accepts a part number with characters the stem sanitises', () => {
    const p = { ...housing, partNumber: '39-01/3045' }
    expect(parseLibraryPart(serializeLibraryPart(p), '39-01_3045')).toEqual({ part: p })
  })
})

describe('refOf / newLibraryPart', () => {
  it('refOf carries only the three PartRef fields', () => {
    expect(refOf(housing)).toEqual({ partNumber: 'PN-0001', manufacturer: 'TE', description: 'Deutsch DT04-2P receptacle' })
    expect(refOf({ ...housing, manufacturer: undefined })).toEqual({ partNumber: 'PN-0001', description: 'Deutsch DT04-2P receptacle' })
  })
  it('newLibraryPart seeds kind detail for connector/terminal/splice', () => {
    expect(newLibraryPart('connector', 'X').connector).toEqual({ cavities: [] })
    expect(newLibraryPart('terminal', 'X').terminal).toEqual({ kind: 'ring' })
    expect(newLibraryPart('splice', 'X').splice).toEqual({ kind: 'butt' })
    expect(newLibraryPart('seal', 'X')).toEqual({ libraryVersion: LIBRARY_VERSION, partNumber: 'X', kind: 'seal', description: '' })
  })
})

describe('cable block (library 1.1.0)', () => {
  const can: LibraryPart = {
    libraryVersion: LIBRARY_VERSION,
    partNumber: 'MCB-0001',
    kind: 'cable',
    description: 'CAN twisted pair',
    cable: {
      cores: [
        { name: 'CAN_H', color: 'WH', gauge: { value: 0.5, unit: 'mm2' }, pair: 'A' },
        { name: 'CAN_L', color: 'GN', gauge: { value: 0.5, unit: 'mm2' }, pair: 'A' }
      ],
      shield: { drain: true }
    }
  }
  const withCable = (cable: unknown): string => JSON.stringify({ ...can, cable })
  const core: LibraryCableCore = { name: '1', color: 'BK', gauge: { value: 1, unit: 'mm2' } }

  it('is library 1.1.0', () => {
    expect(LIBRARY_VERSION).toBe('1.1.0')
    expect(JSON.parse(serializeLibraryPart(can)).libraryVersion).toBe('1.1.0')
  })
  it('round-trips a CAN cable unchanged', () => {
    expect(parseLibraryPart(serializeLibraryPart(can))).toEqual({ part: can })
  })
  it('keeps stripes and jacketColor', () => {
    const p: LibraryPart = {
      ...can,
      cable: { cores: [{ ...core, stripes: ['YE'] }], jacketColor: 'BK' }
    }
    expect(parseLibraryPart(serializeLibraryPart(p))).toEqual({ part: p })
  })
  it('a cable record with no cable block parses with empty cores', () => {
    const r = parseLibraryPart(JSON.stringify({ libraryVersion: '1.0.0', partNumber: 'MCB-1', kind: 'cable', description: 'old' }))
    expect(r).toEqual({ part: { libraryVersion: '1.1.0', partNumber: 'MCB-1', kind: 'cable', description: 'old', cable: { cores: [] } } })
  })
  it('accepts empty cores but rejects non-array cores', () => {
    expect('part' in parseLibraryPart(withCable({ cores: [] }))).toBe(true)
    expect(parseLibraryPart(withCable({ cores: 'x' }))).toEqual({ error: 'cable.cores must be an array' })
  })
  it('shield round-trips: drain false stays, absent stays absent', () => {
    const f: LibraryPart = { ...can, cable: { cores: can.cable!.cores, shield: { drain: false } } }
    expect(parseLibraryPart(serializeLibraryPart(f))).toEqual({ part: f })
    const n: LibraryPart = { ...can, cable: { cores: can.cable!.cores } }
    const r = parseLibraryPart(serializeLibraryPart(n))
    expect('part' in r && r.part.cable && 'shield' in r.part.cable).toBe(false)
  })
  it('rejects duplicate core names', () => {
    expect(parseLibraryPart(withCable({ cores: [core, core] }))).toEqual({ error: 'duplicate core name "1"' })
  })
  it('rejects incomplete cores', () => {
    const msg = { error: 'each core needs a name, a color and a gauge' }
    expect(parseLibraryPart(withCable({ cores: [{ ...core, name: '' }] }))).toEqual(msg)
    expect(parseLibraryPart(withCable({ cores: [{ ...core, color: '' }] }))).toEqual(msg)
    expect(parseLibraryPart(withCable({ cores: [{ ...core, gauge: { value: 1, unit: 'cm' } }] }))).toEqual(msg)
    expect(parseLibraryPart(withCable({ cores: [{ name: 'x', color: 'BK' }] }))).toEqual(msg)
  })
  it('1.0.0 wire record without cable parses as before', () => {
    const w = { libraryVersion: '1.0.0', partNumber: 'W1', kind: 'wire', description: 'w', wire: { gauge: { value: 1, unit: 'mm2' } } }
    expect(parseLibraryPart(JSON.stringify(w))).toEqual({ part: { ...w, libraryVersion: '1.1.0' } })
  })
  it('newLibraryPart(cable) starts empty and round-trips', () => {
    const p = newLibraryPart('cable', 'MCB-9')
    expect(p.cable).toEqual({ cores: [] })
    expect(parseLibraryPart(serializeLibraryPart(p))).toEqual({ part: p })
  })
})
