import { describe, it, expect } from 'vitest'
import { runDrc } from './index'
import { emptyDocument, demoDocument, brokenDemoDocument } from '../model/document'
import { StubCatalog } from '../parts/catalog'
import { parseDocumentWithNotes } from '../model/serialize'
import { produce } from 'immer'
import { applyRescaleSegment } from '../model/rescale'
import type { HarnessDocument } from '../model/schema'

const ids = (doc: any, ruleId: string) => runDrc(doc).filter((f) => f.ruleId === ruleId)

describe('DRC structural rules', () => {
  it('clean demo has no errors', () => {
    expect(runDrc(demoDocument()).filter((f) => f.severity === 'error')).toHaveLength(0)
  })

  it('flags a populated cavity with no wires', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', cavities: [{ id: 'cav1', position: '1', status: 'populated' }] }]
    expect(ids(d, 'unconnected-populated-cavity')).toHaveLength(1)
  })

  it('flags a splice with fewer than two wires', () => {
    const d = emptyDocument()
    d.splices = [{ id: 's1', designator: 'SP1', kind: 'butt' }]
    d.wires = [{ id: 'w', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'splice', spliceId: 's1' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'RD' } }]
    expect(ids(d, 'splice-degree')).toHaveLength(1)
  })

  it('flags a wire whose BOTH ends are the same splice as splice-degree 1 (self-loop)', () => {
    const d = emptyDocument()
    d.splices = [{ id: 's1', designator: 'SP1', kind: 'butt' }]
    d.wires = [{ id: 'w', ends: [{ type: 'splice', spliceId: 's1' }, { type: 'splice', spliceId: 's1' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'RD' } }]
    const f = ids(d, 'splice-degree')
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain('1 wire(s)')
  })

  it('flags a self-loop segment and does NOT let it pass branchpoint-degree', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    d.segments = [
      { id: 'loop', from: { type: 'branch', branchId: 'bp1' }, to: { type: 'branch', branchId: 'bp1' } }
    ]
    expect(ids(d, 'self-loop-segment')).toHaveLength(1)
    expect(ids(d, 'branchpoint-degree')).toHaveLength(1)
  })

  it('no self-loop-segment finding on a clean document', () => {
    expect(ids(demoDocument(), 'self-loop-segment')).toHaveLength(0)
  })

  it('flags a segment end that names no body, and no false positive on the demo', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'c1', designator: 'X1', cavities: [{ id: 'a', position: '1', status: 'populated' }] }
    ]
    d.branchPoints = [{ id: 'bp1', pos: { x: 10, y: 0 } }]
    d.segments = [
      { id: 'good', from: { type: 'body', refId: 'c1' }, to: { type: 'branch', branchId: 'bp1' } },
      { id: 'bad', from: { type: 'body', refId: 'ghost' }, to: { type: 'branch', branchId: 'bp1' } }
    ]
    const f = ids(d, 'unresolved-route-node')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('error')
    expect(f[0].message).toBe('Segment bad references a missing body ghost')
    expect(f[0].refs).toEqual([{ kind: 'segment', id: 'bad' }])
    expect(ids(demoDocument(), 'unresolved-route-node')).toHaveLength(0)
  })

  it('flags a segment end that names no branch point', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    d.segments = [
      {
        id: 'seg',
        from: { type: 'branch', branchId: 'bp1' },
        to: { type: 'branch', branchId: 'gone' }
      }
    ]
    const f = ids(d, 'unresolved-route-node')
    expect(f).toHaveLength(1)
    expect(f[0].message).toBe('Segment seg references a missing branch point gone')
  })

  it("reports the migration's `missing:` sentinel from a 0.3 file with an unknown cavity", () => {
    // The 0.3 → 0.4 migration deliberately keeps a sentinel refId rather than
    // inventing a body (serialize.ts) — that sentinel is only meaningful if a
    // rule actually reports it.
    const legacy = {
      schemaVersion: '0.3.0',
      connectors: [
        { id: 'c1', designator: 'X1', cavities: [{ id: 'a', position: '1', status: 'populated' }] }
      ],
      freeTerminals: [],
      splices: [],
      wires: [],
      cables: [],
      drawing: { units: 'mm' },
      placements: [{ refId: 'c1', pos: { x: 0, y: 0 } }],
      branchPoints: [],
      segments: [
        {
          id: 'seg',
          from: { type: 'endpoint', endpoint: { type: 'cavity', cavityId: 'a' } },
          to: { type: 'endpoint', endpoint: { type: 'cavity', cavityId: 'nobody-owns-this' } }
        }
      ],
      wireRoutes: [],
      bundles: [],
      sleeving: [],
      twists: [],
      labels: []
    }
    const { doc } = parseDocumentWithNotes(JSON.stringify(legacy))
    const f = ids(doc, 'unresolved-route-node')
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain('missing:')
    expect(f[0].refs).toEqual([{ kind: 'segment', id: 'seg' }])
  })

  it('flags a cable shield with no drain', () => {
    const d = emptyDocument()
    d.cables = [{ id: 'cab', name: 'CAN', coreWireIds: [], shield: { present: true } }]
    expect(ids(d, 'shield-without-drain')).toHaveLength(1)
  })

  it('flags an unrouted wire', () => {
    const d = emptyDocument()
    d.wires = [{ id: 'w', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'RD' } }]
    expect(ids(d, 'unrouted-wire')).toHaveLength(1)
  })

  it('a same-body jumper with no route is a WARNING, and a specified length clears it', () => {
    // A jumper between two cavities of ONE connector has no limb to route
    // along (both ends land on the same dot), so it can never be geometry-
    // derived — it is a prompt for a length, not a routing error.
    const d = emptyDocument()
    d.connectors = [
      {
        id: 'c1',
        designator: 'X1',
        cavities: [
          { id: 'a', position: '1', status: 'populated' },
          { id: 'b', position: '2', status: 'populated' }
        ]
      }
    ]
    d.wires = [
      {
        id: 'w',
        ends: [
          { type: 'cavity', cavityId: 'a' },
          { type: 'cavity', cavityId: 'b' }
        ],
        gauge: { value: 1, unit: 'mm2' },
        color: { base: 'RD' }
      }
    ]
    const f = ids(d, 'unrouted-wire')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('warning')
    expect(f[0].message).toBe('Wire w is a jumper within one body — set a specified length (mm)')

    d.wires[0].specifiedLengthMm = 50
    expect(ids(d, 'unrouted-wire')).toHaveLength(0)

    // Two DIFFERENT real bodies with no route is still an ERROR — the downgrade
    // is about ends on the SAME body, not about ends that resolve at all.
    delete d.wires[0].specifiedLengthMm
    d.connectors.push({
      id: 'c2',
      designator: 'X2',
      cavities: [{ id: 'c', position: '1', status: 'populated' }]
    })
    d.wires[0].ends = [
      { type: 'cavity', cavityId: 'a' },
      { type: 'cavity', cavityId: 'c' }
    ]
    const g = ids(d, 'unrouted-wire')
    expect(g).toHaveLength(1)
    expect(g[0].severity).toBe('error')
    expect(g[0].message).toBe('Wire w has no valid route (length unknown)')
  })

  it('the broken demo doc triggers multiple distinct rules', () => {
    const found = new Set(runDrc(brokenDemoDocument()).map((f) => f.ruleId))
    expect(found.size).toBeGreaterThanOrEqual(4)
  })
})

