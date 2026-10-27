import { describe, it, expect } from 'vitest'
import { searchParts } from './search'
import { newLibraryPart, type LibraryPart } from './librarySchema'

function p(pn: string, kind: LibraryPart['kind'], description: string, extra: Partial<LibraryPart> = {}): LibraryPart {
  return { ...newLibraryPart(kind, pn), description, ...extra }
}
const parts = [
  p('PN-0200', 'seal', 'Wire seal green 1.6-2.2mm', { manufacturer: 'TE' }),
  p('PN-0001', 'connector', 'Deutsch DT04-2P receptacle', { manufacturer: 'TE'}),
  p('PN-0002', 'connector', 'Deutsch DT06-2S plug', { manufacturer: 'TE'}),
  p('RING-M6', 'terminal', 'Ring terminal M6', { manufacturer: 'Generic' })
]

describe('searchParts', () => {
  it('empty query returns everything, sorted by part number', () => {
    expect(searchParts(parts, '').map((x) => x.partNumber)).toEqual(['PN-0001', 'PN-0002', 'PN-0200', 'RING-M6'])
  })
  it('matches description and manufacturer case-insensitively', () => {
    expect(searchParts(parts, 'deutsch').map((x) => x.partNumber)).toEqual(['PN-0001', 'PN-0002'])
    expect(searchParts(parts, 'dt06').map((x) => x.partNumber)).toEqual(['PN-0002'])
    expect(searchParts(parts, 'generic').map((x) => x.partNumber)).toEqual(['RING-M6'])
  })
  it('ANDs whitespace-separated terms', () => {
    expect(searchParts(parts, 'deutsch plug').map((x) => x.partNumber)).toEqual(['PN-0002'])
    expect(searchParts(parts, 'deutsch zzz')).toEqual([])
  })
  it('ranks part-number prefix, then part-number substring, then other fields', () => {
    const more = [...parts, p('X-DT04', 'pin', 'contact'), p('DT04-X', 'pin', 'contact')]
    expect(searchParts(more, 'dt04').map((x) => x.partNumber)).toEqual(['DT04-X', 'X-DT04', 'PN-0001'])
  })
  it('filters by kinds', () => {
    expect(searchParts(parts, '', { kinds: ['terminal'] }).map((x) => x.partNumber)).toEqual(['RING-M6'])
    expect(searchParts(parts, 'te', { kinds: ['seal', 'connector'] })).toHaveLength(3)
  })
})
