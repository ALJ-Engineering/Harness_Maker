import { describe, it, expect } from 'vitest'
import { reconcileDocument } from './reconcile'
import { emptyDocument, demoDocument } from './document'
import { serializeDocument, parseDocument } from './serialize'
import { runDrc } from '../drc'
import type { HarnessDocument, RouteNode } from './schema'

const bodyNode = (refId: string): RouteNode => ({ type: 'body', refId })

const kinds = (doc: HarnessDocument): string[] =>
  reconcileDocument(doc).repairs.map((r) => r.kind)

/** Two live, connected segments cavA-cavB-cavC carrying one wire route. */
function routed(): HarnessDocument {
  const d = emptyDocument()
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'cavA' },
        { type: 'cavity', cavityId: 'cavC' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' }
    }
  ]
  d.segments = [
    { id: 'seg1', from: bodyNode('bodyA'), to: bodyNode('bodyB') },
    { id: 'seg2', from: bodyNode('bodyB'), to: bodyNode('bodyC') }
  ]
  d.wireRoutes = [{ wireId: 'w1', path: ['seg1', 'seg2'] }]
  return d
}

// ─── Clean documents are left completely alone ───────────────────────────────

describe('reconcileDocument — clean documents', () => {
  it('reports no repairs for an empty document', () => {
    const d = emptyDocument()
    const out = reconcileDocument(d)
    expect(out.repairs).toEqual([])
    expect(out.doc).toBe(d) // same reference: nothing to fix
  })

  it('reports no repairs for the demo document', () => {
    const out = reconcileDocument(demoDocument())
    expect(out.repairs).toEqual([])
  })

  it('is byte-identical through serialize -> parse -> reconcile', () => {
    const text = serializeDocument(demoDocument())
    const out = reconcileDocument(parseDocument(text))
    expect(out.repairs).toEqual([])
    expect(serializeDocument(out.doc)).toBe(text)
  })

  it('never mutates the input document', () => {
    const d = routed()
    d.wireRoutes.push({ wireId: 'ghost', path: ['seg1'] })
    const before = serializeDocument(d)
    reconcileDocument(d)
    expect(serializeDocument(d)).toBe(before)
  })

  it('is idempotent — reconciling the repaired document yields no further repairs', () => {
    const d = routed()
    d.wireRoutes.push({ wireId: 'ghost', path: ['seg1'] })
    d.cables = [{ id: 'cab1', name: 'CAN', coreWireIds: ['gone'] }]
    d.labels = [
      { id: 'lab1', target: { type: 'branch', segmentId: 'dead' }, kind: 'flag', text: 'L', pos: { x: 0, y: 0 } }
    ]
    const once = reconcileDocument(d)
    expect(once.repairs.length).toBeGreaterThan(0)
    expect(reconcileDocument(once.doc).repairs).toEqual([])
  })
})

// ─── References to entities that do not exist ────────────────────────────────