describe('DRC net + group + partref rules', () => {
  it('flags gauge mismatch within a net joined by a splice', () => {
    const d = emptyDocument()
    d.splices = [{ id: 's1', designator: 'SP1', kind: 'butt' }]
    d.wires = [
      { id: 'w1', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'splice', spliceId: 's1' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'RD' } },
      { id: 'w2', ends: [{ type: 'splice', spliceId: 's1' }, { type: 'cavity', cavityId: 'b' }], gauge: { value: 2.5, unit: 'mm2' }, color: { base: 'RD' } }
    ]
    expect(runDrc(d).filter((f) => f.ruleId === 'gauge-mismatch-in-net')).toHaveLength(1)
  })

  it('flags an unresolved PartRef only when a catalog is supplied', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', housing: { partNumber: 'GHOST' }, cavities: [] }]
    expect(runDrc(d).filter((f) => f.ruleId === 'stale-or-unresolved-partref')).toHaveLength(0) // no catalog
    const withCat = runDrc(d, new StubCatalog([{ partNumber: 'OTHER', description: 'x' }]))
    expect(withCat.filter((f) => f.ruleId === 'stale-or-unresolved-partref')).toHaveLength(1)
  })

  it('flags a stale description (cache drift) against the catalog', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', housing: { partNumber: 'HSG-1', description: 'WRONG' }, cavities: [] }]
    const cat = new StubCatalog([{ partNumber: 'HSG-1', description: 'Right Name' }])
    expect(runDrc(d, cat).filter((f) => f.ruleId === 'stale-or-unresolved-partref')).toHaveLength(1)
  })
})

