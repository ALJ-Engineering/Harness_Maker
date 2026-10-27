import { describe, it, expect } from 'vitest'
import { produce } from 'immer'
import {
  applyInsertBranchPoint,
  applyRemoveBranchPoint,
  applyMergeBranchPoints,
  applyDisconnectWireAtBranch,
  syncBundles,
  type InsertBranchIds,
  type RemoveBranchIds
} from './routing'
import { routeConnected, wireLength } from './geometry'
import { emptyDocument } from './document'
import type { HarnessDocument, RouteNode, Endpoint, Label } from './schema'
import { twistSpanSegments, isSpanContiguous } from './treatments'

/** A body route-node (schema 0.4.0: limbs reach BODIES, not cavities). */
const epNode = (refId: string): RouteNode => ({ type: 'body', refId })

/**
 * Register one single-cavity connector per wire-end cavity id, giving the
 * connector the SAME id as its cavity. Route nodes are body-keyed since 0.4.0,
 * so a fixture can then write `epNode('cavA')` for the body that cavity `cavA`
 * lands on, and `endpointBodyKey` resolves the wire ends to those same nodes.
 */
function withBodies(d: HarnessDocument, ...cavityIds: string[]): void {
  for (const id of cavityIds)
    d.connectors.push({
      id,
      designator: id,
      cavities: [{ id, position: '1', status: 'populated' }]
    })
}
const IDS: InsertBranchIds = { branchId: 'bp1', segAId: 'segA', segBId: 'segB' }

/** One segment seg1: cavA -> cavB, used by a forward route, a bundle, a sleeving span. */
function base(): HarnessDocument {
  const d = emptyDocument()
  d.segments = [{ id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }]
  d.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
  d.bundles = [{ id: 'bnd1', segmentIds: ['seg1'], memberWireIds: ['w1'] }]
  d.sleeving = [
    {
      id: 'slv1',
      target: { type: 'wire', wireId: 'w1' },
      span: { segmentIds: ['seg1'], startFraction: 0.25, endFraction: 0.75 },
      sleevingType: 'braided'
    }
  ]
  d.labels = [
    { id: 'lab1', target: { type: 'branch', segmentId: 'seg1' }, kind: 'flag', text: 'L', pos: { x: 0, y: 0 } }
  ]
  return d
}
const run = (d: HarnessDocument, seg = 'seg1') =>
  produce(d, (draft) => applyInsertBranchPoint(draft, seg, { x: 5, y: 0 }, IDS))

describe('applyInsertBranchPoint', () => {
  it('replaces the segment with two meeting at the new branch point', () => {
    const d = run(base())
    expect(d.branchPoints.map((b) => b.id)).toEqual(['bp1'])
    expect(d.segments.map((s) => s.id)).toEqual(['segA', 'segB'])
    const a = d.segments.find((s) => s.id === 'segA')!
    const b = d.segments.find((s) => s.id === 'segB')!
    expect(a.from).toEqual(epNode('cavA'))
    expect(a.to).toEqual({ type: 'branch', branchId: 'bp1' })
    expect(b.from).toEqual({ type: 'branch', branchId: 'bp1' })
    expect(b.to).toEqual(epNode('cavB'))
  })

  it('rewrites a forward route to [segA, segB]', () => {
    expect(run(base()).wireRoutes[0].path).toEqual(['segA', 'segB'])
  })

  it('rewrites a reversed route to [segB, segA]', () => {
    const d = base()
    withBodies(d, 'cavA', 'cavB', 'cavX')
    d.wires = [
      { id: 'w1', ends: [{ type: 'cavity', cavityId: 'cavB' }, { type: 'cavity', cavityId: 'cavA' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } }
    ]
    // build a 2-seg reversed context: route enters seg1 from cavB side
    d.segments = [
      { id: 'seg0', from: epNode('cavB'), to: epNode('cavX') },
      { id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['seg0', 'seg1'] }] // ...cavX..cavB | cavB->cavA
    const out = run(d).wireRoutes[0].path
    expect(out).toEqual(['seg0', 'segB', 'segA'])
  })

  it('rewrites the bundle segmentIds', () => {
    expect(run(base()).bundles[0].segmentIds).toEqual(['segA', 'segB'])
  })

  it('retargets a branch label to the near limb (segA)', () => {
    const t = run(base()).labels[0].target
    expect(t).toEqual({ type: 'branch', segmentId: 'segA' })
  })

  it('leaves an unrelated route untouched', () => {
    const d = base()
    d.wireRoutes.push({ wireId: 'w2', path: ['other'] })
    expect(run(d).wireRoutes[1].path).toEqual(['other'])
  })

  it('is a no-op when the segment id does not exist', () => {
    const d = base()
    const out = produce(d, (draft) => applyInsertBranchPoint(draft, 'nope', { x: 1, y: 1 }, IDS))
    expect(out).toEqual(d)
  })

  it('chains: splitting segA again keeps every route connected', () => {
    const once = run(base())
    const twice = produce(once, (draft) =>
      applyInsertBranchPoint(draft, 'segA', { x: 2, y: 0 }, { branchId: 'bp2', segAId: 'segA2', segBId: 'segB2' })
    )
    expect(twice.wireRoutes[0].path).toEqual(['segA2', 'segB2', 'segB'])
  })
})

describe('span fraction remap', () => {
  it('remaps startFraction when the split lands inside the first span segment', () => {
    const d = base()
    withBodies(d, 'cavA', 'cavB')
    d.placements = [
      { refId: 'cavA', pos: { x: 0, y: 0 } },
      { refId: 'cavB', pos: { x: 100, y: 0 } }
    ]
    // Dot-true node positions (0.4.0): the bodies ARE their placements, so the
    // segment line is (0,0)→(100,0) and t = px/100.
    // split at x=50 => t = 0.5. startFraction 0.25 (<0.5) stays on segA rescaled 0.25/0.5 = 0.5;
    // endFraction 0.75 (>0.5) moves to segB rescaled (0.75-0.5)/0.5 = 0.5.
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 50, y: 0 }, IDS)
    )
    const span = out.sleeving[0].span
    expect(span.segmentIds).toEqual(['segA', 'segB'])
    expect(span.startFraction).toBeCloseTo(0.5)
    expect(span.endFraction).toBeCloseTo(0.5)
  })

  /**
   * I1 regression: span traverses seg1 REVERSED (cavB→cavA).
   *
   * Setup:
   *   seg2 = cavC→cavB (unchanged, not split)
   *   seg1 = cavA→cavB (split target; intrinsic from=cavA, to=cavB)
   *   span: segmentIds=['seg2','seg1'], endFraction=0.3
   *     → traversal: cavC→cavB, then enters seg1 at cavB (reversed), exits at cavA
   *     → endFraction=0.3 along reversed traversal = intrinsic position 1-0.3=0.7 in seg1
   *   split seg1 at t=0.5
   *
   * Physical: position 0.7 (intrinsic) > 0.5 → lies in segB (cavB-side half).
   * In reversed traversal, segB is the NEAR limb (entered first from cavB).
   * Expected: segA is dropped; segB is kept; endFraction on segB (reversed) = 1 - (0.7-0.5)/0.5 = 0.6
   */
  it('I1: reversed-span end-fraction keeps the correct near limb (segB) and rescales correctly', () => {
    const d = emptyDocument()
    // seg2: cavC→cavB; seg1: cavA→cavB (split target)
    d.segments = [
      { id: 'seg2', from: epNode('cavC'), to: epNode('cavB') },
      { id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }
    ]
    d.wireRoutes = []
    d.bundles = []
    // span traverses cavC→cavB→(cavA) i.e. seg2 forward then seg1 reversed
    d.sleeving = [
      {
        id: 'slv2',
        target: { type: 'wire', wireId: 'w2' },
        span: { segmentIds: ['seg2', 'seg1'], endFraction: 0.3 },
        sleevingType: 'braided'
      }
    ]
    d.labels = []
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 0, y: 0 }, IDS)
    )
    const span = out.sleeving[0].span
    // segA dropped (it is the far limb in the reversed traversal); segB kept
    expect(span.segmentIds).toEqual(['seg2', 'segB'])
    // endFraction on segB in reversed frame: 1 - (0.7 - 0.5)/0.5 = 1 - 0.4 = 0.6
    expect(span.endFraction).toBeCloseTo(0.6)
  })

  /**
   * Boundary: startFraction === t  →  stays on segA (boundary = near limb).
   */
  it('split fraction exactly on a span startFraction boundary stays on segA', () => {
    const d = emptyDocument()
    d.segments = [{ id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }]
    // Place nodes so t resolves to 0.5 exactly
    withBodies(d, 'cavA', 'cavB')
    d.placements = [
      { refId: 'cavA', pos: { x: 0, y: 0 } },
      { refId: 'cavB', pos: { x: 100, y: 0 } }
    ]
    d.wireRoutes = []
    d.bundles = []
    // startFraction === t → boundary, should stay on segA (near limb)
    d.sleeving = [
      {
        id: 'slv3',
        target: { type: 'wire', wireId: 'w3' },
        span: { segmentIds: ['seg1'], startFraction: 0.5 },
        sleevingType: 'braided'
      }
    ]
    d.labels = []
    // Dot-true (0.4.0): the segment line is (0,0)→(100,0), so t = px/100 and
    // x=50 is the midpoint → t = 0.5 exactly.
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 50, y: 0 }, IDS)
    )
    const span = out.sleeving[0].span
    // startFraction 0.5 <= t 0.5 → stays on segA, rescaled: 0.5/0.5 = 1.0
    expect(span.segmentIds[0]).toBe('segA')
    expect(span.startFraction).toBeCloseTo(1.0)
  })

  /**
   * Edge: t=0 (branch placed exactly on the `from` node).
   * Guards must prevent division by zero; fractions must remain sane.
   */
  it('t=0: no division by zero; fractions remain sane', () => {
    const d = emptyDocument()
    d.segments = [{ id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }]
    withBodies(d, 'cavA', 'cavB')
    d.placements = [
      { refId: 'cavA', pos: { x: 0, y: 0 } },
      { refId: 'cavB', pos: { x: 100, y: 0 } }
    ]
    d.wireRoutes = []
    d.bundles = []
    d.sleeving = [
      {
        id: 'slvT0',
        target: { type: 'wire', wireId: 'w4' },
        span: { segmentIds: ['seg1'], startFraction: 0.0, endFraction: 0.5 },
        sleevingType: 'braided'
      }
    ]
    d.labels = []
    // Split at x=0 → t=0 (on the `from` endpoint)
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 0, y: 0 }, IDS)
    )
    const span = out.sleeving[0].span
    // Must not throw and fractions must be finite numbers in [0,1]
    expect(Number.isFinite(span.startFraction ?? 0)).toBe(true)
    expect(Number.isFinite(span.endFraction ?? 0)).toBe(true)
  })

  /**
   * Edge: t=1 (branch placed exactly on the `to` node).
   * Guards must prevent division by zero; fractions must remain sane.
   */
  it('t=1: no division by zero; fractions remain sane', () => {
    const d = emptyDocument()
    d.segments = [{ id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }]
    withBodies(d, 'cavA', 'cavB')
    d.placements = [
      { refId: 'cavA', pos: { x: 0, y: 0 } },
      { refId: 'cavB', pos: { x: 100, y: 0 } }
    ]
    d.wireRoutes = []
    d.bundles = []
    d.sleeving = [
      {
        id: 'slvT1',
        target: { type: 'wire', wireId: 'w5' },
        span: { segmentIds: ['seg1'], startFraction: 0.5, endFraction: 1.0 },
        sleevingType: 'braided'
      }
    ]
    d.labels = []
    // Split at x=100 → t=1 (on the `to` endpoint)
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 100, y: 0 }, IDS)
    )
    const span = out.sleeving[0].span
    // Must not throw and fractions must be finite numbers in [0,1]
    expect(Number.isFinite(span.startFraction ?? 0)).toBe(true)
    expect(Number.isFinite(span.endFraction ?? 0)).toBe(true)
  })

  /**
   * Robustness: a span with startFraction but no endFraction, split inside
   * the single segment — both the remapped start and the implicit end coexist.
   */
  it('startFraction set but endFraction undefined: both coexist after split', () => {
    const d = emptyDocument()
    d.segments = [{ id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }]
    withBodies(d, 'cavA', 'cavB')
    d.placements = [
      { refId: 'cavA', pos: { x: 0, y: 0 } },
      { refId: 'cavB', pos: { x: 100, y: 0 } }
    ]
    d.wireRoutes = []
    d.bundles = []
    // startFraction=0.25, no endFraction (implicitly ends at 1 of the last segment)
    d.sleeving = [
      {
        id: 'slvSO',
        target: { type: 'wire', wireId: 'w6' },
        span: { segmentIds: ['seg1'], startFraction: 0.25 },
        sleevingType: 'braided'
      }
    ]
    d.labels = []
    // Dot-true (0.4.0): the segment line is (0,0)→(100,0), so x=50 gives t=0.5;
    // startFraction 0.25 < 0.5 stays on segA, rescaled to 0.5
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 50, y: 0 }, IDS)
    )
    const span = out.sleeving[0].span
    // span now covers segA (from 0.5) + segB (full, endFraction still undefined)
    expect(span.segmentIds).toEqual(['segA', 'segB'])
    expect(span.startFraction).toBeCloseTo(0.5)
    expect(span.endFraction).toBeUndefined()
  })
})