describe('reconcileDocument — dangling references', () => {
  it('drops a WireRoute whose wire is gone', () => {
    const d = routed()
    d.wireRoutes.push({ wireId: 'ghost', path: ['seg1'] })
    const out = reconcileDocument(d)
    expect(out.doc.wireRoutes.map((r) => r.wireId)).toEqual(['w1'])
    expect(out.repairs).toContainEqual(
      expect.objectContaining({ kind: 'orphaned-route', entityId: 'ghost' })
    )
  })

  it('drops a cable core whose wire is gone and keeps the cable when cores remain', () => {
    const d = routed()
    d.cables = [{ id: 'cab1', name: 'CAN', coreWireIds: ['w1', 'gone'] }]
    d.wires[0].cableId = 'cab1'
    const out = reconcileDocument(d)
    expect(out.doc.cables[0].coreWireIds).toEqual(['w1'])
    expect(kinds(d)).toContain('dangling-cable-core')
  })

  it('clears a shield drain whose wire is gone but keeps shield.present', () => {
    const d = routed()
    d.cables = [
      { id: 'cab1', name: 'CAN', coreWireIds: ['w1'], shield: { present: true, drainWireId: 'gone' } }
    ]
    d.wires[0].cableId = 'cab1'
    const out = reconcileDocument(d)
    expect(out.doc.cables[0].shield).toEqual({ present: true })
    expect(kinds(d)).toContain('dangling-cable-drain')
  })

  it('removes a cable left with no cores (R1 policy)', () => {
    const d = routed()
    d.cables = [{ id: 'cab1', name: 'CAN', coreWireIds: ['gone'] }]
    const out = reconcileDocument(d)
    expect(out.doc.cables).toEqual([])
    expect(kinds(d)).toContain('empty-cable')
  })

  it('keeps a core-less cable a surviving wire still points at (R1 policy)', () => {
    const d = routed()
    d.cables = [{ id: 'cab1', name: 'CAN', coreWireIds: ['gone'] }]
    d.wires[0].cableId = 'cab1'
    const out = reconcileDocument(d)
    expect(out.doc.cables.map((c) => c.id)).toEqual(['cab1'])
    expect(kinds(d)).not.toContain('empty-cable')
  })

  it('drops a twist member whose wire is gone, and the twist once it falls below 2', () => {
    const d = routed()
    d.wires.push({ ...d.wires[0], id: 'w2' })
    d.twists = [
      { id: 'tw1', wireIds: ['w1', 'w2', 'gone'], span: { segmentIds: [] } },
      { id: 'tw2', wireIds: ['w1', 'gone'], span: { segmentIds: [] } }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.twists.map((t) => t.id)).toEqual(['tw1'])
    expect(out.doc.twists[0].wireIds).toEqual(['w1', 'w2'])
    expect(kinds(d)).toContain('dangling-twist-member')
    expect(kinds(d)).toContain('twist-removed')
  })

  it('removes sleeving whose target wire or cable is gone', () => {
    const d = routed()
    d.sleeving = [
      { id: 'sl1', target: { type: 'wire', wireId: 'gone' }, span: { segmentIds: [] }, sleevingType: 'braided' },
      { id: 'sl2', target: { type: 'cable', cableId: 'gone' }, span: { segmentIds: [] }, sleevingType: 'pvc' },
      { id: 'sl3', target: { type: 'wire', wireId: 'w1' }, span: { segmentIds: ['seg1'] }, sleevingType: 'pvc' }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.sleeving.map((s) => s.id)).toEqual(['sl3'])
    expect(kinds(d).filter((k) => k === 'dangling-sleeving-target')).toHaveLength(2)
  })

  it('removes labels whose target wire / branch segment / branch point is gone', () => {
    const d = routed()
    d.labels = [
      { id: 'l1', target: { type: 'wire', wireId: 'gone' }, kind: 'wireMarker', text: 'A', pos: { x: 0, y: 0 } },
      { id: 'l2', target: { type: 'branch', segmentId: 'dead' }, kind: 'flag', text: 'B', pos: { x: 0, y: 0 } },
      { id: 'l3', target: { type: 'branchPoint', branchId: 'nope' }, kind: 'callout', text: 'C', pos: { x: 0, y: 0 } },
      { id: 'l4', target: { type: 'wire', wireId: 'w1' }, kind: 'wireMarker', text: 'D', pos: { x: 0, y: 0 } }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.labels.map((l) => l.id)).toEqual(['l4'])
    expect(kinds(d).filter((k) => k === 'dangling-label-target')).toHaveLength(3)
  })

  it('re-derives a label anchor whose segment vanished', () => {
    const d = routed()
    d.labels = [
      {
        id: 'l1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'wireMarker',
        text: 'A',
        pos: { x: 0, y: 0 },
        anchor: { segmentId: 'dead', fraction: 0.25 }
      }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.labels[0].anchor).toEqual({ segmentId: 'seg2', fraction: 0.5 })
    expect(kinds(d)).toContain('dangling-label-anchor')
  })

  it('drops an unrecoverable label anchor but keeps the label', () => {
    const d = routed()
    d.wireRoutes = [] // nothing to re-derive from
    d.labels = [
      {
        id: 'l1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'wireMarker',
        text: 'A',
        pos: { x: 1, y: 2 },
        anchor: { segmentId: 'dead', fraction: 0.25 }
      }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.labels).toHaveLength(1)
    expect(out.doc.labels[0].anchor).toBeUndefined()
    expect(kinds(d)).toContain('dangling-label-anchor')
  })
})

