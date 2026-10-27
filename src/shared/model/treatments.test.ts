import { describe, it, expect } from 'vitest'
import { emptyDocument } from './document'
import type { HarnessDocument, Id } from './schema'
import {
  wireRoutePath,
  twistSpanSegments,
  sleevingFromSegments,
  sleevingBundleFromSegments,
  labelDefaultPos,
  projectFraction,
  labelAnchorPos,
  defaultAnchor,
  anchorMmFromNearestEnd,
  anchorFractionFromNearestEnd,
  isSpanContiguous,
  largestContiguousRun
} from './treatments'

/** Minimal doc: segments s1..s3 (geometry via branch points), two wires. */
function fixture(): HarnessDocument {
  const d = emptyDocument()
  d.branchPoints.push(
    { id: 'n0', pos: { x: 0, y: 0 } },
    { id: 'n1', pos: { x: 10, y: 0 } },
    { id: 'n2', pos: { x: 30, y: 0 } },
    { id: 'n3', pos: { x: 60, y: 0 } }
  )
  const seg = (id: Id, from: string, to: string): void => {
    d.segments.push({
      id,
      from: { type: 'branch', branchId: from },
      to: { type: 'branch', branchId: to }
    })
  }
  seg('s1', 'n0', 'n1')
  seg('s2', 'n1', 'n2')
  seg('s3', 'n2', 'n3')
  d.wires.push(
    {
      id: 'w1',
      ends: [
        { type: 'splice', spliceId: 'x' },
        { type: 'splice', spliceId: 'y' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'GY' }
    },
    {
      id: 'w2',
      ends: [
        { type: 'splice', spliceId: 'x' },
        { type: 'splice', spliceId: 'z' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'GY' }
    }
  )
  return d
}

describe('wireRoutePath', () => {
  it('returns the ordered segment ids of the route, [] when none', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2'] })
    expect(wireRoutePath(d, 'w1')).toEqual(['s1', 's2'])
    expect(wireRoutePath(d, 'w2')).toEqual([])
  })
})

describe('twistSpanSegments', () => {
  it('full overlap → the whole shared run, ordered by the first wire', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2'] }, { wireId: 'w2', path: ['s1', 's2'] })
    expect(twistSpanSegments(d, ['w1', 'w2'])).toEqual(['s1', 's2'])
  })
  it('partial overlap → only the shared segments', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2'] }, { wireId: 'w2', path: ['s2', 's3'] })
    expect(twistSpanSegments(d, ['w1', 'w2'])).toEqual(['s2'])
  })
  it('disjoint routes → []', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1'] }, { wireId: 'w2', path: ['s3'] })
    expect(twistSpanSegments(d, ['w1', 'w2'])).toEqual([])
  })
  it('fewer than two wires → []', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1'] })
    expect(twistSpanSegments(d, ['w1'])).toEqual([])
  })
})

describe('sleevingFromSegments', () => {
  it('one common wire + contiguous selection → that wire + ordered segments', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2', 's3'] })
    expect(sleevingFromSegments(d, ['s2', 's1'])).toEqual({
      wireId: 'w1',
      orderedSegmentIds: ['s1', 's2']
    })
  })
  it('non-contiguous subsequence → null', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2', 's3'] })
    expect(sleevingFromSegments(d, ['s1', 's3'])).toBeNull()
  })
  it('two common wires → null (ambiguous target)', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2'] }, { wireId: 'w2', path: ['s1', 's2'] })
    expect(sleevingFromSegments(d, ['s1'])).toBeNull()
  })
  it('no common wire / empty selection → null', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1'] })
    expect(sleevingFromSegments(d, ['s3'])).toBeNull()
    expect(sleevingFromSegments(d, [])).toBeNull()
  })
})

