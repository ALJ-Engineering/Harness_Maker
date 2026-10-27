import { describe, it, expect } from 'vitest'
import { computeNets } from './nets'
import { emptyDocument } from './document'
import type { HarnessDocument } from './schema'

const wire = (id: string, a: any, b: any): any => ({ id, ends: [a, b], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'RD' } })
const cav = (cavityId: string): any => ({ type: 'cavity', cavityId })
const sp = (spliceId: string): any => ({ type: 'splice', spliceId })

describe('computeNets', () => {
  it('groups wires joined at a shared splice into one net', () => {
    const d = emptyDocument()
    d.splices = [{ id: 's1', designator: 'SP1', kind: 'butt' }]
    d.wires = [wire('w1', cav('a'), sp('s1')), wire('w2', sp('s1'), cav('b'))]
    const nets = computeNets(d)
    expect(nets).toHaveLength(1)
    expect(nets[0].wireIds.sort()).toEqual(['w1', 'w2'])
  })

  it('keeps unconnected wires in separate nets', () => {
    const d = emptyDocument()
    d.wires = [wire('w1', cav('a'), cav('b')), wire('w2', cav('c'), cav('d'))]
    expect(computeNets(d)).toHaveLength(2)
  })

  it('merges the two ends of a cable shield into one conductor', () => {
    const d = emptyDocument()
    d.cables = [{ id: 'cab', name: 'CAN', coreWireIds: [], shield: { present: true, drainWireId: 'wd' } }]
    d.wires = [
      wire('wa', cav('x'), { type: 'shield', cableId: 'cab', end: 'a' }),
      wire('wb', cav('y'), { type: 'shield', cableId: 'cab', end: 'b' })
    ]
    // both shield ends are one conductor → wa and wb share a net
    expect(computeNets(d)).toHaveLength(1)
  })
})