// ─── Spans ───────────────────────────────────────────────────────────────────

describe('reconcileDocument — spans', () => {
  it('trims a span onto the segments that survive', () => {
    const d = routed()
    d.sleeving = [
      {
        id: 'sl1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg1', 'seg2', 'dead'], endFraction: 0.4 },
        sleevingType: 'braided'
      }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.sleeving[0].span.segmentIds).toEqual(['seg1', 'seg2'])
    expect(out.doc.sleeving[0].span.endFraction).toBeUndefined() // measured off the dead tail
    expect(kinds(d)).toContain('span-trimmed')
  })

  it('removes a treatment whose span lost every segment', () => {
    const d = routed()
    d.sleeving = [
      {
        id: 'sl1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['dead1', 'dead2'] },
        sleevingType: 'braided'
      }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.sleeving).toEqual([])
    expect(kinds(d)).toContain('empty-span-treatment')
  })

  it('leaves a span that was authored empty alone', () => {
    const d = routed()
    d.wires.push({ ...d.wires[0], id: 'w2' })
    d.twists = [{ id: 'tw1', wireIds: ['w1', 'w2'], span: { segmentIds: [] } }]
    const out = reconcileDocument(d)
    expect(out.doc.twists).toHaveLength(1)
    expect(out.repairs).toEqual([])
  })

  it('does NOT touch a non-contiguous span of live segments (DRC owns that call)', () => {
    const d = routed()
    d.segments.push({ id: 'seg9', from: bodyNode('bodyY'), to: bodyNode('bodyZ') })
    d.wireRoutes[0].path = ['seg1', 'seg2', 'seg9']
    d.sleeving = [
      {
        id: 'sl1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg1', 'seg9'] }, // live, but not one chain
        sleevingType: 'braided'
      }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.sleeving[0].span.segmentIds).toEqual(['seg1', 'seg9'])
    expect(out.repairs).toEqual([])
    expect(runDrc(out.doc).some((f) => f.ruleId === 'non-contiguous-span')).toBe(true)
  })
})

// ─── Bundles ─────────────────────────────────────────────────────────────────

