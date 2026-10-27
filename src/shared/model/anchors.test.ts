import { describe, expect, it } from 'vitest'
import { emptyDocument } from './document'
import { segmentLengthMm } from './geometry'
import { computeFormboard } from './formboard'
import { natCompare, sortedCavities } from './anchors'
import type { Connector } from './schema'

function asymmetricDoc() {
  const doc = emptyDocument()
  doc.connectors.push({
    id: 'c1',
    designator: 'X1',
    cavities: [{ id: 'cav1', position: '1', status: 'populated' }]
  })
  doc.placements.push({ refId: 'c1', pos: { x: 0, y: 0 } })
  doc.branchPoints.push({ id: 'b1', pos: { x: 100, y: 12.5 } })
  doc.segments.push({
    id: 's1',
    from: { type: 'body', refId: 'c1' },
    to: { type: 'branch', branchId: 'b1' }
  })
  return doc
}

describe('B1 — drawn geometry equals measured length', () => {
  it('segmentLengthMm measures dot to node, matching the drawn line', () => {
    const doc = asymmetricDoc()
    // The body dot is the placement: (0, 0) → branch (100, 12.5).
    expect(segmentLengthMm(doc, 's1')).toBeCloseTo(Math.hypot(100, 12.5))
  })
  it('FbSegment.lengthMm equals the drawn a→b distance for every segment', () => {
    const doc = asymmetricDoc()
    for (const s of computeFormboard(doc).segments) {
      expect(s.lengthMm).toBeCloseTo(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y))
    }
  })
})

describe('cavity display order (session-10 nit)', () => {
  const conn = (positions: string[]): Connector => ({
    id: 'c',
    designator: 'X1',
    cavities: positions.map((position, i) => ({ id: `cav${i}`, position, status: 'populated' }))
  })

  it('natCompare is numeric-aware', () => {
    expect(['10', '2', '1'].sort(natCompare)).toEqual(['1', '2', '10'])
  })

  it('sortedCavities orders "1","2","10" numerically, not lexically', () => {
    const c = conn(['10', '1', '2'])
    expect(sortedCavities(c).map((x) => x.position)).toEqual(['1', '2', '10'])
  })

  it('sortedCavities orders alphanumeric positions A1 < A2 < A10 < B1', () => {
    const c = conn(['B1', 'A10', 'A2', 'A1'])
    expect(sortedCavities(c).map((x) => x.position)).toEqual(['A1', 'A2', 'A10', 'B1'])
  })

  it('sortedCavities is stable for equal-comparing positions and does not mutate', () => {
    const c = conn(['1', '1'])
    const before = c.cavities.map((x) => x.id)
    expect(sortedCavities(c).map((x) => x.id)).toEqual(['cav0', 'cav1'])
    expect(c.cavities.map((x) => x.id)).toEqual(before) // stored order untouched
  })
})