describe('C1: single-segment route with reversed segment orientation', () => {
  /**
   * Wire ends: [cavA, cavB]. Segment stored REVERSED: from:cavB, to:cavA.
   *   fromKey = key(cavB), toKey = key(cavA)
   *
   * routeConnected starts cursor at key(cavA) (= wire.ends[0]).
   * For the path to connect, we need the first segment in the path to share
   * cursor key(cavA) at one of its endpoints.
   *
   * Correct path after insert: [segB, segA]
   *   segB: from=branch, to=cavA → cursor=cavA matches segB.to → advance to branch
   *   segA: from=cavB, to=branch → cursor=branch matches segA.to → advance to cavB ✓
   *
   * Bug (before fix): entryKey returns fromKey (cavB, not cavA), so substitute
   * produces [segA, segB]:
   *   segA: from=cavB, to=branch → cursor=cavA, cavB≠cavA, branch≠cavA → disconnected ✗
   *
   * Also: with placements the wireLength is 'derived' (not 'unknown') after fix.
   */
  it('C1: single reversed-segment route stays connected after branch insert', () => {
    const d = emptyDocument()
    withBodies(d, 'cavA', 'cavB')
    d.placements = [
      { refId: 'cavA', pos: { x: 0, y: 0 } },
      { refId: 'cavB', pos: { x: 100, y: 0 } }
    ]
    // Wire: ends [A, B]
    d.wires = [{
      id: 'w1',
      ends: [{ type: 'cavity', cavityId: 'cavA' }, { type: 'cavity', cavityId: 'cavB' }],
      gauge: { value: 1, unit: 'mm2' },
      color: { base: 'BK' }
    }]
    // Segment stored REVERSED: from:cavB, to:cavA
    d.segments = [{ id: 'seg1', from: epNode('cavB'), to: epNode('cavA') }]
    d.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
    d.bundles = []
    d.sleeving = []
    d.labels = []

    // Dot-true (0.4.0): the wire runs dot to dot, cavA = (0, 0) to
    // cavB = (100, 0). The branch point is stored verbatim, so it must be
    // placed ON that line for the inserted branch to add no dogleg and leave
    // the total length at 100.
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 30, y: 0 }, IDS)
    )

    // Path must be [segB, segA] so the route is connected from cavA → cavB
    expect(out.wireRoutes[0].path).toEqual(['segB', 'segA'])
    expect(routeConnected(out, 'w1')).toBe(true)
    // With placements, wireLength should be 'derived' (not 'unknown') = 100mm
    // (segA cavB→bp = 95, segB bp→cavA = 5, sum = 100)
    const wl = wireLength(out, 'w1')
    expect(wl.source).toBe('derived')
    expect(wl.mm).toBeCloseTo(100)
  })
})

