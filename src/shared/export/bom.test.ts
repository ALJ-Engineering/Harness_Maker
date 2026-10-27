import { describe, it, expect } from 'vitest'
import {
  computeBom,
  computeCutList,
  bomToCsv,
  cutListToCsv,
  computeTreatmentLines,
  computeMarkerList,
  bomItemsForParts
} from './bom'
import { emptyDocument } from '../model/document'
import type { HarnessDocument } from '../model/schema'

/** A small harness exercising every part-bearing field. */
function sampleDoc(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    {
      id: 'c1',
      designator: 'X1',
      housing: { partNumber: 'HSG-A' },
      cavities: [
        { id: 'cav1', position: '1', status: 'populated', pin: { partNumber: 'PIN-1' } },
        {
          id: 'cav2',
          position: '2',
          status: 'populated',
          pin: { partNumber: 'PIN-1' },
          seal: { partNumber: 'SEAL-1' }
        },
        { id: 'cav3', position: '3', status: 'plugged', plug: { partNumber: 'PLUG-1' } }
      ]
    },
    {
      id: 'c2',
      designator: 'X2',
      housing: { partNumber: 'HSG-A' },
      cavities: [{ id: 'cav4', position: 'A', status: 'populated', pin: { partNumber: 'PIN-1' } }]
    }
  ]
  d.freeTerminals = [{ id: 'ft1', designator: 'T1', kind: 'ring', part: { partNumber: 'RING-6' }, landsOn: 'B+ stud' }]
  d.splices = [{ id: 'sp1', designator: 'SP1', kind: 'butt', part: { partNumber: 'SPL-1' } }]
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'cav1' },
        { type: 'cavity', cavityId: 'cav4' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' },
      spec: { partNumber: 'WIRE-05' },
      specifiedLengthMm: 250
    },
    {
      id: 'w2',
      ends: [
        { type: 'cavity', cavityId: 'cav2' },
        { type: 'freeTerminal', terminalId: 'ft1' }
      ],
      gauge: { value: 2.5, unit: 'mm2' },
      color: { base: 'BK', stripes: ['WH'] }
    }
  ]
  return d
}

describe('computeBom', () => {
  it('aggregates duplicate part numbers within a category and sums quantity', () => {
    const bom = computeBom(sampleDoc())
    const housing = bom.find((l) => l.category === 'connector housing' && l.partNumber === 'HSG-A')
    expect(housing?.quantity).toBe(2)
    const pins = bom.find((l) => l.category === 'pin' && l.partNumber === 'PIN-1')
    expect(pins?.quantity).toBe(3)
  })

  it('walks every part-bearing field (seal, plug, terminal, splice, wire spec)', () => {
    const bom = computeBom(sampleDoc())
    const cats = (pn: string): string[] => bom.filter((l) => l.partNumber === pn).map((l) => l.category)
    expect(cats('SEAL-1')).toEqual(['seal'])
    expect(cats('PLUG-1')).toEqual(['plug'])
    expect(cats('RING-6')).toEqual(['free terminal'])
    expect(cats('SPL-1')).toEqual(['splice'])
    expect(cats('WIRE-05')).toEqual(['wire'])
  })

  it('omits entities that carry no part reference', () => {
    const d = emptyDocument()
    d.splices = [{ id: 's', designator: 'SP1', kind: 'butt' }] // no part
    expect(computeBom(d)).toHaveLength(0)
  })
})

describe('computeCutList', () => {
  it('produces one row per wire with resolved endpoints', () => {
    const rows = computeCutList(sampleDoc())
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      ref: 'W1',
      from: 'X1.1',
      to: 'X2.A',
      gauge: '0.5 mm2',
      colour: 'RD',
      lengthMm: 250
    })
  })

  it('leaves length null when no length is specified, and shows stripes', () => {
    const rows = computeCutList(sampleDoc())
    expect(rows[1].lengthMm).toBeNull()
    expect(rows[1].colour).toBe('BK/WH')
  })
})