describe('sleevingBundleFromSegments', () => {
  /** fixture + both wires routed s1→s2→s3 and a bundle over s1,s2,s3. */
  function bundled(bundleSegs: Id[]): HarnessDocument {
    const d = fixture()
    d.wireRoutes.push(
      { wireId: 'w1', path: ['s1', 's2', 's3'] },
      { wireId: 'w2', path: ['s1', 's2', 's3'] }
    )
    // segmentIds deliberately NOT in route order — ordering must come from a
    // member wire's route, never from bundle.segmentIds (document order).
    d.bundles.push({ id: 'bnd', segmentIds: bundleSegs, memberWireIds: ['w1', 'w2'] })
    return d
  }

  it('contiguous selection inside one bundle → that bundle + route-ordered segments', () => {
    const d = bundled(['s3', 's1', 's2'])
    expect(sleevingBundleFromSegments(d, ['s2', 's1'])).toEqual({
      bundleId: 'bnd',
      orderedSegmentIds: ['s1', 's2']
    })
  })

  it('a single bundle segment → that bundle', () => {
    expect(sleevingBundleFromSegments(bundled(['s1', 's2', 's3']), ['s2'])).toEqual({
      bundleId: 'bnd',
      orderedSegmentIds: ['s2']
    })
  })

  it('non-contiguous selection within the bundle → null', () => {
    expect(sleevingBundleFromSegments(bundled(['s1', 's2', 's3']), ['s1', 's3'])).toBeNull()
  })

  it('a segment outside the bundle → null', () => {
    const d = fixture()
    d.wireRoutes.push(
      { wireId: 'w1', path: ['s1', 's2', 's3'] },
      { wireId: 'w2', path: ['s1', 's2'] }
    )
    d.bundles.push({ id: 'bnd', segmentIds: ['s1', 's2'], memberWireIds: ['w1', 'w2'] })
    expect(sleevingBundleFromSegments(d, ['s3'])).toBeNull()
  })

  it('a shared segment with no Bundle entity, or an empty selection → null', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1'] }, { wireId: 'w2', path: ['s1'] })
    expect(sleevingBundleFromSegments(d, ['s1'])).toBeNull()
    expect(sleevingBundleFromSegments(d, [])).toBeNull()
  })
})

describe('labelDefaultPos', () => {
  it('branchPoint → its pos; segment → midpoint; wire → middle-segment midpoint', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2', 's3'] })
    expect(labelDefaultPos(d, { type: 'branchPoint', branchId: 'n2' })).toEqual({ x: 30, y: 0 })
    expect(labelDefaultPos(d, { type: 'branch', segmentId: 's1' })).toEqual({ x: 5, y: 0 })
    expect(labelDefaultPos(d, { type: 'wire', wireId: 'w1' })).toEqual({ x: 20, y: 0 })
  })
  it('unresolved target → {0,0}', () => {
    const d = fixture()
    expect(labelDefaultPos(d, { type: 'branchPoint', branchId: 'nope' })).toEqual({ x: 0, y: 0 })
    expect(labelDefaultPos(d, { type: 'bundle', bundleId: 'nope' })).toEqual({ x: 0, y: 0 })
  })
})

describe('projectFraction', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 10, y: 0 }
  it('projects onto the line and is independent of perpendicular distance', () => {
    expect(projectFraction(a, b, { x: 5, y: 7 })).toBeCloseTo(0.5)
    expect(projectFraction(a, b, { x: 2.5, y: -3 })).toBeCloseTo(0.25)
  })
  it('clamps to [0,1] for points past either end', () => {
    expect(projectFraction(a, b, { x: -5, y: 0 })).toBe(0)
    expect(projectFraction(a, b, { x: 15, y: 0 })).toBe(1)
  })
  it('zero-length segment yields 0', () => {
    expect(projectFraction(a, a, { x: 9, y: 9 })).toBe(0)
  })
})

describe('labelAnchorPos', () => {
  it('lerps the resolved segment endpoints by fraction', () => {
    const d = fixture() // s2 spans n1(10,0)→n2(30,0)
    expect(labelAnchorPos(d, { segmentId: 's2', fraction: 0.5 })).toEqual({ x: 20, y: 0 })
    expect(labelAnchorPos(d, { segmentId: 's2', fraction: 0.25 })).toEqual({ x: 15, y: 0 })
  })
  it('null for a missing segment', () => {
    expect(labelAnchorPos(fixture(), { segmentId: 'nope', fraction: 0.5 })).toBeNull()
  })
})