describe('clamped scalar projection for split t', () => {
  /** Shared setup: horizontal segment 0→100 on X axis. */
  function projBase(): HarnessDocument {
    const d = emptyDocument()
    withBodies(d, 'cavA', 'cavB')
    d.placements = [
      { refId: 'cavA', pos: { x: 0, y: 0 } },
      { refId: 'cavB', pos: { x: 100, y: 0 } }
    ]
    d.segments = [{ id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }]
    d.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
    d.bundles = []
    d.sleeving = []
    d.labels = []
    return d
  }

  it('off-axis click {x:50,y:30} projects to the same t as on-axis x=50', () => {
    // The dot-true segment line is (0,0)→(100,0), so x=50 gives t=0.5 — the
    // point here is that the y offset is projected away, i.e. both clicks yield
    // the SAME t, whatever its value.
    const dOnAxis = projBase()
    const dOffAxis = projBase()
    const outOn = produce(dOnAxis, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 50, y: 0 }, IDS)
    )
    const outOff = produce(dOffAxis, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 50, y: 30 }, IDS)
    )
    // Both should produce the same branch point placement (x=50/x=50 for on-axis vs off-axis pos stored verbatim)
    // but we test that t is the same by comparing that segA length ≈ segB length (t=0.5 → both 50mm)
    // We do that by checking: the branch point is stored at the passed pos verbatim,
    // but the SPLIT fraction t is the projection → identical for both clicks.
    // The on-axis case uses segmentLengthMm which requires placements to resolve.
    // Instead verify that the same route path is produced and the span fractions match.
    expect(outOn.wireRoutes[0].path).toEqual(['segA', 'segB'])
    expect(outOff.wireRoutes[0].path).toEqual(['segA', 'segB'])
    // The branch point pos is stored verbatim in both cases
    expect(outOn.branchPoints[0].pos).toEqual({ x: 50, y: 0 })
    expect(outOff.branchPoints[0].pos).toEqual({ x: 50, y: 30 })
    // To verify t=0.5 for both: add a sleeving span and check that the split fractions match
    // We do this by running again with a span that has a startFraction
    const dOffAxisSpan = projBase()
    dOffAxisSpan.sleeving = [{
      id: 'slv1',
      target: { type: 'wire', wireId: 'w1' },
      span: { segmentIds: ['seg1'], startFraction: 0.25, endFraction: 0.75 },
      sleevingType: 'braided'
    }]
    const dOnAxisSpan = projBase()
    dOnAxisSpan.sleeving = [{
      id: 'slv1',
      target: { type: 'wire', wireId: 'w1' },
      span: { segmentIds: ['seg1'], startFraction: 0.25, endFraction: 0.75 },
      sleevingType: 'braided'
    }]
    const outOnSpan = produce(dOnAxisSpan, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 50, y: 0 }, IDS)
    )
    const outOffSpan = produce(dOffAxisSpan, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 50, y: 30 }, IDS)
    )
    // Same t=0.5 → same fraction remapping for both on-axis and off-axis
    expect(outOnSpan.sleeving[0].span.startFraction).toBeCloseTo(outOffSpan.sleeving[0].span.startFraction!)
    expect(outOnSpan.sleeving[0].span.endFraction).toBeCloseTo(outOffSpan.sleeving[0].span.endFraction!)
  })

  it('out-of-range click {x:150,y:0} clamps t=1 (segB has length 0)', () => {
    // With clamped projection: t = clamp(dot(pos-from, to-from)/|to-from|^2, 0, 1)
    // Dot-true nodes (0.4.0): from={x:0,y:0}, to={x:100,y:0}
    // pos={x:150,y:0} → dot = 15000; |to-from|^2 = 10000; t = 1.5 → clamped to 1.0
    // Unclamped this would exceed 1 and break span fraction remapping.
    const d = projBase()
    d.sleeving = [{
      id: 'slv1',
      target: { type: 'wire', wireId: 'w1' },
      span: { segmentIds: ['seg1'], startFraction: 0.0, endFraction: 1.0 },
      sleevingType: 'braided'
    }]
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 150, y: 0 }, IDS)
    )
    // t=1 means segA is the whole original segment, segB is zero-length
    // The span fractions must remain finite and in [0,1]
    const span = out.sleeving[0].span
    expect(Number.isFinite(span.startFraction ?? 0)).toBe(true)
    expect(Number.isFinite(span.endFraction ?? 1)).toBe(true)
    // Branch point stored verbatim at {x:150,y:0}
    expect(out.branchPoints[0].pos).toEqual({ x: 150, y: 0 })
  })

  it('negative out-of-range click {x:-50,y:0} clamps t=0', () => {
    // Dot-true nodes (0.4.0): from={x:0,y:0}, to={x:100,y:0}
    // t = dot((-50,0),(100,0))/10000 = -0.5 → clamped to 0
    const d = projBase()
    const out = produce(d, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: -50, y: 0 }, IDS)
    )
    // t=0 means the branch is at the 'from' node; existing t=0 guard keeps fractions sane
    expect(out.branchPoints[0].pos).toEqual({ x: -50, y: 0 })
    expect(out.wireRoutes[0].path).toEqual(['segA', 'segB'])
  })
})

// ─────────────────────────── applyRemoveBranchPoint ───────────────────────

const REMOVE_IDS: RemoveBranchIds = { mergedSegId: 'merged' }

describe('applyRemoveBranchPoint', () => {
  /**
   * Round-trip: insert a branch point on a single-segment route, then remove it.
   * The doc should be structurally equivalent to the pre-insert state.
   */
  it('round-trip: insert then remove restores a single-segment route', () => {
    // Start: seg1 A→B, one route [seg1]
    const before = base()
    const afterInsert = run(before)
    // afterInsert: branchPoints=[bp1], segments=[segA,segB], route=[segA,segB]
    const afterRemove = produce(afterInsert, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    // Branch point gone
    expect(afterRemove.branchPoints).toHaveLength(0)
    // Back to a single segment
    expect(afterRemove.segments).toHaveLength(1)
    const mergedSeg = afterRemove.segments[0]
    expect(mergedSeg.id).toBe('merged')
    // Merged segment connects the original bodies (cavA and cavB — order may vary)
    const refIds = [mergedSeg.from, mergedSeg.to]
      .filter((n): n is { type: 'body'; refId: string } => n.type === 'body')
      .map((n) => n.refId)
      .sort()
    expect(refIds).toEqual(['cavA', 'cavB'])
    // Route path is back to a single segment
    expect(afterRemove.wireRoutes[0].path).toEqual(['merged'])
  })

  it('round-trip returns true', () => {
    const afterInsert = run(base())
    // Immer requires that a producer either mutates OR returns a new value, not
    // both. applyRemoveBranchPoint mutates + returns a boolean, so capture the
    // return value via a closure variable rather than produce's return.
    let removed = false
    produce(afterInsert, (draft) => {
      removed = applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
      return undefined // explicitly return undefined so Immer sees "mutation only"
    })
    expect(removed).toBe(true)
  })

  it('degree-3 no-op: returns false, doc unchanged', () => {
    // Build a degree-3 branch: bp1 connects to segA (cavA→bp1), segB (bp1→cavB),
    // and segC (bp1→cavC).
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 5, y: 0 } }]
    const bpNode: RouteNode = { type: 'branch', branchId: 'bp1' }
    d.segments = [
      { id: 'segA', from: epNode('cavA'), to: bpNode },
      { id: 'segB', from: bpNode, to: epNode('cavB') },
      { id: 'segC', from: bpNode, to: epNode('cavC') }
    ]
    d.wireRoutes = []
    d.bundles = []
    d.sleeving = []
    d.labels = []

    let removed = true
    const result = produce(d, (draft) => {
      removed = applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(removed).toBe(false)
    // Doc is structurally unchanged
    expect(result.branchPoints).toHaveLength(1)
    expect(result.segments).toHaveLength(3)
    expect(result).toEqual(d)
  })

  it('bundle segmentIds are rewritten to the merged id', () => {
    // base() has a bundle with segmentIds: ['seg1'].
    // After insert: ['segA', 'segB']. After remove: ['merged'].
    const afterInsert = run(base())
    expect(afterInsert.bundles[0].segmentIds).toEqual(['segA', 'segB'])
    const afterRemove = produce(afterInsert, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(afterRemove.bundles[0].segmentIds).toEqual(['merged'])
  })

  it('reversed pair [segB, segA] in a route is also collapsed to [merged]', () => {
    // A route that traverses the branch in reverse order (seg2 then seg1).
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 5, y: 0 } }]
    const bpNode: RouteNode = { type: 'branch', branchId: 'bp1' }
    d.segments = [
      { id: 'segA', from: epNode('cavA'), to: bpNode },
      { id: 'segB', from: bpNode, to: epNode('cavB') }
    ]
    // Route uses reversed order: [segB, segA]
    d.wireRoutes = [{ wireId: 'w1', path: ['segB', 'segA'] }]
    d.bundles = []
    d.sleeving = []
    d.labels = []
    const afterRemove = produce(d, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(afterRemove.wireRoutes[0].path).toEqual(['merged'])
  })

  it('labels targeting seg1 or seg2 are retargeted to mergedSegId', () => {
    // base() has a label targeting 'seg1'. After insert it targets 'segA'.
    // After remove it should target 'merged'.
    const afterInsert = run(base())
    expect(afterInsert.labels[0].target).toEqual({ type: 'branch', segmentId: 'segA' })
    const afterRemove = produce(afterInsert, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(afterRemove.labels[0].target).toEqual({ type: 'branch', segmentId: 'merged' })
  })

  it('a label targeting seg2 (segB) is also retargeted to mergedSegId', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 5, y: 0 } }]
    const bpNode: RouteNode = { type: 'branch', branchId: 'bp1' }
    d.segments = [
      { id: 'segA', from: epNode('cavA'), to: bpNode },
      { id: 'segB', from: bpNode, to: epNode('cavB') }
    ]
    d.wireRoutes = []
    d.bundles = []
    d.sleeving = []
    d.labels = [
      { id: 'lab1', target: { type: 'branch', segmentId: 'segB' }, kind: 'flag', text: 'B', pos: { x: 0, y: 0 } }
    ]
    const afterRemove = produce(d, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(afterRemove.labels[0].target).toEqual({ type: 'branch', segmentId: 'merged' })
  })

  it('sleeving span segmentIds covering both halves are merged', () => {
    // A span that covers [segA, segB] → after remove should be [merged].
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 5, y: 0 } }]
    const bpNode: RouteNode = { type: 'branch', branchId: 'bp1' }
    d.segments = [
      { id: 'segA', from: epNode('cavA'), to: bpNode },
      { id: 'segB', from: bpNode, to: epNode('cavB') }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['segA', 'segB'] }]
    d.bundles = []
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['segA', 'segB'], startFraction: 0.1, endFraction: 0.9 },
        sleevingType: 'braided'
      }
    ]
    d.labels = []
    const afterRemove = produce(d, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(afterRemove.sleeving[0].span.segmentIds).toEqual(['merged'])
    // Fractions are preserved verbatim (no rescaling — see limitation note)
    expect(afterRemove.sleeving[0].span.startFraction).toBe(0.1)
    expect(afterRemove.sleeving[0].span.endFraction).toBe(0.9)
  })

  it('maps a span/bundle covering only ONE merged limb to the merged id (no dangling ref)', () => {
    // Sleeve only segA and bundle only segB — each a single limb of the bend.
    // Before the fix, substituteInPath only collapsed the adjacent pair, leaving
    // the lone 'segA'/'segB' dangling after both were deleted from doc.segments.
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 5, y: 0 } }]
    const bpNode: RouteNode = { type: 'branch', branchId: 'bp1' }
    d.segments = [
      { id: 'segA', from: epNode('cavA'), to: bpNode },
      { id: 'segB', from: bpNode, to: epNode('cavB') }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['segA', 'segB'] }]
    d.bundles = [{ id: 'bnd1', segmentIds: ['segB'], memberWireIds: ['w1'] }]
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['segA'] },
        sleevingType: 'braided'
      }
    ]
    d.labels = []
    const after = produce(d, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(after.segments.map((s) => s.id)).toEqual(['merged'])
    expect(after.wireRoutes[0].path).toEqual(['merged'])
    expect(after.sleeving[0].span.segmentIds).toEqual(['merged']) // not dangling 'segA'
    expect(after.bundles[0].segmentIds).toEqual(['merged']) // not dangling 'segB'
  })

  it('non-existent branch id is a no-op (returns false)', () => {
    const d = base()
    let removed = true
    const result = produce(d, (draft) => {
      removed = applyRemoveBranchPoint(draft, 'ghost', REMOVE_IDS)
    })
    expect(removed).toBe(false)
    expect(result).toEqual(d)
  })

  it('branchPoint-targeted label is retargeted to the merged segment', () => {
    // A degree-2 branch point (bp1) with a label targeting { type:'branchPoint', branchId:'bp1' }.
    // After applyRemoveBranchPoint the label must target { type:'branch', segmentId:'merged' }.
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 5, y: 0 } }]
    const bpNode: RouteNode = { type: 'branch', branchId: 'bp1' }
    d.segments = [
      { id: 'segA', from: epNode('cavA'), to: bpNode },
      { id: 'segB', from: bpNode, to: epNode('cavB') }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['segA', 'segB'] }]
    d.bundles = []
    d.sleeving = []
    d.labels = [
      { id: 'lab1', target: { type: 'branchPoint', branchId: 'bp1' }, kind: 'flag', text: 'B', pos: { x: 5, y: 0 } }
    ]
    const afterRemove = produce(d, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(afterRemove.labels[0].target).toEqual({ type: 'branch', segmentId: 'merged' })
  })
})

