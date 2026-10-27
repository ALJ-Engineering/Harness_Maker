import { describe, it, expect } from 'vitest'
import { describeEndpoint } from './describe'
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