describe('defaultAnchor', () => {
  it('wire → middle route segment @0.5; branch → that segment; bundle → middle', () => {
    const d = fixture()
    d.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2', 's3'] })
    d.bundles.push({ id: 'bnd', segmentIds: ['s1', 's2', 's3'], memberWireIds: ['w1', 'w2'] })
    expect(defaultAnchor(d, { type: 'wire', wireId: 'w1' })).toEqual({ segmentId: 's2', fraction: 0.5 })
    expect(defaultAnchor(d, { type: 'branch', segmentId: 's1' })).toEqual({ segmentId: 's1', fraction: 0.5 })
    expect(defaultAnchor(d, { type: 'bundle', bundleId: 'bnd' })).toEqual({ segmentId: 's2', fraction: 0.5 })
  })
  it('null for branchPoint target and for an unrouted wire', () => {
    const d = fixture()
    expect(defaultAnchor(d, { type: 'branchPoint', branchId: 'n1' })).toBeNull()
    expect(defaultAnchor(d, { type: 'wire', wireId: 'w1' })).toBeNull()
  })
  it('defaultAnchor returns null for a branch target whose segment is gone (B3)', () => {
    const doc = emptyDocument()
    expect(defaultAnchor(doc, { type: 'branch', segmentId: 'gone' })).toBeNull()
  })
})

describe('anchor mm-from-nearest-end', () => {
  it('reports the distance from whichever end is closer', () => {
    expect(anchorMmFromNearestEnd(0.25, 100)).toBe(25) // 25 from start, 75 from end
    expect(anchorMmFromNearestEnd(0.8, 100)).toBeCloseTo(20) // 80 from start, 20 from end
    expect(anchorMmFromNearestEnd(0.5, 100)).toBe(50)
  })

  it('inverts: places the anchor mm from the currently-nearest end, clamped', () => {
    // currently near the START (fraction 0.25 ≤ 0.5) → measured from start
    expect(anchorFractionFromNearestEnd(0.25, 30, 100)).toBeCloseTo(0.3)
    // currently near the END (fraction 0.8 > 0.5) → measured from end
    expect(anchorFractionFromNearestEnd(0.8, 30, 100)).toBeCloseTo(0.7)
    // clamps past the far end
    expect(anchorFractionFromNearestEnd(0.25, 250, 100)).toBe(1)
    // non-positive length → unchanged
    expect(anchorFractionFromNearestEnd(0.4, 10, 0)).toBe(0.4)
  })
})


describe('span contiguity (R2)', () => {
  it('accepts a chain of segments that meet end to end', () => {
    const d = fixture()
    expect(isSpanContiguous(d, ['s1', 's2', 's3'])).toBe(true)
    expect(isSpanContiguous(d, ['s2'])).toBe(true)
  })

  it('accepts a reversed chain (spans have no intrinsic direction)', () => {
    expect(isSpanContiguous(fixture(), ['s3', 's2', 's1'])).toBe(true)
  })

  it('rejects a gap in the chain', () => {
    expect(isSpanContiguous(fixture(), ['s1', 's3'])).toBe(false)
  })

  it('rejects a repeated segment id', () => {
    expect(isSpanContiguous(fixture(), ['s1', 's1'])).toBe(false)
  })

  it('rejects a span containing a segment that does not exist', () => {
    expect(isSpanContiguous(fixture(), ['s1', 'ghost'])).toBe(false)
  })

  it('treats the empty span as contiguous (the twist UI authors one on purpose)', () => {
    expect(isSpanContiguous(fixture(), [])).toBe(true)
  })

  it('largestContiguousRun keeps the longest surviving run', () => {
    const d = fixture()
    expect(largestContiguousRun(d, ['s1', 'ghost', 's2', 's3'])).toEqual(['s2', 's3'])
    expect(largestContiguousRun(d, ['s1', 's3'])).toEqual(['s1'])
    expect(largestContiguousRun(d, [])).toEqual([])
    expect(largestContiguousRun(d, ['ghost'])).toEqual([])
  })
})
