import { describe, it, expect } from 'vitest'
import { StubCatalog, defaultStubCatalog, LibraryCatalog } from './catalog'
import { newLibraryPart } from './librarySchema'
import { runDrc } from '../drc'
import { emptyDocument } from '../model/document'

describe('StubCatalog', () => {
  it('resolves a known part to its catalog entry', () => {
    const c = new StubCatalog([{ partNumber: 'HSG-1', description: 'Deutsch DT 2-way', manufacturer: 'TE' }])
    expect(c.resolve('HSG-1')?.description).toBe('Deutsch DT 2-way')
  })
  it('returns undefined for an unknown part', () => {
    expect(new StubCatalog([]).resolve('NOPE')).toBeUndefined()
  })
  it('the bundled default catalog is non-empty', () => {
    expect(defaultStubCatalog().resolve(defaultStubCatalog()['entries'][0].partNumber)).toBeDefined()
  })
})

describe('LibraryCatalog', () => {
  const parts = [
    { ...newLibraryPart('connector', 'PN-0001'), description: 'DT04-2P', manufacturer: 'TE' },
    { ...newLibraryPart('pin', 'PN-0100'), description: 'Contact 16-20' }
  ]
  it('resolves to a CatalogEntry with the kind as category', () => {
    const c = new LibraryCatalog(parts)
    expect(c.resolve('PN-0001')).toEqual({ partNumber: 'PN-0001', manufacturer: 'TE', description: 'DT04-2P', category: 'connector' })
    expect(c.resolve('nope')).toBeUndefined()
    expect(c.part('PN-0100')?.kind).toBe('pin')
  })

  it('runDrc flags an unresolved PartRef, a stale one, and nothing for a matching ref (spec §8)', () => {
    const catalog = new LibraryCatalog(parts)

    const unresolved = emptyDocument()
    unresolved.connectors = [
      { id: 'c1', designator: 'X1', housing: { partNumber: 'GHOST' }, cavities: [] }
    ]
    expect(runDrc(unresolved, catalog).filter((f) => f.ruleId === 'stale-or-unresolved-partref')).toHaveLength(1)

    const stale = emptyDocument()
    stale.connectors = [
      { id: 'c1', designator: 'X1', housing: { partNumber: 'PN-0001', description: 'WRONG CACHED NAME' }, cavities: [] }
    ]
    expect(runDrc(stale, catalog).filter((f) => f.ruleId === 'stale-or-unresolved-partref')).toHaveLength(1)

    const matching = emptyDocument()
    matching.connectors = [
      { id: 'c1', designator: 'X1', housing: { partNumber: 'PN-0001', description: 'DT04-2P' }, cavities: [] }
    ]
    expect(runDrc(matching, catalog).filter((f) => f.ruleId === 'stale-or-unresolved-partref')).toHaveLength(0)
  })
})
