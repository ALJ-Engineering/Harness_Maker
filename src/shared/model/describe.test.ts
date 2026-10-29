import { describe, it, expect } from 'vitest'
import { describeEndpoint, describeSleeving, sleevingRef } from './describe'
import { demoDocument } from './document'

describe('describeEndpoint designators', () => {
  it('leads a terminal with its designator', () => {
    expect(describeEndpoint(demoDocument(), { type: 'freeTerminal', terminalId: 'ft-bplus' })).toBe(
      'T1 ring → B+ stud'
    )
  })

  it('leads a splice with its designator', () => {
    const d = demoDocument()
    d.splices = [{ id: 's2', designator: 'SP2', kind: 'butt' }]
    expect(describeEndpoint(d, { type: 'splice', spliceId: 's2' })).toBe('SP2 (butt)')
  })
})

describe('sleeving names', () => {
  it('describes a sleeve by type, size and colour, leaving out what is blank', () => {
    expect(describeSleeving({ sleevingType: 'pvc', size: '5mm', color: 'BK' })).toBe('PVC tube 5mm BK')
    expect(describeSleeving({ sleevingType: 'heatshrink', size: ' 9.5/4.8 ' })).toBe('Heat shrink 9.5/4.8')
    expect(describeSleeving({ sleevingType: 'braided', color: '' })).toBe('Braided sleeve')
  })

  it('numbers sleeves SL1, SL2 … in document order', () => {
    const d = demoDocument()
    const span = { segmentIds: [d.segments[0].id] }
    d.sleeving = [
      { id: 'a', target: { type: 'wire', wireId: d.wires[0].id }, span, sleevingType: 'pvc' },
      { id: 'b', target: { type: 'wire', wireId: d.wires[0].id }, span, sleevingType: 'heatshrink' }
    ]
    expect(sleevingRef(d, 'b')).toBe('SL2')
    expect(sleevingRef(d, 'nope')).toBe('SL?')
  })
})
