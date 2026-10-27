import { describe, it, expect } from 'vitest'
import {
  bodyKey,
  bodyNode,
  endpointBodyId,
  endpointBodyKey,
  endpointHandleId,
  parseHandleId,
  sameEndpoint
} from './endpoints'
import { emptyDocument } from './document'
import type { Endpoint } from './schema'

const eps: Endpoint[] = [
  { type: 'cavity', cavityId: 'cav-1' },
  { type: 'freeTerminal', terminalId: 'ft-1' },
  { type: 'splice', spliceId: 'sp-1' },
  { type: 'shield', cableId: 'cab-1', end: 'a' }
]

describe('endpoint keys', () => {
  it('roundtrips every endpoint kind', () => {
    for (const ep of eps) expect(parseHandleId(endpointHandleId(ep))).toEqual(ep)
  })
  it('sameEndpoint compares by key', () => {
    expect(sameEndpoint(eps[0], { ...eps[0] })).toBe(true)
    expect(sameEndpoint(eps[0], eps[1])).toBe(false)
  })
  it('returns null for an unknown handle', () => {
    expect(parseHandleId('bogus:1')).toBeNull()
  })
})

describe('body keys', () => {
  const d = emptyDocument()
  d.connectors.push({
    id: 'c1',
    designator: 'C1',
    cavities: [{ id: 'cv1', position: '1', status: 'populated' }]
  })
  d.freeTerminals.push({ id: 'ft1', designator: 'T1', kind: 'ring' })
  d.splices.push({ id: 'sp1', designator: 'SP1', kind: 'butt' })

  it('bodyKey / bodyNode', () => {
    expect(bodyKey('c1')).toBe('n:c1')
    expect(bodyNode('c1')).toEqual({ type: 'body', refId: 'c1' })
  })
  it('endpointBodyId resolves the owner for all four kinds', () => {
    expect(endpointBodyId(d, { type: 'cavity', cavityId: 'cv1' })).toBe('c1')
    expect(endpointBodyId(d, { type: 'freeTerminal', terminalId: 'ft1' })).toBe('ft1')
    expect(endpointBodyId(d, { type: 'splice', spliceId: 'sp1' })).toBe('sp1')
    expect(endpointBodyId(d, { type: 'shield', cableId: 'cab1', end: 'a' })).toBe('cab1')
    expect(endpointBodyId(d, { type: 'cavity', cavityId: 'nope' })).toBeNull()
  })
  it('endpointBodyKey is n:<owner> or null', () => {
    expect(endpointBodyKey(d, { type: 'cavity', cavityId: 'cv1' })).toBe('n:c1')
    expect(endpointBodyKey(d, { type: 'cavity', cavityId: 'nope' })).toBeNull()
  })
})