describe('CSV serialization', () => {
  it('emits a header row and escapes commas/quotes', () => {
    const d = emptyDocument()
    d.connectors = [
      {
        id: 'c1',
        designator: 'X1',
        housing: { partNumber: 'H,1', description: 'a "big" one' },
        cavities: []
      }
    ]
    const csv = bomToCsv(computeBom(d))
    const lines = csv.trim().split('\n')
    expect(lines[0]).toContain('partNumber')
    expect(lines[1]).toContain('"H,1"')
    expect(lines[1]).toContain('"a ""big"" one"')
  })

  it('cut-list CSV renders blank for unspecified length', () => {
    const rows = computeCutList(sampleDoc())
    const csv = cutListToCsv(rows)
    // header, W1, W2 — W2 has no length; columns: ref,from,to,gauge,colour,lengthMm,lengthSource,notes
    const cols = csv.trim().split('\n')[2].split(',')
    expect(cols[0]).toBe('W2')
    expect(cols[5]).toBe('') // length column blank
  })
})

describe('cut list length provenance', () => {
  it('reports derived length + source from the route', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'c1', designator: 'X1', cavities: [{ id: 'cav1', position: '1', status: 'populated' }] },
      { id: 'c2', designator: 'X2', cavities: [{ id: 'cav2', position: 'A', status: 'populated' }] }
    ]
    d.placements = [
      { refId: 'c1', pos: { x: 0, y: 0 } },
      { refId: 'c2', pos: { x: 30, y: 40 } } // 50mm
    ]
    d.wires = [
      { id: 'w1', ends: [{ type: 'cavity', cavityId: 'cav1' }, { type: 'cavity', cavityId: 'cav2' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'RD' } }
    ]
    d.segments = [
      { id: 'seg1', from: { type: 'body', refId: 'c1' }, to: { type: 'body', refId: 'c2' } }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
    const row = computeCutList(d)[0]
    expect(row.lengthMm).toBeCloseTo(50)
    expect(row.lengthSource).toBe('derived')
  })

  it('marks an unrouted wire unknown (null), not zero', () => {
    const d = emptyDocument()
    d.wires = [
      { id: 'w1', ends: [{ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'y' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } }
    ]
    const row = computeCutList(d)[0]
    expect(row.lengthMm).toBeNull()
    expect(row.lengthSource).toBe('unknown')
  })
})

// ─── Helper: doc with a placed segment of known length (3-4-5 triangle = 50mm) ───

function docWithSegment(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    { id: 'c1', designator: 'X1', cavities: [{ id: 'cav1', position: '1', status: 'populated' }] },
    { id: 'c2', designator: 'X2', cavities: [{ id: 'cav2', position: 'A', status: 'populated' }] }
  ]
  d.placements = [
    { refId: 'c1', pos: { x: 0, y: 0 } },
    { refId: 'c2', pos: { x: 30, y: 40 } } // 50mm
  ]
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'cav1' },
        { type: 'cavity', cavityId: 'cav2' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' }
    }
  ]
  d.segments = [
    {
      id: 'seg1',
      from: { type: 'body', refId: 'c1' },
      to: { type: 'body', refId: 'c2' }
    }
  ]
  d.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
  return d
}