// ── applyMergeBranchPoints / syncBundles (bundle authoring in the formboard) ──

const RN = (branchId: string): RouteNode => ({ type: 'branch', branchId })
const wireRec = (id: string, c0: string, c1: string) => ({
  id,
  ends: [
    { type: 'cavity' as const, cavityId: c0 },
    { type: 'cavity' as const, cavityId: c1 }
  ] as [Endpoint, Endpoint],
  gauge: { value: 0.5, unit: 'mm2' as const },
  color: { base: 'GY' }
})
const merge = (d: HarnessDocument, src: string, dst: string): HarnessDocument =>
  produce(d, (draft) => {
    applyMergeBranchPoints(draft, src, dst)
  })

/** w1: a1→bpA→b1, w2: a2→bpB→b2 — two wires each bent at its own branch point. */
function crossingDoc(): HarnessDocument {
  const d = emptyDocument()
  withBodies(d, 'a1', 'b1', 'a2', 'b2')
  d.wires = [wireRec('w1', 'a1', 'b1'), wireRec('w2', 'a2', 'b2')]
  d.branchPoints = [
    { id: 'bpA', pos: { x: 50, y: 0 } },
    { id: 'bpB', pos: { x: 50, y: 4 } }
  ]
  d.segments = [
    { id: 'a1A', from: epNode('a1'), to: RN('bpA') },
    { id: 'Ab1', from: RN('bpA'), to: epNode('b1') },
    { id: 'a2B', from: epNode('a2'), to: RN('bpB') },
    { id: 'Bb2', from: RN('bpB'), to: epNode('b2') }
  ]
  d.wireRoutes = [
    { wireId: 'w1', path: ['a1A', 'Ab1'] },
    { wireId: 'w2', path: ['a2B', 'Bb2'] }
  ]
  return d
}

/**
 * w1: a1→P→R→b1, w2: a2→P→S→b2 — already sharing the start node P, each with its
 * own downstream branch (R / S). Merging S into R makes sPR and sPS parallel.
 */
function preBundleDoc(): HarnessDocument {
  const d = emptyDocument()
  withBodies(d, 'a1', 'b1', 'a2', 'b2')
  d.wires = [wireRec('w1', 'a1', 'b1'), wireRec('w2', 'a2', 'b2')]
  d.branchPoints = [
    { id: 'P', pos: { x: 40, y: 0 } },
    { id: 'R', pos: { x: 80, y: 0 } },
    { id: 'S', pos: { x: 80, y: 4 } }
  ]
  d.segments = [
    { id: 'a1P', from: epNode('a1'), to: RN('P') },
    { id: 'sPR', from: RN('P'), to: RN('R') },
    { id: 'Rb1', from: RN('R'), to: epNode('b1') },
    { id: 'a2P', from: epNode('a2'), to: RN('P') },
    { id: 'sPS', from: RN('P'), to: RN('S') },
    { id: 'Sb2', from: RN('S'), to: epNode('b2') }
  ]
  d.wireRoutes = [
    { wireId: 'w1', path: ['a1P', 'sPR', 'Rb1'] },
    { wireId: 'w2', path: ['a2P', 'sPS', 'Sb2'] }
  ]
  return d
}

/** preBundleDoc + a third wire w3: a3→P→T→b3 (its own downstream branch T). */
function preBundle3Doc(): HarnessDocument {
  const d = preBundleDoc()
  withBodies(d, 'a3', 'b3')
  d.wires.push(wireRec('w3', 'a3', 'b3'))
  d.branchPoints.push({ id: 'T', pos: { x: 80, y: 8 } })
  d.segments.push(
    { id: 'a3P', from: epNode('a3'), to: RN('P') },
    { id: 'sPT', from: RN('P'), to: RN('T') },
    { id: 'Tb3', from: RN('T'), to: epNode('b3') }
  )
  d.wireRoutes.push({ wireId: 'w3', path: ['a3P', 'sPT', 'Tb3'] })
  return d
}

const segDegree = (d: HarnessDocument, branchId: string): number =>
  d.segments.filter(
    (s) =>
      (s.from.type === 'branch' && s.from.branchId === branchId) ||
      (s.to.type === 'branch' && s.to.branchId === branchId)
  ).length

