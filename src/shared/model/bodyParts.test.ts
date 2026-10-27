import { describe, it, expect } from 'vitest'
import { emptyDocument } from './document'
import { bodyKindOf, bodyPartNumbers, primaryPartNumber } from './bodyParts'

function doc() {
  const d = emptyDocument()
  d.connectors.push({
    id: 'c1',
    designator: 'C1',
    housing: { partNumber: 'HSG' },
    cavities: [
      {
        id: 'cv1',
        position: '1',
        status: 'populated',
        pin: { partNumber: 'PIN' },
        seal: { partNumber: 'SEAL' }
      },
      { id: 'cv2', position: '2', status: 'plugged', plug: { partNumber: 'PLUG' } },
      { id: 'cv3', position: '3', status: 'populated', pin: { partNumber: 'PIN' } }
    ]
  })
  d.freeTerminals.push({
    id: 'ft1',
    designator: 'T1',
    kind: 'ring',
    part: { partNumber: 'RING' },
    seal: { partNumber: 'HS' }
  })
  d.splices.push({ id: 'sp1', designator: 'SP1', kind: 'butt', part: { partNumber: 'SPL' } })
  d.splices.push({ id: 'sp2', designator: 'SP2', kind: 'weld' })
  return d
}

describe('bodyParts', () => {
  it('connector: housing, then pins/seals/plugs, deduped, in cavity display order', () => {
    expect(bodyPartNumbers(doc(), 'c1')).toEqual(['HSG', 'PIN', 'SEAL', 'PLUG'])
    expect(primaryPartNumber(doc(), 'c1')).toBe('HSG')
  })
  it('terminal: part + seal; splice: part', () => {
    expect(bodyPartNumbers(doc(), 'ft1')).toEqual(['RING', 'HS'])
    expect(primaryPartNumber(doc(), 'ft1')).toBe('RING')
    expect(bodyPartNumbers(doc(), 'sp1')).toEqual(['SPL'])
    expect(bodyPartNumbers(doc(), 'sp2')).toEqual([])
    expect(primaryPartNumber(doc(), 'sp2')).toBeUndefined()
  })
  it('bodyKindOf', () => {
    expect(bodyKindOf(doc(), 'c1')).toBe('connector')
    expect(bodyKindOf(doc(), 'ft1')).toBe('terminal')
    expect(bodyKindOf(doc(), 'sp1')).toBe('splice')
    expect(bodyKindOf(doc(), 'zz')).toBeNull()
  })
})
