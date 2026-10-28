import { describe, it, expect } from 'vitest'
import { describeLead, gaugeMm2, leadAt, sameGauge, wireLead } from './leads'
import { emptyDocument } from './document'
import type { HarnessDocument, Wire } from './schema'
import { runDrc } from '../drc'
import { computeBom, computeCutList } from '../export/bom'
import { wiringTable } from '../print/tableData'

const RD_LEAD = { gauge: { value: 2.08, unit: 'mm2' as const }, color: { base: 'RD' }, lengthMm: 203 }

/**
 * F1 is an in-line fuse holder with factory leads on 1 and 2; X1 an ordinary
 * connector. W1 runs from F1's lead 1 to X1.1 and is `length` mm long.
 */
function holder(wire: Partial<Wire> = {}, length = 150): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    {
      id: 'f1',
      designator: 'F1',
      housing: { partNumber: 'FHAS101' },
      cavities: [
        { id: 'f1-1', position: '1', status: 'populated', lead: RD_LEAD },
        { id: 'f1-2', position: '2', status: 'populated', lead: RD_LEAD }
      ]
    },
    {
      id: 'x1',
      designator: 'X1',
      cavities: [{ id: 'x1-1', position: '1', status: 'populated', pin: { partNumber: 'PIN-1' } }]
    }
  ]
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'f1-1' },
        { type: 'cavity', cavityId: 'x1-1' }
      ],
      gauge: { value: 2.08, unit: 'mm2' },
      color: { base: 'RD' },
      specifiedLengthMm: length,
      ...wire
    }
  ]
  return d
}
const rules = (d: HarnessDocument, ruleId: string) => runDrc(d).filter((f) => f.ruleId === ruleId)

describe('lead helpers', () => {
  it('converts AWG to mm² and compares sizes to within 10 %', () => {
    expect(gaugeMm2({ value: 14, unit: 'AWG' })).toBeCloseTo(2.08, 2)
    expect(gaugeMm2({ value: 2.5, unit: 'mm2' })).toBe(2.5)
    expect(sameGauge({ value: 14, unit: 'AWG' }, { value: 2, unit: 'mm2' })).toBe(true)
    expect(sameGauge({ value: 14, unit: 'AWG' }, { value: 2.5, unit: 'mm2' })).toBe(false)
  })

  it('describes what is known about a lead', () => {
    expect(describeLead(RD_LEAD)).toBe('2.08 mm² RD, 203 mm')
    expect(describeLead({ color: { base: 'GN', stripes: ['YE'] } })).toBe('GN/YE')
    expect(describeLead({})).toBe('')
  })

  it('finds the lead at a cavity and on a wire, by either end', () => {
    const d = holder()
    expect(leadAt(d, { type: 'cavity', cavityId: 'f1-2' })).toEqual({ lead: RD_LEAD, label: 'F1.2' })
    expect(leadAt(d, { type: 'cavity', cavityId: 'x1-1' })).toBeNull()
    expect(wireLead(d, d.wires[0])?.label).toBe('F1.1')
    d.wires[0].ends.reverse()
    expect(wireLead(d, d.wires[0])?.label).toBe('F1.1')
  })
})

describe('a factory lead in DRC', () => {
  it('asks for no pin on a lead, and finds nothing wrong with a wire that matches it', () => {
    const d = holder()
    expect(rules(d, 'populated-without-pin')).toEqual([])
    expect(runDrc(d).filter((f) => /lead/.test(f.ruleId))).toEqual([])
  })

  it('a pinless cavity without a lead is still flagged', () => {
    const d = holder()
    delete d.connectors[0].cavities[1].lead
    expect(rules(d, 'populated-without-pin').map((f) => f.message)).toEqual([
      'Cavity F1.2 is populated but has no pin PartRef'
    ])
  })

  it('a wire longer than the lead needs more wire spliced on', () => {
    expect(rules(holder({}, 450), 'wire-longer-than-lead')).toEqual([
      {
        ruleId: 'wire-longer-than-lead',
        severity: 'warning',
        message: "The wire on F1.1's factory lead runs 450 mm, but the lead is 203 mm: splice on more wire",
        refs: [{ kind: 'wire', id: 'w1' }]
      }
    ])
    expect(rules(holder({}, 203), 'wire-longer-than-lead')).toEqual([])
  })

  it('a wire whose size or colour is not the lead is flagged; the same size in AWG is not', () => {
    expect(rules(holder({ gauge: { value: 2.5, unit: 'mm2' }, color: { base: 'BK' } }), 'wire-differs-from-lead')[0].message).toBe(
      "The wire on F1.1's factory lead is 2.5 mm² and is BK, but the lead is 2.08 mm² RD, 203 mm"
    )
    expect(rules(holder({ gauge: { value: 14, unit: 'AWG' } }), 'wire-differs-from-lead')).toEqual([])
  })

  it('a wire on a lead with its own wire part is flagged: the BOM leaves it out', () => {
    expect(rules(holder({ spec: { partNumber: 'W-25' } }), 'lead-wire-has-part')[0].message).toBe(
      "The wire on F1.1's factory lead has wire part W-25, which the BOM leaves out: the lead comes with the part"
    )
  })
})

describe('a factory lead in the BOM and tables', () => {
  it('the lead is not bought as wire, and no contact is listed for it', () => {
    const lines = computeBom(holder({ spec: { partNumber: 'W-25' } }))
    expect(lines.map((l) => `${l.category} ${l.partNumber}`)).toEqual(['connector housing FHAS101', 'pin PIN-1'])
  })

  it('the cut list says which lead the wire is cut from', () => {
    expect(computeCutList(holder({ notes: 'heat-shrink' }))[0].notes).toBe('factory lead of F1.1 (203 mm); heat-shrink')
  })

  it('the wiring table names the lead where a contact would be', () => {
    expect(wiringTable(holder()).rows[0].fromContactPn).toBe('factory lead')
  })
})