describe('applyMergeBranchPoints', () => {
  it('first merge collapses two branch points into one shared point (no shared limb yet)', () => {
    const d = merge(crossingDoc(), 'bpB', 'bpA')
    expect(d.branchPoints.map((b) => b.id)).toEqual(['bpA'])
    // bpA now carries all four incident limbs (Y-split / crossing), none parallel.
    expect(segDegree(d, 'bpA')).toBe(4)
    expect(d.segments).toHaveLength(4)
    // No segment carries two wires, so there is no bundle yet.
    expect(d.bundles).toHaveLength(0)
    expect(routeConnected(d, 'w1')).toBe(true)
    expect(routeConnected(d, 'w2')).toBe(true)
  })

  it('second merge coalesces the parallel limbs into ONE shared bundle segment', () => {
    const d = merge(preBundleDoc(), 'S', 'R')
    expect(d.branchPoints.map((b) => b.id).sort()).toEqual(['P', 'R'])
    // The duplicate P→R segment (sPS) is gone; both wires now route through sPR.
    expect(d.segments.find((s) => s.id === 'sPS')).toBeUndefined()
    expect(d.wireRoutes.find((r) => r.wireId === 'w1')!.path).toEqual(['a1P', 'sPR', 'Rb1'])
    expect(d.wireRoutes.find((r) => r.wireId === 'w2')!.path).toEqual(['a2P', 'sPR', 'Sb2'])
    expect(routeConnected(d, 'w1')).toBe(true)
    expect(routeConnected(d, 'w2')).toBe(true)
    // The shared limb is a real run for the two wires.
    expect(twistSpanSegments(d, ['w1', 'w2'])).toEqual(['sPR'])
    // …and a first-class Bundle reflects it.
    expect(d.bundles).toHaveLength(1)
    expect(d.bundles[0].segmentIds).toEqual(['sPR'])
    expect([...d.bundles[0].memberWireIds].sort()).toEqual(['w1', 'w2'])
  })

  it('an unlimited number of wires can join one bundle limb (3 wires, different destinations)', () => {
    const d = merge(merge(preBundle3Doc(), 'S', 'R'), 'T', 'R')
    expect(d.segments.find((s) => s.id === 'sPS')).toBeUndefined()
    expect(d.segments.find((s) => s.id === 'sPT')).toBeUndefined()
    for (const w of ['w1', 'w2', 'w3']) {
      expect(d.wireRoutes.find((r) => r.wireId === w)!.path).toContain('sPR')
      expect(routeConnected(d, w)).toBe(true)
    }
    expect(d.bundles).toHaveLength(1)
    expect(d.bundles[0].segmentIds).toEqual(['sPR'])
    expect([...d.bundles[0].memberWireIds].sort()).toEqual(['w1', 'w2', 'w3'])
  })

  it('merging two branch points on ONE wire drops the zero-length self-loop limb', () => {
    const d = emptyDocument()
    withBodies(d, 'a1', 'b1')
    d.wires = [wireRec('w1', 'a1', 'b1')]
    d.branchPoints = [
      { id: 'P', pos: { x: 40, y: 0 } },
      { id: 'R', pos: { x: 80, y: 0 } }
    ]
    d.segments = [
      { id: 'a1P', from: epNode('a1'), to: RN('P') },
      { id: 'sPR', from: RN('P'), to: RN('R') },
      { id: 'Rb1', from: RN('R'), to: epNode('b1') }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['a1P', 'sPR', 'Rb1'] }]
    const out = merge(d, 'R', 'P')
    expect(out.segments.find((s) => s.id === 'sPR')).toBeUndefined()
    expect(out.wireRoutes[0].path).toEqual(['a1P', 'Rb1'])
    expect(out.branchPoints.map((b) => b.id)).toEqual(['P'])
    expect(routeConnected(out, 'w1')).toBe(true)
    expect(out.bundles).toHaveLength(0)
  })

  it('rewrites a sleeving span and a branch label off the coalesced duplicate', () => {
    const base = preBundleDoc()
    base.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w2' },
        span: { segmentIds: ['sPS'] },
        sleevingType: 'braided'
      }
    ]
    base.labels = [
      { id: 'lab1', target: { type: 'branch', segmentId: 'sPS' }, kind: 'flag', text: 'L', pos: { x: 0, y: 0 } }
    ]
    const d = merge(base, 'S', 'R')
    expect(d.sleeving[0].span.segmentIds).toEqual(['sPR'])
    expect(d.labels[0].target).toEqual({ type: 'branch', segmentId: 'sPR' })
  })

  it('mirrors single-segment span fractions when coalescing onto a reversed canonical (B2)', () => {
    const d = emptyDocument()
    d.wires = [wireRec('w1', 'a1', 'b1'), wireRec('w2', 'a2', 'b2')]
    d.branchPoints = [
      { id: 'P', pos: { x: 0, y: 0 } },
      { id: 'R', pos: { x: 40, y: 0 } },
      { id: 'S', pos: { x: 40, y: 4 } }
    ]
    d.segments = [
      { id: 'sPR', from: RN('P'), to: RN('R') }, // canonical P→R
      { id: 'sSP', from: RN('S'), to: RN('P') } // reversed; after S→R becomes R→P
    ]
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w2' },
        span: { segmentIds: ['sSP'], startFraction: 0.6, endFraction: 1 },
        sleevingType: 'braided'
      }
    ]
    const out = merge(d, 'S', 'R')
    expect(out.segments.map((s) => s.id)).toEqual(['sPR'])
    const span = out.sleeving[0].span
    expect(span.segmentIds).toEqual(['sPR']) // remapped — already worked
    expect(span.startFraction).toBeCloseTo(0) // 1 - 1
    expect(span.endFraction).toBeCloseTo(0.4) // 1 - 0.6
  })

  it('preserves an existing bundle id + name across a later merge that grows it', () => {
    const base = merge(preBundle3Doc(), 'S', 'R') // w1,w2 share sPR
    const withName = produce(base, (draft) => {
      draft.bundles[0].id = 'LOOM-A'
      draft.bundles[0].name = 'Main loom'
    })
    const d = merge(withName, 'T', 'R') // w3 joins
    expect(d.bundles).toHaveLength(1)
    expect(d.bundles[0].id).toBe('LOOM-A')
    expect(d.bundles[0].name).toBe('Main loom')
    expect([...d.bundles[0].memberWireIds].sort()).toEqual(['w1', 'w2', 'w3'])
  })

  it('is a no-op (returns false, no mutation) for src === dst or a missing branch point', () => {
    const base = preBundleDoc()
    let same = true
    const a = produce(base, (draft) => {
      same = applyMergeBranchPoints(draft, 'R', 'R')
    })
    expect(same).toBe(false)
    expect(a).toEqual(base)

    let missing = true
    const b = produce(base, (draft) => {
      missing = applyMergeBranchPoints(draft, 'ghost', 'R')
    })
    expect(missing).toBe(false)
    expect(b).toEqual(base)
  })
})

describe('syncBundles', () => {
  it('groups a connected run of shared segments into ONE bundle', () => {
    // Two shared segments meeting at branch R: P→R and R→Q, both carrying w1+w2.
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'P', pos: { x: 0, y: 0 } },
      { id: 'R', pos: { x: 40, y: 0 } },
      { id: 'Q', pos: { x: 80, y: 0 } }
    ]
    d.segments = [
      { id: 'sPR', from: RN('P'), to: RN('R') },
      { id: 'sRQ', from: RN('R'), to: RN('Q') }
    ]
    d.wireRoutes = [
      { wireId: 'w1', path: ['sPR', 'sRQ'] },
      { wireId: 'w2', path: ['sPR', 'sRQ'] }
    ]
    const out = produce(d, (draft) => syncBundles(draft))
    expect(out.bundles).toHaveLength(1)
    expect([...out.bundles[0].segmentIds].sort()).toEqual(['sPR', 'sRQ'])
    expect([...out.bundles[0].memberWireIds].sort()).toEqual(['w1', 'w2'])
  })

  it('keeps two disjoint shared runs as separate bundles, and ignores single-wire segments', () => {
    const d = emptyDocument()
    d.segments = [
      { id: 's1', from: epNode('a'), to: epNode('b') }, // run 1
      { id: 's2', from: epNode('c'), to: epNode('d') }, // run 2 (disjoint)
      { id: 's3', from: epNode('e'), to: epNode('f') } // single wire — not a bundle
    ]
    d.wireRoutes = [
      { wireId: 'w1', path: ['s1'] },
      { wireId: 'w2', path: ['s1'] },
      { wireId: 'w3', path: ['s2'] },
      { wireId: 'w4', path: ['s2'] },
      { wireId: 'w5', path: ['s3'] }
    ]
    const out = produce(d, (draft) => syncBundles(draft))
    expect(out.bundles).toHaveLength(2)
    expect(out.bundles.flatMap((b) => b.segmentIds).sort()).toEqual(['s1', 's2'])
  })

  it('prunes a sleeving/label that targets a bundle which no longer exists', () => {
    const d = emptyDocument()
    d.segments = [{ id: 's1', from: epNode('a'), to: epNode('b') }]
    d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }] // single wire → no bundle
    d.sleeving = [{ id: 'slv', target: { type: 'bundle', bundleId: 'ghost' }, span: { segmentIds: ['s1'] }, sleevingType: 'braided' }]
    d.labels = [{ id: 'lab', target: { type: 'bundle', bundleId: 'ghost' }, kind: 'flag', text: 'B', pos: { x: 0, y: 0 } }]
    const out = produce(d, (draft) => syncBundles(draft))
    expect(out.bundles).toHaveLength(0)
    expect(out.sleeving).toHaveLength(0)
    expect(out.labels).toHaveLength(0)
  })

  it('keeps a bundle-targeted sleeving/label when that bundle survives the recompute', () => {
    const d = emptyDocument()
    d.segments = [{ id: 's1', from: epNode('a'), to: epNode('b') }]
    d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }, { wireId: 'w2', path: ['s1'] }] // shared → bundle
    d.bundles = [{ id: 'bnd', segmentIds: ['s1'], memberWireIds: ['w1', 'w2'] }]
    d.sleeving = [{ id: 'slv', target: { type: 'bundle', bundleId: 'bnd' }, span: { segmentIds: ['s1'] }, sleevingType: 'braided' }]
    d.labels = [{ id: 'lab', target: { type: 'bundle', bundleId: 'bnd' }, kind: 'flag', text: 'B', pos: { x: 0, y: 0 } }]
    const out = produce(d, (draft) => syncBundles(draft))
    expect(out.bundles).toHaveLength(1)
    expect(out.bundles[0].id).toBe('bnd') // id preserved by segment overlap
    expect(out.sleeving).toHaveLength(1)
    expect(out.labels).toHaveLength(1)
  })

  it('carries the loom-tape part (and name) onto the inherited bundle', () => {
    const d = emptyDocument()
    d.segments = [
      { id: 's1', from: epNode('a'), to: epNode('b') },
      { id: 's2', from: epNode('b'), to: epNode('c') }
    ]
    d.wireRoutes = [
      { wireId: 'w1', path: ['s1', 's2'] },
      { wireId: 'w2', path: ['s1', 's2'] }
    ]
    // Prior bundle covered only s1; the recompute grows it to s1+s2 but it is
    // the same bundle (max overlap) — its tape part must not be dropped.
    d.bundles = [
      {
        id: 'bnd',
        name: 'Main trunk',
        segmentIds: ['s1'],
        memberWireIds: ['w1', 'w2'],
        part: { partNumber: 'TAPE-19' }
      }
    ]
    const out = produce(d, (draft) => syncBundles(draft))
    expect(out.bundles).toHaveLength(1)
    expect(out.bundles[0].id).toBe('bnd')
    expect(out.bundles[0].name).toBe('Main trunk')
    expect(out.bundles[0].part).toEqual({ partNumber: 'TAPE-19' })
  })

  it('does not invent a part for a brand-new bundle', () => {
    const d = emptyDocument()
    d.segments = [{ id: 's1', from: epNode('a'), to: epNode('b') }]
    d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }, { wireId: 'w2', path: ['s1'] }]
    const out = produce(d, (draft) => syncBundles(draft))
    expect(out.bundles[0].part).toBeUndefined()
  })
})