describe('computeTreatmentLines', () => {
  it('returns a sleeving treatment with length derived from the span', () => {
    const d = docWithSegment()
    d.sleeving = [
      {
        id: 'sl1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg1'] },
        sleevingType: 'heatshrink'
      }
    ]
    const lines = computeTreatmentLines(d)
    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('sleeving')
    expect(lines[0].ref).toBe('sl1')
    expect(lines[0].description).toContain('heatshrink')
    expect(lines[0].lengthMm).toBeCloseTo(50)
    expect(lines[0].part).toBeUndefined()
  })

  it('includes size in sleeving description when set', () => {
    const d = docWithSegment()
    d.sleeving = [
      {
        id: 'sl2',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg1'] },
        sleevingType: 'braided',
        size: '6mm'
      }
    ]
    const lines = computeTreatmentLines(d)
    expect(lines[0].description).toContain('braided')
    expect(lines[0].description).toContain('6mm')
  })

  it('includes part number when sleeving has a part ref', () => {
    const d = docWithSegment()
    d.sleeving = [
      {
        id: 'sl3',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg1'] },
        sleevingType: 'pvc',
        part: { partNumber: 'SLV-001' }
      }
    ]
    const lines = computeTreatmentLines(d)
    expect(lines[0].part).toBe('SLV-001')
  })

  it('returns a twist treatment with description "twist" and the span length', () => {
    const d = docWithSegment()
    d.twists = [
      {
        id: 'tw1',
        wireIds: ['w1'],
        span: { segmentIds: ['seg1'] }
      }
    ]
    const lines = computeTreatmentLines(d)
    expect(lines).toHaveLength(1)
    expect(lines[0].kind).toBe('twist')
    expect(lines[0].ref).toBe('tw1')
    expect(lines[0].description).toBe('twist')
    expect(lines[0].lengthMm).toBeCloseTo(50)
  })

  it('includes the lay length in the twist description when set', () => {
    const d = docWithSegment()
    d.twists = [
      {
        id: 'tw1',
        wireIds: ['w1', 'w2'],
        span: { segmentIds: ['seg1'] },
        layLengthMm: 25
      }
    ]
    const lines = computeTreatmentLines(d)
    expect(lines[0].description).toBe('twist (lay 25 mm)')
  })

  it('returns null length when segment is unplaced', () => {
    const d = emptyDocument()
    d.segments = [
      {
        id: 'seg-unplaced',
        from: { type: 'body', refId: 'no-such-body' },
        to: { type: 'body', refId: 'no-such-body2' }
      }
    ]
    d.sleeving = [
      {
        id: 'sl-null',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg-unplaced'] },
        sleevingType: 'tape'
      }
    ]
    const lines = computeTreatmentLines(d)
    expect(lines[0].lengthMm).toBeNull()
  })

  it('returns empty array for a doc with no treatments', () => {
    expect(computeTreatmentLines(emptyDocument())).toHaveLength(0)
  })
})

describe('computeMarkerList', () => {
  it('returns a marker row for a wireMarker label targeting a wire', () => {
    const d = docWithSegment()
    d.labels = [
      {
        id: 'lbl1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'wireMarker',
        text: 'CAN-HI',
        pos: { x: 0, y: 0 }
      }
    ]
    const rows = computeMarkerList(d)
    expect(rows).toHaveLength(1)
    expect(rows[0].wireRef).toBe('W1')
    expect(rows[0].text).toBe('CAN-HI')
    expect(rows[0].kind).toBe('wireMarker')
  })

  it('returns a marker row for heatshrinkPrint label', () => {
    const d = docWithSegment()
    d.labels = [
      {
        id: 'lbl2',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'heatshrinkPrint',
        text: 'GND',
        pos: { x: 0, y: 0 }
      }
    ]
    const rows = computeMarkerList(d)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('heatshrinkPrint')
  })

  it('excludes callout labels', () => {
    const d = docWithSegment()
    d.labels = [
      {
        id: 'lbl3',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'callout',
        text: 'note here',
        pos: { x: 0, y: 0 }
      }
    ]
    expect(computeMarkerList(d)).toHaveLength(0)
  })

  it('excludes flag labels', () => {
    const d = docWithSegment()
    d.labels = [
      {
        id: 'lbl4',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'flag',
        text: 'flag text',
        pos: { x: 0, y: 0 }
      }
    ]
    expect(computeMarkerList(d)).toHaveLength(0)
  })

  it('uses empty wireRef for non-wire targets', () => {
    const d = emptyDocument()
    d.segments = [{ id: 'seg1', from: { type: 'branch', branchId: 'bp1' }, to: { type: 'branch', branchId: 'bp2' } }]
    d.labels = [
      {
        id: 'lbl5',
        target: { type: 'branch', segmentId: 'seg1' },
        kind: 'wireMarker',
        text: 'label on branch',
        pos: { x: 0, y: 0 }
      }
    ]
    const rows = computeMarkerList(d)
    expect(rows).toHaveLength(1)
    expect(rows[0].wireRef).toBe('')
  })

  it('returns empty array for a doc with no labels', () => {
    expect(computeMarkerList(emptyDocument())).toHaveLength(0)
  })
})