describe('reconcileDocument — bundles', () => {
  it('leaves a correctly-derived bundle untouched', () => {
    const d = routed()
    d.wires.push({ ...d.wires[0], id: 'w2' })
    d.wireRoutes.push({ wireId: 'w2', path: ['seg1'] })
    d.bundles = [{ id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1', 'w2'], name: 'B' }]
    const out = reconcileDocument(d)
    expect(out.repairs).toEqual([])
    expect(out.doc.bundles).toEqual(d.bundles)
  })

  it('removes a bundle that no longer describes a shared run, and its sleeving', () => {
    const d = routed()
    d.bundles = [{ id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'] }]
    d.sleeving = [
      {
        id: 'sl1',
        target: { type: 'bundle', bundleId: 'bn1' },
        span: { segmentIds: ['seg1'] },
        sleevingType: 'tape'
      }
    ]
    const out = reconcileDocument(d)
    expect(out.doc.bundles).toEqual([])
    expect(out.doc.sleeving).toEqual([])
    expect(kinds(d)).toContain('bundle-resynced')
  })
})

// ─── Deliberate non-repairs (these stay DRC findings) ────────────────────────

describe('reconcileDocument — judgement calls are left for DRC', () => {
  it('leaves dangling wire endpoints, self-loops, bad lengths and degree problems alone', () => {
    const d = emptyDocument()
    d.splices = [{ id: 'sp1', designator: 'SP1', kind: 'butt' }]
    d.wires = [
      {
        id: 'w1',
        ends: [
          { type: 'cavity', cavityId: 'no-such-cavity' },
          { type: 'splice', spliceId: 'sp1' }
        ],
        gauge: { value: 0.5, unit: 'mm2' },
        color: { base: 'RD' },
        specifiedLengthMm: -5
      }
    ]
    d.branchPoints = [
      { id: 'bp-orphan', pos: { x: 0, y: 0 } },
      { id: 'bp-loop', pos: { x: 10, y: 0 } }
    ]
    d.segments = [
      {
        id: 'seg-loop',
        from: { type: 'branch', branchId: 'bp-loop' },
        to: { type: 'branch', branchId: 'bp-loop' }
      }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['seg-loop'] }]
    const out = reconcileDocument(d)
    expect(out.repairs).toEqual([])
    expect(out.doc.wires).toHaveLength(1)
    expect(out.doc.branchPoints).toHaveLength(2)
    expect(out.doc.segments).toHaveLength(1)
    const ruleIds = new Set(runDrc(out.doc).map((f) => f.ruleId))
    expect(ruleIds.has('dangling-endpoint')).toBe(true)
    expect(ruleIds.has('self-loop-segment')).toBe(true)
    expect(ruleIds.has('invalid-specified-length')).toBe(true)
    expect(ruleIds.has('branchpoint-degree')).toBe(true)
  })
})

// ─── A file written before the session-11 fixes ──────────────────────────────

/**
 * What a pre-session-11 save looks like after `removeWire` ran with the B3/B4
 * bugs: the wire and its segment are gone, but the branch-target label, the
 * anchored label, the cable core list and the sleeving span still point at them.
 */
function preSession11File(): HarnessDocument {
  const d = routed()
  d.cables = [
    { id: 'cab1', name: 'CAN', coreWireIds: ['w1', 'wire-deleted'], shield: { present: true, drainWireId: 'wire-deleted-drain' } }
  ]
  d.wires[0].cableId = 'cab1'
  d.labels = [
    // B3: branch-target label whose segment was GC'd
    { id: 'l-branch', target: { type: 'branch', segmentId: 'seg-deleted' }, kind: 'flag', text: 'BR', pos: { x: 0, y: 0 } },
    // B3: anchor left on a GC'd segment, target still alive
    {
      id: 'l-anchor',
      target: { type: 'wire', wireId: 'w1' },
      kind: 'wireMarker',
      text: 'W1',
      pos: { x: 0, y: 0 },
      anchor: { segmentId: 'seg-deleted', fraction: 0.3 }
    }
  ]
  d.sleeving = [
    {
      id: 'sl1',
      target: { type: 'wire', wireId: 'w1' },
      span: { segmentIds: ['seg1', 'seg-deleted'] },
      sleevingType: 'braided'
    }
  ]
  return d
}

describe('reconcileDocument — pre-session-11 file', () => {
  it('clears every dangling-reference DRC error the old bugs left behind', () => {
    const before = runDrc(preSession11File()).map((f) => f.ruleId)
    expect(before).toContain('dangling-label-ref')
    expect(before).toContain('dangling-member')

    const out = reconcileDocument(preSession11File())
    expect(out.repairs.length).toBeGreaterThan(0)
    const after = runDrc(out.doc).map((f) => f.ruleId)
    expect(after).not.toContain('dangling-label-ref')
    expect(after).not.toContain('dangling-member')
  })

  it('repairs each dangler exactly once and keeps the healthy parts', () => {
    const out = reconcileDocument(preSession11File())
    expect(out.doc.labels.map((l) => l.id)).toEqual(['l-anchor'])
    expect(out.doc.labels[0].anchor).toEqual({ segmentId: 'seg2', fraction: 0.5 })
    expect(out.doc.cables[0].coreWireIds).toEqual(['w1'])
    expect(out.doc.cables[0].shield).toEqual({ present: true })
    expect(out.doc.sleeving[0].span.segmentIds).toEqual(['seg1'])
    expect(out.doc.wires).toHaveLength(1)
    expect(new Set(out.repairs.map((r) => r.kind))).toEqual(
      new Set([
        'dangling-cable-core',
        'dangling-cable-drain',
        'dangling-label-target',
        'dangling-label-anchor',
        'span-trimmed'
      ])
    )
    for (const r of out.repairs) expect(r.message).toBeTruthy()
  })
})