describe('applyDisconnectWireAtBranch', () => {
  /** N wires all routed a_i → P → (sPR) → R → b_i, with a Bundle over sPR. */
  function bundleDoc(members: string[]): HarnessDocument {
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'P', pos: { x: 40, y: 0 } },
      { id: 'R', pos: { x: 80, y: 0 } }
    ]
    d.segments = [{ id: 'sPR', from: RN('P'), to: RN('R') }]
    members.forEach((w, i) => {
      withBodies(d, `a${i}`, `b${i}`)
      d.wires.push(wireRec(w, `a${i}`, `b${i}`))
      d.segments.push(
        { id: `a${i}P`, from: epNode(`a${i}`), to: RN('P') },
        { id: `Rb${i}`, from: RN('R'), to: epNode(`b${i}`) }
      )
      d.wireRoutes.push({ wireId: w, path: [`a${i}P`, 'sPR', `Rb${i}`] })
    })
    d.bundles = [{ id: 'bnd', segmentIds: ['sPR'], memberWireIds: [...members] }]
    return d
  }
  const disconnect = (d: HarnessDocument, wireId: string, branchId: string): HarnessDocument =>
    produce(d, (draft) => {
      applyDisconnectWireAtBranch(draft, wireId, branchId, 'bypass')
    })

  it('detaches the wire only at the clicked point P; it stays connected at R; bundle keeps the rest', () => {
    const d = disconnect(bundleDoc(['w1', 'w2', 'w3']), 'w1', 'P')
    // w1 bypasses P (a0→R) but keeps its R→b0 limb — it did NOT go fully direct.
    expect(d.wireRoutes.find((r) => r.wireId === 'w1')!.path).toEqual(['bypass', 'Rb0'])
    expect(routeConnected(d, 'w1')).toBe(true)
    expect(d.segments.find((s) => s.id === 'a0P')).toBeUndefined() // stub GC'd
    expect(d.segments.find((s) => s.id === 'sPR')).toBeDefined() // limb survives for w2,w3
    expect(d.bundles).toHaveLength(1)
    expect([...d.bundles[0].memberWireIds].sort()).toEqual(['w2', 'w3'])
  })

  it('detaching at R instead keeps the P-side stub (only the clicked point changes)', () => {
    const d = disconnect(bundleDoc(['w1', 'w2', 'w3']), 'w1', 'R')
    expect(d.wireRoutes.find((r) => r.wireId === 'w1')!.path).toEqual(['a0P', 'bypass'])
    expect(d.segments.find((s) => s.id === 'Rb0')).toBeUndefined()
    expect(routeConnected(d, 'w1')).toBe(true)
    expect([...d.bundles[0].memberWireIds].sort()).toEqual(['w2', 'w3'])
  })

  it('disconnecting the last-but-one wire dissolves the bundle and drops its sleeve + label', () => {
    const base = bundleDoc(['w1', 'w2'])
    base.sleeving = [{ id: 'slv', target: { type: 'bundle', bundleId: 'bnd' }, span: { segmentIds: ['sPR'] }, sleevingType: 'braided' }]
    base.labels = [{ id: 'lab', target: { type: 'bundle', bundleId: 'bnd' }, kind: 'flag', text: 'B', pos: { x: 0, y: 0 } }]
    const d = disconnect(base, 'w1', 'P')
    expect(d.bundles).toHaveLength(0)
    expect(d.sleeving).toHaveLength(0)
    expect(d.labels).toHaveLength(0)
    expect(d.wireRoutes.find((r) => r.wireId === 'w1')!.path).toEqual(['bypass', 'Rb0'])
    expect(routeConnected(d, 'w1')).toBe(true)
    expect(routeConnected(d, 'w2')).toBe(true)
  })

  it('on a two-limb bundle, detaching at P leaves the wire bundled on the OTHER limb', () => {
    // w1,w2: a→P→(sPR)→R→(sRQ)→Q→b. Bundle covers both shared limbs.
    const d0 = emptyDocument()
    d0.branchPoints = [
      { id: 'P', pos: { x: 0, y: 0 } },
      { id: 'R', pos: { x: 40, y: 0 } },
      { id: 'Q', pos: { x: 80, y: 0 } }
    ]
    withBodies(d0, 'a1', 'b1', 'a2', 'b2')
    d0.wires.push(wireRec('w1', 'a1', 'b1'), wireRec('w2', 'a2', 'b2'))
    d0.segments = [
      { id: 'sPR', from: RN('P'), to: RN('R') },
      { id: 'sRQ', from: RN('R'), to: RN('Q') },
      { id: 'a1P', from: epNode('a1'), to: RN('P') },
      { id: 'Qb1', from: RN('Q'), to: epNode('b1') },
      { id: 'a2P', from: epNode('a2'), to: RN('P') },
      { id: 'Qb2', from: RN('Q'), to: epNode('b2') }
    ]
    d0.wireRoutes = [
      { wireId: 'w1', path: ['a1P', 'sPR', 'sRQ', 'Qb1'] },
      { wireId: 'w2', path: ['a2P', 'sPR', 'sRQ', 'Qb2'] }
    ]
    d0.bundles = [{ id: 'bnd', segmentIds: ['sPR', 'sRQ'], memberWireIds: ['w1', 'w2'] }]

    const d = disconnect(d0, 'w1', 'P')
    // w1 left sPR (now w2-only) but still shares sRQ → still bundled there.
    expect(d.wireRoutes.find((r) => r.wireId === 'w1')!.path).toEqual(['bypass', 'sRQ', 'Qb1'])
    expect(routeConnected(d, 'w1')).toBe(true)
    expect(d.bundles).toHaveLength(1)
    expect(d.bundles[0].segmentIds).toEqual(['sRQ'])
    expect([...d.bundles[0].memberWireIds].sort()).toEqual(['w1', 'w2'])
  })

  it('is a no-op (returns false, no mutation) for a missing wire or a branch not on its route', () => {
    const base = bundleDoc(['w1', 'w2'])
    let r1 = true
    const o1 = produce(base, (draft) => {
      r1 = applyDisconnectWireAtBranch(draft, 'ghost', 'P', 'bypass')
    })
    expect(r1).toBe(false)
    expect(o1).toEqual(base)
    let r2 = true
    const o2 = produce(base, (draft) => {
      r2 = applyDisconnectWireAtBranch(draft, 'w1', 'nope', 'bypass')
    })
    expect(r2).toBe(false)
    expect(o2).toEqual(base)
  })
})