describe('BOM length-based lines (review fixes)', () => {
  it('aggregates wire length (Σ) as unit "m" and flags partialLength on an unknown contributor', () => {
    const d = docWithSegment() // w1 routed = 50 mm
    d.wires[0].spec = { partNumber: 'WIRE-05' }
    d.wires.push({
      id: 'w2', // same spec but UNROUTED → unknown-length contributor
      ends: [
        { type: 'cavity', cavityId: 'cav1' },
        { type: 'cavity', cavityId: 'cav2' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' },
      spec: { partNumber: 'WIRE-05' }
    })
    const line = computeBom(d).find((l) => l.category === 'wire' && l.partNumber === 'WIRE-05')!
    expect(line.unit).toBe('m')
    expect(line.quantity).toBe(2)
    expect(line.lengthMm).toBeCloseTo(50) // only the routed wire is summed
    expect(line.partialLength).toBe(true) // the unrouted one makes the Σ an undercount
  })

  it('all-known → partialLength false; all-unknown → lengthMm null (still unit m)', () => {
    const known = docWithSegment()
    known.wires[0].spec = { partNumber: 'W-A' }
    const a = computeBom(known).find((l) => l.partNumber === 'W-A')!
    expect(a.lengthMm).toBeCloseTo(50)
    expect(a.partialLength).toBe(false)

    const unknown = emptyDocument()
    unknown.wires = [
      {
        id: 'w',
        ends: [
          { type: 'cavity', cavityId: 'x' },
          { type: 'cavity', cavityId: 'y' }
        ],
        gauge: { value: 1, unit: 'mm2' },
        color: { base: 'RD' },
        spec: { partNumber: 'W-B' }
      }
    ]
    const b = computeBom(unknown).find((l) => l.partNumber === 'W-B')!
    expect(b.unit).toBe('m')
    expect(b.lengthMm).toBeNull()
    expect(b.partialLength).toBe(false)
  })

  it('skips cable cores in the wire BOM and represents the cable by its jacket length', () => {
    const d = emptyDocument()
    d.cables = [
      {
        id: 'cab',
        name: 'CAN-1',
        part: { partNumber: 'CAB-CAN' },
        coreWireIds: ['core1', 'core2'],
        specifiedLengthMm: 1200
      }
    ]
    d.wires = [
      { id: 'core1', cableId: 'cab', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' }], gauge: { value: 0.34, unit: 'mm2' }, color: { base: 'WH' }, spec: { partNumber: 'CORE-W' } },
      { id: 'core2', cableId: 'cab', ends: [{ type: 'cavity', cavityId: 'c' }, { type: 'cavity', cavityId: 'd' }], gauge: { value: 0.34, unit: 'mm2' }, color: { base: 'BU' }, spec: { partNumber: 'CORE-W' } }
    ]
    const bom = computeBom(d)
    expect(bom.find((l) => l.category === 'wire')).toBeUndefined() // core spec never feeds the BOM
    const cable = bom.find((l) => l.category === 'cable')!
    expect(cable.partNumber).toBe('CAB-CAN')
    expect(cable.unit).toBe('m')
    expect(cable.lengthMm).toBeCloseTo(1200)
  })

  it('adds a length-based sleeving line and a discrete branch-tie line', () => {
    const d = docWithSegment()
    d.sleeving = [
      {
        id: 'sl',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg1'] },
        sleevingType: 'braided',
        part: { partNumber: 'SLV-6' }
      }
    ]
    d.branchPoints = [{ id: 'bp', pos: { x: 0, y: 0 }, tie: { partNumber: 'TIE-1' } }]
    const bom = computeBom(d)
    const slv = bom.find((l) => l.category === 'sleeving')!
    expect(slv).toMatchObject({ partNumber: 'SLV-6', unit: 'm' })
    expect(slv.lengthMm).toBeCloseTo(50)
    const tie = bom.find((l) => l.category === 'branch tie')!
    expect(tie).toMatchObject({ partNumber: 'TIE-1', unit: 'ea', quantity: 1 })
  })
})

describe('cut list: cable cores + cable rows (review fixes)', () => {
  it('excludes cores, emits one cable row, keeps W-numbers contiguous', () => {
    const d = emptyDocument()
    d.wires = [
      { id: 'wA', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'RD' } },
      { id: 'core', cableId: 'cab', ends: [{ type: 'cavity', cavityId: 'c' }, { type: 'cavity', cavityId: 'd' }], gauge: { value: 0.34, unit: 'mm2' }, color: { base: 'WH' } },
      { id: 'wB', ends: [{ type: 'cavity', cavityId: 'e' }, { type: 'cavity', cavityId: 'f' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } }
    ]
    d.cables = [{ id: 'cab', name: 'CAN-1', coreWireIds: ['core'], jacketColor: 'BK', shield: { present: true }, specifiedLengthMm: 800 }]
    const rows = computeCutList(d)
    expect(rows.filter((r) => r.ref.startsWith('W')).map((r) => r.ref)).toEqual(['W1', 'W2'])
    const cableRow = rows.find((r) => r.ref === 'CAN-1')!
    expect(cableRow.lengthMm).toBe(800)
    expect(cableRow.lengthSource).toBe('specified')
    expect(cableRow.notes).toContain('1 core')
    expect(cableRow.notes).toContain('shielded')
  })

  it('cable with no specified length → unknown row', () => {
    const d = emptyDocument()
    d.cables = [{ id: 'cab', name: 'CAN-2', coreWireIds: [] }]
    const row = computeCutList(d).find((r) => r.ref === 'CAN-2')!
    expect(row.lengthMm).toBeNull()
    expect(row.lengthSource).toBe('unknown')
    expect(row.notes).toContain('0 cores')
  })
})

describe('cut-length allowance (review fix)', () => {
  it('folds addLengthMm into a derived cut length and reports the allowance portion', () => {
    const d = docWithSegment() // 50 mm derived
    d.wires[0].addLengthMm = 30
    const row = computeCutList(d)[0]
    expect(row.lengthMm).toBeCloseTo(80)
    expect(row.lengthSource).toBe('derived')
    expect(row.addLengthMm).toBe(30)
  })

  it('ignores allowance when specifiedLengthMm overrides', () => {
    const d = docWithSegment()
    d.wires[0].addLengthMm = 30
    d.wires[0].specifiedLengthMm = 200
    const row = computeCutList(d)[0]
    expect(row.lengthMm).toBe(200)
    expect(row.lengthSource).toBe('specified')
    expect(row.addLengthMm).toBeUndefined()
  })
})

describe('bundle loom tape BOM line', () => {
  it('emits a length-based "loom tape" line for a bundle with a part', () => {
    const d = docWithSegment()
    d.bundles = [
      { id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'], part: { partNumber: 'TAPE-19' } }
    ]
    const line = computeBom(d).find((l) => l.category === 'loom tape')!
    expect(line).toMatchObject({ partNumber: 'TAPE-19', unit: 'm', quantity: 1 })
    expect(line.lengthMm).toBeCloseTo(50)
    expect(line.partialLength).toBe(false)
  })

  it('groups two bundles sharing a part into one line with summed length', () => {
    const d = docWithSegment()
    d.bundles = [
      { id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'], part: { partNumber: 'TAPE-19' } },
      { id: 'bn2', segmentIds: ['seg1'], memberWireIds: ['w1'], part: { partNumber: 'TAPE-19' } }
    ]
    const lines = computeBom(d).filter((l) => l.category === 'loom tape')
    expect(lines).toHaveLength(1)
    expect(lines[0].quantity).toBe(2)
    expect(lines[0].lengthMm).toBeCloseTo(100)
  })

  it('produces no line for a bundle without a part (unchanged behaviour)', () => {
    const d = docWithSegment()
    d.bundles = [{ id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'] }]
    expect(computeBom(d).some((l) => l.category === 'loom tape')).toBe(false)
  })

  it('flags partialLength when one contributing bundle is unresolved', () => {
    const d = docWithSegment()
    d.bundles = [
      { id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'], part: { partNumber: 'TAPE-19' } },
      { id: 'bn2', segmentIds: ['ghost'], memberWireIds: ['w1'], part: { partNumber: 'TAPE-19' } }
    ]
    const line = computeBom(d).find((l) => l.category === 'loom tape')!
    expect(line.lengthMm).toBeCloseTo(50)
    expect(line.partialLength).toBe(true)
  })

  it('shows the loom-tape line in the BOM CSV', () => {
    const d = docWithSegment()
    d.bundles = [
      { id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'], part: { partNumber: 'TAPE-19' } }
    ]
    const csv = bomToCsv(computeBom(d))
    expect(csv).toContain('loom tape,TAPE-19')
  })
})

describe('BomLine.item', () => {
  function docWithParts(): HarnessDocument {
    const d = emptyDocument()
    d.connectors.push({
      id: 'c1',
      designator: 'C1',
      housing: { partNumber: 'HSG-A' },
      cavities: [
        { id: 'cv1', position: '1', status: 'populated', pin: { partNumber: 'PIN-A' } },
        {
          id: 'cv2',
          position: '2',
          status: 'populated',
          pin: { partNumber: 'PIN-A' },
          seal: { partNumber: 'SEAL-A' }
        }
      ]
    })
    d.freeTerminals.push({ id: 'ft1', designator: 'T1', kind: 'ring', part: { partNumber: 'RING-A' } })
    d.splices.push({ id: 'sp1', designator: 'SP1', kind: 'butt', part: { partNumber: 'SPL-A' } })
    return d
  }

  it('numbers lines 1..n in output order', () => {
    const lines = computeBom(docWithParts())
    expect(lines.map((l) => l.item)).toEqual(lines.map((_, i) => i + 1))
    expect(lines.length).toBe(5)
  })

  it('is stable across two computations of the same document', () => {
    const d = docWithParts()
    expect(computeBom(d).map((l) => [l.item, l.partNumber])).toEqual(
      computeBom(d).map((l) => [l.item, l.partNumber])
    )
  })

  it('bomItemsForParts returns sorted, deduped items for the given part numbers', () => {
    const lines = computeBom(docWithParts())
    const byPn = new Map(lines.map((l) => [l.partNumber, l.item]))
    // A connector body lists housing + its pins' parts + seals. PIN-A appears twice → once.
    const items = bomItemsForParts(lines, ['SEAL-A', 'PIN-A', 'HSG-A', 'PIN-A'])
    expect(items).toEqual(
      [byPn.get('HSG-A'), byPn.get('PIN-A'), byPn.get('SEAL-A')].sort((a, b) => a! - b!)
    )
    expect(bomItemsForParts(lines, [])).toEqual([])
    expect(bomItemsForParts(lines, ['NOPE'])).toEqual([])
  })
})

describe('typed segment length in the BOM', () => {
  it('cut list, sleeving line and loom tape line use the typed length', () => {
    const d = docWithSegment() // seg1 drawn 50 mm
    d.segments[0].specifiedLengthMm = 120
    d.sleeving = [
      { id: 'sl1', target: { type: 'wire', wireId: 'w1' }, span: { segmentIds: ['seg1'] }, sleevingType: 'heatshrink', part: { partNumber: 'SLV-1' } }
    ]
    d.bundles = [{ id: 'bn1', wireIds: ['w1'], segmentIds: ['seg1'], part: { partNumber: 'TAPE-1' } }] as never
    expect(computeCutList(d).find((r) => r.sourceId === 'w1')!.lengthMm).toBe(120)
    expect(computeTreatmentLines(d)[0].lengthMm).toBe(120)
    const bom = computeBom(d)
    expect(bom.find((l) => l.category === 'sleeving')!.lengthMm).toBe(120)
    expect(bom.find((l) => l.category === 'loom tape')!.lengthMm).toBe(120)
  })
})