describe('DRC dangling reference rules', () => {
  it('does NOT fire on the clean demo', () => {
    expect(runDrc(demoDocument()).filter((f) => f.ruleId === 'dangling-endpoint')).toHaveLength(0)
    expect(runDrc(demoDocument()).filter((f) => f.ruleId === 'dangling-member')).toHaveLength(0)
  })

  it('flags a wire endpoint referencing a non-existent cavity and splice', () => {
    const d = emptyDocument()
    d.wires = [
      {
        id: 'w',
        ends: [
          { type: 'cavity', cavityId: 'ghost' },
          { type: 'splice', spliceId: 'nope' }
        ],
        gauge: { value: 1, unit: 'mm2' },
        color: { base: 'RD' }
      }
    ]
    const f = ids(d, 'dangling-endpoint')
    expect(f).toHaveLength(2)
    expect(f[0].severity).toBe('error')
  })

  it('catches a dangling endpoint even when specifiedLengthMm masks unrouted-wire', () => {
    const d = emptyDocument()
    d.freeTerminals = [{ id: 'real', designator: 'T1', kind: 'ring' }]
    d.wires = [
      {
        id: 'w',
        ends: [
          { type: 'cavity', cavityId: 'ghost' },
          { type: 'freeTerminal', terminalId: 'real' }
        ],
        gauge: { value: 1, unit: 'mm2' },
        color: { base: 'RD' },
        specifiedLengthMm: 200
      }
    ]
    expect(ids(d, 'unrouted-wire')).toHaveLength(0) // specified length hides it
    expect(ids(d, 'dangling-endpoint')).toHaveLength(1) // but the dangling ref is caught
  })

  it('flags dangling member-wire ids and span segment ids', () => {
    const d = emptyDocument()
    d.cables = [{ id: 'cab', name: 'CAN', coreWireIds: ['ghostWire'] }]
    d.twists = [{ id: 'tw', wireIds: ['ghostA', 'ghostB'], span: { segmentIds: ['ghostSeg'] } }]
    // cable core(1) + twist members(2) + twist span(1) = 4
    expect(ids(d, 'dangling-member').length).toBeGreaterThanOrEqual(4)
  })

  it('flags a wire whose cableId points at a missing cable (R1)', () => {
    const d = emptyDocument()
    d.wires = [
      {
        id: 'w',
        ends: [
          { type: 'cavity', cavityId: 'a' },
          { type: 'cavity', cavityId: 'b' }
        ],
        gauge: { value: 1, unit: 'mm2' },
        color: { base: 'RD' },
        cableId: 'ghostCable'
      }
    ]
    const f = ids(d, 'dangling-member').filter((x) => x.message.includes('ghostCable'))
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('error')
  })

  it('flags a label whose target segment and anchor segment do not resolve', () => {
    const doc = demoDocument()
    doc.labels.push({
      id: 'l1', target: { type: 'branch', segmentId: 'gone' }, kind: 'callout',
      text: 'x', pos: { x: 0, y: 0 }, anchor: { segmentId: 'gone', fraction: 0.5 }
    })
    const f = runDrc(doc).filter((x) => x.ruleId === 'dangling-label-ref')
    expect(f.length).toBeGreaterThan(0)
    expect(f[0].severity).toBe('error')
  })
})