// ── label anchor rewrites across routing ops ─────────────────────────────────
describe('label anchor rewrites', () => {
  const RMIDS: RemoveBranchIds = { mergedSegId: 'merged' }
  const anchored = (
    id: string,
    target: Label['target'],
    segmentId: string,
    fraction: number
  ): Label => ({ id, target, kind: 'flag', text: id, pos: { x: 0, y: 0 }, anchor: { segmentId, fraction } })

  it('insert: rescales the anchor fraction onto the correct child limb', () => {
    const d = base() // unplaced endpoints → split t = 0.5
    d.labels = [
      anchored('near', { type: 'wire', wireId: 'w1' }, 'seg1', 0.25),
      anchored('far', { type: 'wire', wireId: 'w1' }, 'seg1', 0.75),
      anchored('mid', { type: 'wire', wireId: 'w1' }, 'seg1', 0.5)
    ]
    const out = run(d)
    expect(out.labels.find((l) => l.id === 'near')!.anchor).toEqual({ segmentId: 'segA', fraction: 0.5 })
    expect(out.labels.find((l) => l.id === 'far')!.anchor).toEqual({ segmentId: 'segB', fraction: 0.5 })
    expect(out.labels.find((l) => l.id === 'mid')!.anchor).toEqual({ segmentId: 'segA', fraction: 1 })
  })

  it('merge coalesce: retargets the anchor onto the canonical segment (same orientation keeps fraction)', () => {
    const d = preBundleDoc()
    d.labels = [anchored('l', { type: 'wire', wireId: 'w2' }, 'sPS', 0.3)]
    const out = merge(d, 'S', 'R')
    expect(out.segments.find((s) => s.id === 'sPS')).toBeUndefined()
    expect(out.labels[0].anchor).toEqual({ segmentId: 'sPR', fraction: 0.3 })
  })

  it('merge coalesce: flips the fraction when the duplicate ran the opposite direction', () => {
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'P', pos: { x: 0, y: 0 } },
      { id: 'R', pos: { x: 40, y: 0 } },
      { id: 'S', pos: { x: 40, y: 4 } }
    ]
    d.segments = [
      { id: 'sPR', from: RN('P'), to: RN('R') }, // canonical P→R
      { id: 'sSP', from: RN('S'), to: RN('P') } // reversed; after S→R becomes R→P
    ]
    d.labels = [anchored('l', { type: 'branch', segmentId: 'sSP' }, 'sSP', 0.3)]
    const out = merge(d, 'S', 'R')
    expect(out.segments.map((s) => s.id)).toEqual(['sPR'])
    expect(out.labels[0].anchor).toEqual({ segmentId: 'sPR', fraction: 0.7 })
    expect(out.labels[0].target).toEqual({ type: 'branch', segmentId: 'sPR' })
  })

  it('remove branch point: retargets an anchor on a merged limb onto the merged segment', () => {
    const withLabel = produce(run(base()), (draft) => {
      draft.labels = [anchored('l', { type: 'wire', wireId: 'w1' }, 'segB', 0.4)]
    })
    const out = produce(withLabel, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', RMIDS)
    })
    expect(out.labels[0].anchor!.segmentId).toBe('merged')
  })

  it('disconnect: re-derives an anchor whose segment was GC\'d, keeps a surviving one, never deletes the label', () => {
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'P', pos: { x: 40, y: 0 } },
      { id: 'R', pos: { x: 80, y: 0 } }
    ]
    d.segments = [
      { id: 'sPR', from: RN('P'), to: RN('R') },
      { id: 'a0P', from: epNode('a0'), to: RN('P') },
      { id: 'Rb0', from: RN('R'), to: epNode('b0') },
      { id: 'a1P', from: epNode('a1'), to: RN('P') },
      { id: 'Rb1', from: RN('R'), to: epNode('b1') }
    ]
    withBodies(d, 'a0', 'b0', 'a1', 'b1')
    d.wires = [wireRec('w1', 'a0', 'b0'), wireRec('w2', 'a1', 'b1')]
    d.wireRoutes = [
      { wireId: 'w1', path: ['a0P', 'sPR', 'Rb0'] },
      { wireId: 'w2', path: ['a1P', 'sPR', 'Rb1'] }
    ]
    d.bundles = [{ id: 'bnd', segmentIds: ['sPR'], memberWireIds: ['w1', 'w2'] }]
    d.labels = [
      anchored('stub', { type: 'wire', wireId: 'w1' }, 'a0P', 0.5), // a0P spliced out + GC'd
      anchored('shared', { type: 'wire', wireId: 'w2' }, 'sPR', 0.6) // survives
    ]
    const out = produce(d, (draft) => {
      applyDisconnectWireAtBranch(draft, 'w1', 'P', 'bypass')
    })
    const live = new Set(out.segments.map((s) => s.id))
    const stub = out.labels.find((l) => l.id === 'stub')!
    expect(stub).toBeDefined() // label survives
    expect(stub.anchor).toEqual({ segmentId: 'Rb0', fraction: 0.5 }) // re-derived from w1's new route
    expect(live.has(stub.anchor!.segmentId)).toBe(true)
    expect(out.labels.find((l) => l.id === 'shared')!.anchor).toEqual({ segmentId: 'sPR', fraction: 0.6 })
  })
})

// ── R4: a segment must not survive only because a treatment references it ────

describe('ghost treatment-only segments (R4)', () => {
  /** Same fixture as applyDisconnectWireAtBranch's bundleDoc, three members. */
  function bundle3(): HarnessDocument {
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'P', pos: { x: 40, y: 0 } },
      { id: 'R', pos: { x: 80, y: 0 } }
    ]
    d.segments = [{ id: 'sPR', from: RN('P'), to: RN('R') }]
    ;['w1', 'w2', 'w3'].forEach((w, i) => {
      withBodies(d, `a${i}`, `b${i}`)
      d.wires.push(wireRec(w, `a${i}`, `b${i}`))
      d.segments.push(
        { id: `a${i}P`, from: epNode(`a${i}`), to: RN('P') },
        { id: `Rb${i}`, from: RN('R'), to: epNode(`b${i}`) }
      )
      d.wireRoutes.push({ wireId: w, path: [`a${i}P`, 'sPR', `Rb${i}`] })
    })
    d.bundles = [{ id: 'bnd', segmentIds: ['sPR'], memberWireIds: ['w1', 'w2', 'w3'] }]
    return d
  }
  const disconnectAtP = (d: HarnessDocument): HarnessDocument =>
    produce(d, (draft) => {
      applyDisconnectWireAtBranch(draft, 'w1', 'P', 'bypass')
    })

  it('GCs a stub the wire abandoned even though a twist span still named it', () => {
    const d = bundle3()
    d.twists = [{ id: 'tw1', wireIds: ['w1', 'w2', 'w3'], span: { segmentIds: ['a0P', 'sPR'] } }]
    const after = disconnectAtP(d)
    // a0P carries no wire route any more: it must not linger as a wire-less line.
    expect(after.segments.some((s) => s.id === 'a0P')).toBe(false)
    expect(after.twists[0].span.segmentIds).toEqual(['sPR'])
  })

  it('GCs a stub kept alive only by a sleeving span, and drops the emptied sleeve', () => {
    const d = bundle3()
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w2' }, // not w1, so wire-pruning is not what removes it
        span: { segmentIds: ['a0P'] },
        sleevingType: 'braided'
      }
    ]
    const after = disconnectAtP(d)
    expect(after.segments.some((s) => s.id === 'a0P')).toBe(false)
    expect(after.sleeving).toHaveLength(0)
  })
})

// ── R3: a topology op must not leave a treatment with an emptied span ─────────

describe('empty-span treatments after a topology op (R3)', () => {
  /** preBundleDoc + a sleeve and a twist whose ONLY segment is sPR. */
  function withSpansOnSPR(): HarnessDocument {
    const d = preBundleDoc()
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['sPR'], startFraction: 0.2, endFraction: 0.8 },
        sleevingType: 'braided'
      }
    ]
    d.twists = [{ id: 'tw1', wireIds: ['w1', 'w2'], span: { segmentIds: ['sPR'] } }]
    return d
  }

  it('removes a sleeve whose only segment collapsed into a self-loop', () => {
    // Merging P into R turns sPR (P→R) into a zero-length self-loop, which the
    // merge drops — leaving the sleeve covering nothing (a 0 mm BOM line).
    const after = merge(withSpansOnSPR(), 'P', 'R')
    expect(after.segments.some((s) => s.id === 'sPR')).toBe(false)
    expect(after.sleeving).toHaveLength(0)
  })

  it('removes a twist whose only segment collapsed into a self-loop', () => {
    expect(merge(withSpansOnSPR(), 'P', 'R').twists).toHaveLength(0)
  })

  it('leaves a treatment that was authored with an empty span alone', () => {
    // The twist UI creates a twist BEFORE its wires are co-routed; that empty
    // span is a legal intermediate, not something a topology op just broke.
    const d = preBundleDoc()
    d.twists = [{ id: 'tw-pending', wireIds: ['w1', 'w2'], span: { segmentIds: [] } }]
    expect(merge(d, 'S', 'R').twists.map((t) => t.id)).toEqual(['tw-pending'])
  })

  it('keeps a treatment whose span survives the merge', () => {
    const d = preBundleDoc()
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['Rb1'] },
        sleevingType: 'braided'
      }
    ]
    const after = merge(d, 'S', 'R')
    expect(after.sleeving).toHaveLength(1)
    expect(after.sleeving[0].span.segmentIds).toEqual(['Rb1'])
  })
})


// ── the other two topology ops must keep spans contiguous too (R2) ───────────

describe('span contiguity across insert / remove branch point (R2)', () => {
  /** cavA → bpX → cavB, one wire, one sleeve over BOTH segments. */
  function twoSegmentSpan(): HarnessDocument {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'X', pos: { x: 50, y: 0 } }]
    d.segments = [
      { id: 's1', from: epNode('cavA'), to: RN('X') },
      { id: 's2', from: RN('X'), to: epNode('cavB') }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['s1', 's2'] }]
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['s1', 's2'], startFraction: 0.3, endFraction: 0.7 },
        sleevingType: 'braided'
      }
    ]
    return d
  }

  it('insert leaves the span one contiguous chain', () => {
    const d = produce(twoSegmentSpan(), (draft) =>
      applyInsertBranchPoint(draft, 's1', { x: 25, y: 0 }, IDS)
    )
    expect(d.sleeving[0].span.segmentIds.length).toBeGreaterThan(0)
    expect(isSpanContiguous(d, d.sleeving[0].span.segmentIds)).toBe(true)
  })

  it('remove-branch-point leaves the span one contiguous chain', () => {
    const d = produce(twoSegmentSpan(), (draft) => {
      applyRemoveBranchPoint(draft, 'X', REMOVE_IDS)
    })
    expect(d.sleeving[0].span.segmentIds.length).toBeGreaterThan(0)
    expect(isSpanContiguous(d, d.sleeving[0].span.segmentIds)).toBe(true)
  })
})

// ── Typed segment length (Segment.specifiedLengthMm) across topology ops ─────
//
// A typed length is the limb's cut length, so every topology op must preserve
// the EFFECTIVE length a wire sums: insert splits it, heal sums it, merge keeps
// one value on the surviving segment. Never copy a typed value onto both halves
// of a split — that doubles the cut length.

