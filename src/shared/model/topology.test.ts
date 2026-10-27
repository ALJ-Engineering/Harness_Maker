import { describe, it, expect } from 'vitest'
import { produce } from 'immer'
import { branchDegree, incidentSegments, isSelfLoopSegment, spliceDegree } from './topology'
import { applyRemoveBranchPoint } from './routing'
import { emptyDocument } from './document'
import type { HarnessDocument, RouteNode } from './schema'

const body = (refId: string): RouteNode => ({ type: 'body', refId })
const br = (branchId: string): RouteNode => ({ type: 'branch', branchId })

const wire = (id: string, a: HarnessDocument['wires'][number]['ends']) => ({
  id,
  ends: a,
  gauge: { value: 1, unit: 'mm2' as const },
  color: { base: 'RD' }
})

describe('isSelfLoopSegment', () => {
  it('is true when both ends resolve to the same route node', () => {
    expect(isSelfLoopSegment({ id: 's', from: br('bp1'), to: br('bp1') })).toBe(true)
  })
  it('is false for an ordinary segment', () => {
    expect(isSelfLoopSegment({ id: 's', from: br('bp1'), to: body('bodyA') })).toBe(false)
  })
})

describe('branchDegree / incidentSegments', () => {
  it('counts each ordinary incident segment once', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    d.segments = [
      { id: 's1', from: body('bodyA'), to: br('bp1') },
      { id: 's2', from: br('bp1'), to: body('bodyB') },
      { id: 's3', from: br('bp1'), to: body('bodyC') }
    ]
    expect(branchDegree(d, 'bp1')).toBe(3)
    expect(incidentSegments(d, 'bp1').map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('counts a SELF-LOOP segment ONCE, not twice (session-10 nit)', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    d.segments = [{ id: 'loop', from: br('bp1'), to: br('bp1') }]
    expect(branchDegree(d, 'bp1')).toBe(1)
    expect(incidentSegments(d, 'bp1').map((s) => s.id)).toEqual(['loop'])
  })

  it('a self-loop plus one real limb is degree 2, not 3', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    d.segments = [
      { id: 'loop', from: br('bp1'), to: br('bp1') },
      { id: 's1', from: br('bp1'), to: body('bodyA') }
    ]
    expect(branchDegree(d, 'bp1')).toBe(2)
  })

  it('is 0 for a branch point nothing references', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    expect(branchDegree(d, 'bp1')).toBe(0)
  })
})

describe('spliceDegree', () => {
  it('counts each wire ending on the splice once', () => {
    const d = emptyDocument()
    d.splices = [{ id: 'sp1', designator: 'SP1', kind: 'butt' }]
    d.wires = [
      wire('w1', [{ type: 'cavity', cavityId: 'a' }, { type: 'splice', spliceId: 'sp1' }]),
      wire('w2', [{ type: 'splice', spliceId: 'sp1' }, { type: 'cavity', cavityId: 'b' }])
    ]
    expect(spliceDegree(d, 'sp1')).toBe(2)
  })

  it('counts a wire with BOTH ends on the same splice ONCE (session-10 nit)', () => {
    const d = emptyDocument()
    d.splices = [{ id: 'sp1', designator: 'SP1', kind: 'butt' }]
    d.wires = [wire('w1', [{ type: 'splice', spliceId: 'sp1' }, { type: 'splice', spliceId: 'sp1' }])]
    expect(spliceDegree(d, 'sp1')).toBe(1)
  })
})

describe('applyRemoveBranchPoint agrees with branchDegree on self-loops', () => {
  it('refuses a branch point whose two "incident ends" are one self-loop', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    d.segments = [{ id: 'loop', from: br('bp1'), to: br('bp1') }]
    let ok = true
    const out = produce(d, (draft) => {
      ok = applyRemoveBranchPoint(draft, 'bp1', { mergedSegId: 'm' })
    })
    expect(ok).toBe(false)
    expect(out).toEqual(d)
  })

  it('refuses a degree-2 branch point when one of its limbs is a self-loop', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 0, y: 0 } }]
    d.segments = [
      { id: 'loop', from: br('bp1'), to: br('bp1') },
      { id: 's1', from: br('bp1'), to: body('bodyA') }
    ]
    let ok = true
    const out = produce(d, (draft) => {
      ok = applyRemoveBranchPoint(draft, 'bp1', { mergedSegId: 'm' })
    })
    expect(ok).toBe(false)
    // No segment may be left pointing at a removed branch point.
    expect(out.branchPoints.map((b) => b.id)).toEqual(['bp1'])
    expect(out.segments.map((s) => s.id)).toEqual(['loop', 's1'])
  })
})