describe('DRC span rules (R2/R3)', () => {
  /** Two disjoint segments s1 (n0→n1) and s9 (n8→n9). */
  function twoSegments() {
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'n0', pos: { x: 0, y: 0 } },
      { id: 'n1', pos: { x: 10, y: 0 } },
      { id: 'n8', pos: { x: 80, y: 0 } },
      { id: 'n9', pos: { x: 90, y: 0 } }
    ]
    d.segments = [
      { id: 's1', from: { type: 'branch', branchId: 'n0' }, to: { type: 'branch', branchId: 'n1' } },
      { id: 's9', from: { type: 'branch', branchId: 'n8' }, to: { type: 'branch', branchId: 'n9' } }
    ]
    return d
  }

  it('flags a twist span whose segments do not form one chain', () => {
    const d = twoSegments()
    d.twists = [{ id: 'tw', wireIds: ['w1', 'w2'], span: { segmentIds: ['s1', 's9'] } }]
    const f = ids(d, 'non-contiguous-span')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('error')
  })

  it('flags a non-contiguous sleeving span', () => {
    const d = twoSegments()
    d.sleeving = [
      { id: 'sl', target: { type: 'wire', wireId: 'w1' }, span: { segmentIds: ['s1', 's9'] }, sleevingType: 'braided' }
    ]
    expect(ids(d, 'non-contiguous-span')).toHaveLength(1)
  })

  it('does NOT fire on a contiguous span or on the clean demo', () => {
    const d = twoSegments()
    d.sleeving = [
      { id: 'sl', target: { type: 'wire', wireId: 'w1' }, span: { segmentIds: ['s1'] }, sleevingType: 'braided' }
    ]
    expect(ids(d, 'non-contiguous-span')).toHaveLength(0)
    expect(ids(demoDocument(), 'non-contiguous-span')).toHaveLength(0)
  })

  it('reports an empty span as info (0 mm treatment), not as an error', () => {
    const d = twoSegments()
    d.twists = [{ id: 'tw', wireIds: ['w1', 'w2'], span: { segmentIds: [] } }]
    const f = ids(d, 'empty-span')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('info')
    expect(ids(demoDocument(), 'empty-span')).toHaveLength(0)
  })

  it('leaves a span with a MISSING segment to dangling-member (no double report)', () => {
    const d = twoSegments()
    d.sleeving = [
      { id: 'sl', target: { type: 'wire', wireId: 'w1' }, span: { segmentIds: ['s1', 'ghost'] }, sleevingType: 'braided' }
    ]
    expect(ids(d, 'non-contiguous-span')).toHaveLength(0)
    expect(ids(d, 'dangling-member').length).toBeGreaterThan(0)
  })
})

describe('DRC covers the bundle loom-tape PartRef', () => {
  it('flags an unresolved bundle part against the catalog', () => {
    const d = emptyDocument()
    d.bundles = [
      { id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'], part: { partNumber: 'GHOST-TAPE' } }
    ]
    const cat = new StubCatalog([{ partNumber: 'TAPE-19', description: 'Loom tape 19mm' }])
    const found = runDrc(d, cat).filter((f) => f.ruleId === 'stale-or-unresolved-partref')
    expect(found).toHaveLength(1)
    expect(found[0].message).toContain('GHOST-TAPE')
  })
})

describe('invalid-specified-length (session-10 nit)', () => {
  const wire = (extra: Record<string, unknown>) => ({
    id: 'w',
    ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' }],
    gauge: { value: 1, unit: 'mm2' },
    color: { base: 'RD' },
    ...extra
  })

  it('flags a negative Wire.specifiedLengthMm', () => {
    const d = emptyDocument()
    d.wires = [wire({ specifiedLengthMm: -50 }) as any]
    expect(ids(d, 'invalid-specified-length')).toHaveLength(1)
  })

  it('flags a NaN Wire.specifiedLengthMm', () => {
    const d = emptyDocument()
    d.wires = [wire({ specifiedLengthMm: NaN }) as any]
    expect(ids(d, 'invalid-specified-length')).toHaveLength(1)
  })

  it('flags a negative Wire.addLengthMm', () => {
    const d = emptyDocument()
    d.wires = [wire({ specifiedLengthMm: 100, addLengthMm: -3 }) as any]
    expect(ids(d, 'invalid-specified-length')).toHaveLength(1)
  })

  it('flags a negative Cable.specifiedLengthMm', () => {
    const d = emptyDocument()
    d.cables = [{ id: 'cab', name: 'CAN', coreWireIds: [], specifiedLengthMm: -1 } as any]
    expect(ids(d, 'invalid-specified-length')).toHaveLength(1)
  })

  it('does NOT flag zero — an explicit zero-length override is legal', () => {
    const d = emptyDocument()
    d.wires = [wire({ specifiedLengthMm: 0, addLengthMm: 0 }) as any]
    expect(ids(d, 'invalid-specified-length')).toHaveLength(0)
  })

  it('clean demo document has none', () => {
    expect(ids(demoDocument(), 'invalid-specified-length')).toHaveLength(0)
  })
})

describe('duplicate-designator', () => {
  it('flags a designator shared by a connector and a splice, once, with both refs', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', cavities: [] }]
    d.splices = [{ id: 's1', designator: 'X1', kind: 'butt' }]
    const f = ids(d, 'duplicate-designator')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('error')
    expect(f[0].message).toBe('Designator X1 is used by 2 bodies')
    expect(f[0].refs).toHaveLength(2)
  })

  it('is silent when designators are unique', () => {
    expect(ids(demoDocument(), 'duplicate-designator')).toHaveLength(0)
  })

  it('skips blank designators (two blank connectors are not a duplicate)', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'c1', designator: '', cavities: [] },
      { id: 'c2', designator: '  ', cavities: [] }
    ]
    expect(ids(d, 'duplicate-designator')).toHaveLength(0)
  })

  it('a terminal in a duplicate group, and a three-way duplicate: one finding with all refs', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', cavities: [] }]
    d.freeTerminals = [{ id: 't1', designator: 'X1', kind: 'ring' }]
    d.splices = [{ id: 's1', designator: 'X1', kind: 'butt' }]
    const f = ids(d, 'duplicate-designator')
    expect(f).toHaveLength(1)
    expect(f[0].message).toBe('Designator X1 is used by 3 bodies')
    expect(f[0].refs).toEqual([
      { kind: 'connector', id: 'c1' },
      { kind: 'freeTerminal', id: 't1' },
      { kind: 'splice', id: 's1' }
    ])
  })
})