/** cavA(0,0) ── seg1 ── cavB(1000,0), drawn 1000; wire w1 routed [seg1]. */
function typedLineDoc(typed?: number): HarnessDocument {
  const d = emptyDocument()
  withBodies(d, 'cavA', 'cavB')
  d.placements = [
    { refId: 'cavA', pos: { x: 0, y: 0 } },
    { refId: 'cavB', pos: { x: 1000, y: 0 } }
  ]
  d.wires = [wireRec('w1', 'cavA', 'cavB')]
  d.segments = [{ id: 'seg1', from: epNode('cavA'), to: epNode('cavB') }]
  if (typed != null) d.segments[0].specifiedLengthMm = typed
  d.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
  return d
}

/** cavA(0,0) ── s1 ── bp(400,0) ── s2 ── cavB(700,0): drawn 400 + 300. */
function typedBendDoc(t1?: number, t2?: number): HarnessDocument {
  const d = emptyDocument()
  withBodies(d, 'cavA', 'cavB')
  d.placements = [
    { refId: 'cavA', pos: { x: 0, y: 0 } },
    { refId: 'cavB', pos: { x: 700, y: 0 } }
  ]
  d.branchPoints = [{ id: 'bp', pos: { x: 400, y: 0 } }]
  d.wires = [wireRec('w1', 'cavA', 'cavB')]
  d.segments = [
    { id: 's1', from: epNode('cavA'), to: RN('bp') },
    { id: 's2', from: RN('bp'), to: epNode('cavB') }
  ]
  if (t1 != null) d.segments[0].specifiedLengthMm = t1
  if (t2 != null) d.segments[1].specifiedLengthMm = t2
  d.wireRoutes = [{ wireId: 'w1', path: ['s1', 's2'] }]
  return d
}

const segOf = (d: HarnessDocument, id: string) => d.segments.find((s) => s.id === id)!

describe('typed segment length: insert splits it proportionally', () => {
  it('drawn 1000, typed 1200, insert at 25 % → halves 300 and 900 (sum exactly 1200)', () => {
    const before = typedLineDoc(1200)
    expect(wireLength(before, 'w1').mm).toBe(1200)
    const d = produce(before, (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 250, y: 0 }, IDS)
    )
    const a = segOf(d, 'segA').specifiedLengthMm!
    const b = segOf(d, 'segB').specifiedLengthMm!
    expect(a).toBe(300)
    expect(b).toBe(900)
    expect(a + b).toBe(1200)
    // The cut length is unchanged by the split.
    expect(wireLength(d, 'w1').mm).toBe(1200)
  })

  it('a reversed route keeps its cut length too', () => {
    const before = typedLineDoc(1200)
    const rev = produce(before, (d) => {
      d.wires[0].ends = [d.wires[0].ends[1], d.wires[0].ends[0]]
    })
    const d = produce(rev, (draft) => applyInsertBranchPoint(draft, 'seg1', { x: 250, y: 0 }, IDS))
    expect(wireLength(d, 'w1').mm).toBe(1200)
  })

  const insertAt = (typed: number, pos: { x: number; y: number }) =>
    produce(typedLineDoc(typed), (draft) => applyInsertBranchPoint(draft, 'seg1', pos, IDS))

  it('a click past the end (-10,0) splits 10:1010 by the drawn pieces — both > 0, sum exactly 1200', () => {
    const d = insertAt(1200, { x: -10, y: 0 })
    const a = segOf(d, 'segA').specifiedLengthMm!
    const b = segOf(d, 'segB').specifiedLengthMm!
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    expect(a + b).toBe(1200)
    expect(a / b).toBeCloseTo(10 / 1010, 12)
    expect(wireLength(d, 'w1').mm).toBe(1200)
  })

  it('an off-axis click splits in proportion to the two drawn pieces |a−pos| : |pos−b|', () => {
    const d = insertAt(1200, { x: 250, y: 300 })
    const a = segOf(d, 'segA').specifiedLengthMm!
    const b = segOf(d, 'segB').specifiedLengthMm!
    expect(a / b).toBeCloseTo(Math.hypot(250, 300) / Math.hypot(750, 300), 12)
    expect(a + b).toBe(1200)
    expect(wireLength(d, 'w1').mm).toBe(1200)
  })

  it.each([
    [{ x: 0, y: 0 }, 'segA', 'segB'],
    [{ x: 1000, y: 0 }, 'segB', 'segA']
  ])('a click exactly on an endpoint %o: zero-length half untyped, the other takes all 1200', (pos, empty, full) => {
    const d = insertAt(1200, pos)
    expect('specifiedLengthMm' in segOf(d, empty)).toBe(false)
    expect(segOf(d, full).specifiedLengthMm).toBe(1200)
    expect(wireLength(d, 'w1').mm).toBe(1200)
  })

  it('a click a hair from the far end never stores a sub-epsilon sliver', () => {
    const d = insertAt(1200, { x: 1000 - 1e-12, y: 0 })
    for (const id of ['segA', 'segB']) {
      const v = segOf(d, id).specifiedLengthMm
      expect(v == null || v > 1e-6).toBe(true)
    }
    expect(wireLength(d, 'w1').mm).toBeCloseTo(1200, 9)
  })

  it('an untyped segment splits into two untyped halves (no key at all)', () => {
    const d = produce(typedLineDoc(), (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 250, y: 0 }, IDS)
    )
    expect('specifiedLengthMm' in segOf(d, 'segA')).toBe(false)
    expect('specifiedLengthMm' in segOf(d, 'segB')).toBe(false)
    expect(wireLength(d, 'w1').mm).toBe(1000)
  })
})

describe('typed segment length: heal sums typed and drawn', () => {
  it('typed 500 + untyped drawn 300 → merged typed 800, cut length unchanged', () => {
    const before = typedBendDoc(500, undefined)
    expect(wireLength(before, 'w1').mm).toBe(800)
    const d = produce(before, (draft) => {
      expect(applyRemoveBranchPoint(draft, 'bp', REMOVE_IDS)).toBe(true)
    })
    expect(segOf(d, 'merged').specifiedLengthMm).toBe(800)
    expect(wireLength(d, 'w1').mm).toBe(800)
  })

  it('untyped drawn 400 + typed 250 → merged typed 650', () => {
    const d = produce(typedBendDoc(undefined, 250), (draft) => {
      applyRemoveBranchPoint(draft, 'bp', REMOVE_IDS)
    })
    expect(segOf(d, 'merged').specifiedLengthMm).toBe(650)
  })

  it('both untyped → merged untyped (no key), length is the drawn 700', () => {
    const d = produce(typedBendDoc(), (draft) => {
      applyRemoveBranchPoint(draft, 'bp', REMOVE_IDS)
    })
    expect('specifiedLengthMm' in segOf(d, 'merged')).toBe(false)
    expect(wireLength(d, 'w1').mm).toBe(700)
  })

  it('a half whose drawn length is unresolvable (unplaced body) leaves the merged segment untyped', () => {
    const before = produce(typedBendDoc(500, undefined), (d) => {
      d.placements = d.placements.filter((p) => p.refId !== 'cavB')
    })
    const d = produce(before, (draft) => {
      expect(applyRemoveBranchPoint(draft, 'bp', REMOVE_IDS)).toBe(true)
    })
    expect('specifiedLengthMm' in segOf(d, 'merged')).toBe(false)
  })

  it('insert then heal round-trips a typed 1200 back to 1200', () => {
    const ins = produce(typedLineDoc(1200), (draft) =>
      applyInsertBranchPoint(draft, 'seg1', { x: 250, y: 0 }, IDS)
    )
    const d = produce(ins, (draft) => {
      applyRemoveBranchPoint(draft, 'bp1', REMOVE_IDS)
    })
    expect(segOf(d, 'merged').specifiedLengthMm).toBe(1200)
  })
})

describe('typed segment length: merge coalescing keeps one value', () => {
  it('carries a lone typed value from the absorbed duplicate onto the canonical', () => {
    const before = produce(preBundleDoc(), (d) => {
      segOf(d, 'sPS').specifiedLengthMm = 123
    })
    const d = merge(before, 'S', 'R')
    expect(d.segments.find((s) => s.id === 'sPS')).toBeUndefined()
    expect(segOf(d, 'sPR').specifiedLengthMm).toBe(123)
  })

  it('the canonical keeps its own typed value when the duplicate has none', () => {
    const before = produce(preBundleDoc(), (d) => {
      segOf(d, 'sPR').specifiedLengthMm = 77
    })
    expect(segOf(merge(before, 'S', 'R'), 'sPR').specifiedLengthMm).toBe(77)
  })

  it('two different typed values: the canonical keeps its own', () => {
    const before = produce(preBundleDoc(), (d) => {
      segOf(d, 'sPR').specifiedLengthMm = 77
      segOf(d, 'sPS').specifiedLengthMm = 123
    })
    expect(segOf(merge(before, 'S', 'R'), 'sPR').specifiedLengthMm).toBe(77)
  })

  it('neither typed → canonical stays untyped (no key)', () => {
    expect('specifiedLengthMm' in segOf(merge(preBundleDoc(), 'S', 'R'), 'sPR')).toBe(false)
  })
})
