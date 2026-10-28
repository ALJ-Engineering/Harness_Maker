import { describe, it, expect } from 'vitest'
import { instantiateCable, instantiateConnector, instantiateFreeTerminal, instantiateSplice, partFromConnector, partFromFreeTerminal, partFromSplice } from './instantiate'
import { newLibraryPart, type LibraryPart } from './librarySchema'

const pin: LibraryPart = { ...newLibraryPart('pin', 'PN-0100'), description: 'Contact', manufacturer: 'TE' }
const housing: LibraryPart = {
  ...newLibraryPart('connector', 'PN-0001'),
  description: 'DT04-2P',
  manufacturer: 'TE',
  connector: { gender: 'male', cavities: [{ position: '1', defaultPin: 'PN-0100', defaultSeal: 'PN-9999' }, { position: '2' }] }
}
const resolve = (pn: string) => (pn === 'PN-0100' ? pin : undefined)
let n = 0
const newId = () => `id${++n}`

describe('instantiateConnector', () => {
  it('builds cavities from the template, resolving default parts where it can', () => {
    const c = instantiateConnector(housing, 'X7', resolve, newId)
    expect(c.designator).toBe('X7')
    expect(c.housing).toEqual({ partNumber: 'PN-0001', manufacturer: 'TE', description: 'DT04-2P' })
    expect(c.gender).toBe('male')
    expect(c.cavities).toHaveLength(2)
    expect(c.cavities[0]).toMatchObject({ position: '1', status: 'populated', pin: { partNumber: 'PN-0100', description: 'Contact', manufacturer: 'TE' }, seal: { partNumber: 'PN-9999' } })
    expect(c.cavities[1]).toMatchObject({ position: '2', status: 'populated' })
    expect(c.cavities[1].pin).toBeUndefined()
    expect(new Set(c.cavities.map((x) => x.id)).size).toBe(2)
  })
  it('gives fresh ids on each call', () => {
    const a = instantiateConnector(housing, 'X1', resolve, newId)
    const b = instantiateConnector(housing, 'X2', resolve, newId)
    expect(a.cavities[0].id).not.toBe(b.cavities[0].id)
  })
})

describe('terminal / splice', () => {
  it('carries kind and ref', () => {
    const t = instantiateFreeTerminal({ ...newLibraryPart('terminal', 'RING-M6'), description: 'Ring M6', terminal: { kind: 'ring', studMm: 6 } })
    expect(t).toEqual({ kind: 'ring', part: { partNumber: 'RING-M6', description: 'Ring M6' } })
    const s = instantiateSplice({ ...newLibraryPart('splice', 'SPL-1'), description: 'Butt', splice: { kind: 'weld' } })
    expect(s).toEqual({ kind: 'weld', part: { partNumber: 'SPL-1', description: 'Butt' } })
  })
  it('defaults kind when the record has no detail', () => {
    expect(instantiateFreeTerminal({ ...newLibraryPart('terminal', 'T'), terminal: undefined }).kind).toBe('ring')
    expect(instantiateSplice({ ...newLibraryPart('splice', 'S'), splice: undefined }).kind).toBe('butt')
  })
})

describe('partFrom*', () => {
  it('a factory lead goes into the document and back, an AWG size as its mm²', () => {
    const holder: LibraryPart = {
      ...newLibraryPart('connector', 'FH'),
      description: 'fuse holder',
      connector: { cavities: [{ position: '1', lead: { gaugeMm2: 2.08, color: 'RD', lengthMm: 203 } }] }
    }
    const c = { id: 'c', ...instantiateConnector(holder, 'F1', resolve, newId) }
    expect(c.cavities[0]).toMatchObject({ status: 'populated', lead: { gauge: { value: 2.08, unit: 'mm2' }, color: { base: 'RD' }, lengthMm: 203 } })
    expect(c.cavities[0].pin).toBeUndefined()
    expect(partFromConnector(c)!.connector!.cavities).toEqual([{ position: '1', lead: { gaugeMm2: 2.08, color: 'RD', lengthMm: 203 } }])
    c.cavities[0].lead = { gauge: { value: 14, unit: 'AWG' } }
    expect(partFromConnector(c)!.connector!.cavities[0].lead).toEqual({ gaugeMm2: 2.08 })
  })
  it('connector → part round-trips the template', () => {
    const c = { id: 'c', ...instantiateConnector(housing, 'X1', resolve, newId) }
    expect(partFromConnector(c)).toEqual({ ...housing, connector: { gender: 'male', cavities: [{ position: '1', defaultPin: 'PN-0100', defaultSeal: 'PN-9999' }, { position: '2' }] } })
  })
  it('returns null without a primary part number', () => {
    expect(partFromConnector({ id: 'c', designator: 'X1', cavities: [] })).toBeNull()
    expect(partFromFreeTerminal({ id: 't', designator: 'T1', kind: 'ring' })).toBeNull()
    expect(partFromSplice({ id: 's', designator: 'SP1', kind: 'butt' })).toBeNull()
  })
  it('terminal / splice carry kind', () => {
    expect(partFromFreeTerminal({ id: 't', designator: 'T1', kind: 'fork', part: { partNumber: 'F', description: 'Fork' } })).toMatchObject({ kind: 'terminal', partNumber: 'F', description: 'Fork', terminal: { kind: 'fork' } })
    expect(partFromSplice({ id: 's', designator: 'SP1', kind: 'clip', part: { partNumber: 'C' } })).toMatchObject({ kind: 'splice', partNumber: 'C', description: '', splice: { kind: 'clip' } })
  })
})

describe('instantiateCable', () => {
  const cable = {
    ...newLibraryPart('cable', 'MCB-1'),
    cable: { cores: [], shield: { drain: true }, jacketColor: 'BK' }
  }
  it('carries the PartRef, jacket and shield presence only', () => {
    expect(instantiateCable(cable, 'CAN-1')).toEqual({
      name: 'CAN-1',
      part: { partNumber: 'MCB-1', description: '' },
      jacketColor: 'BK',
      shield: { present: true }
    })
  })
  it('omits jacket and shield when the record has none', () => {
    expect(instantiateCable(newLibraryPart('cable', 'MCB-2'), 'C')).toEqual({
      name: 'C',
      part: { partNumber: 'MCB-2', description: '' }
    })
  })
})