describe('unrouted-wire and cable drains', () => {
  const cav = (c: string) => ({ type: 'cavity' as const, cavityId: c })
  function base() {
    const d = emptyDocument()
    for (const id of ['X1', 'X2'])
      d.connectors.push({ id, designator: id, cavities: [{ id: `${id}-1`, position: '1', status: 'populated' }] })
    d.placements.push({ refId: 'X1', pos: { x: 0, y: 0 } }, { refId: 'X2', pos: { x: 100, y: 0 } })
    d.cables = [{ id: 'cab', name: 'C1', coreWireIds: [], shield: { present: true, drainWireId: 'wd' } } as never]
    d.wires = [
      {
        id: 'wd',
        ends: [{ type: 'shield', cableId: 'cab', end: 'a' }, cav('X2-1')],
        gauge: { value: 0.5, unit: 'mm2' },
        color: { base: 'BK' },
        cableId: 'cab'
      }
    ]
    return d
  }
  const unrouted = (d: ReturnType<typeof base>) =>
    runDrc(d).filter((f) => f.ruleId === 'unrouted-wire').flatMap((f) => f.refs.map((r) => r.id))

  it('skips a cable drain (cableId + shield end on that cable)', () => {
    expect(unrouted(base())).toEqual([])
  })

  it('still reports an ordinary unrouted wire, and a shield wire without cableId', () => {
    const d = base()
    d.wires.push({ id: 'wx', ends: [cav('X1-1'), cav('X2-1')], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'RD' } })
    delete d.wires[0].cableId
    expect(unrouted(d).sort()).toEqual(['wd', 'wx'])
  })
})

describe('segment-length-off-scale', () => {
  // Demo seg-1 runs X1 (52,60) → X2 (372,60): drawn 320 mm.
  const offScale = (d: HarnessDocument) => runDrc(d).filter((f) => f.ruleId === 'segment-length-off-scale')

  it('one warning for one broken limb, naming the segment and both lengths', () => {
    const d = demoDocument()
    d.segments.find((s) => s.id === 'seg-1')!.specifiedLengthMm = 370
    expect(offScale(d)).toEqual([
      {
        ruleId: 'segment-length-off-scale',
        severity: 'warning',
        message: 'Limb typed 370 mm but drawn 320 mm — press an arrow on its label to rescale',
        refs: [{ kind: 'segment', id: 'seg-1' }]
      }
    ])
  })

  it('prints typed lengths to at most one decimal, no float noise', () => {
    const msg = (mm: number): string => {
      const d = demoDocument()
      d.segments.find((s) => s.id === 'seg-1')!.specifiedLengthMm = mm
      return offScale(d)[0].message
    }
    expect(msg(899.9999999999999)).toContain('typed 900 mm')
    expect(msg(185.33333333)).toContain('typed 185.3 mm')
  })

  it('none after the limb is rescaled to its typed length', () => {
    const d = produce(demoDocument(), (dr) => {
      dr.segments.find((s) => s.id === 'seg-1')!.specifiedLengthMm = 370
    })
    expect(offScale(d)).toHaveLength(1)
    let res: string | undefined
    const after = produce(d, (dr) => {
      res = applyRescaleSegment(dr, 'seg-1', 'to')
    })
    expect(res).toBe('ok')
    expect(offScale(after)).toEqual([])
  })

  it('none for an untyped limb or one typed within tolerance', () => {
    expect(offScale(demoDocument())).toEqual([])
    const d = demoDocument()
    d.segments.find((s) => s.id === 'seg-1')!.specifiedLengthMm = 320.4
    expect(offScale(d)).toEqual([])
  })
})
