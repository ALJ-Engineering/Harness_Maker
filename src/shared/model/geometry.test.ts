import { describe, it, expect } from 'vitest'
import {
  isValidLengthMm,
  segmentLengthMm,
  wireLength,
  routeConnected,
  resolveNodePos,
  spanLengthMm,
  bundleLengthMm,
  effectiveSegmentLengthMm,
  segmentLengthBroken
} from './geometry'
import { emptyDocument, demoDocument } from './document'
import type { HarnessDocument } from './schema'

/** Two connectors 300mm apart on X, wire X1.1->X2.A routed via one direct segment. */
function routedDoc(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    { id: 'c1', designator: 'X1', cavities: [{ id: 'cav1', position: '1', status: 'populated' }] },
    { id: 'c2', designator: 'X2', cavities: [{ id: 'cav4', position: 'A', status: 'populated' }] }
  ]
  d.placements = [
    { refId: 'c1', pos: { x: 0, y: 0 } },
    { refId: 'c2', pos: { x: 300, y: 400 } } // 3-4-5 -> 500mm
  ]
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'cav1' },
        { type: 'cavity', cavityId: 'cav4' }
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

describe('segmentLengthMm', () => {
  it('is the mm distance between resolved node positions', () => {
    expect(segmentLengthMm(routedDoc(), 'seg1')).toBeCloseTo(500)
  })
  it('is null when a node has no placement', () => {
    const d = routedDoc()
    d.placements = d.placements.filter((p) => p.refId !== 'c2')
    expect(segmentLengthMm(d, 'seg1')).toBeNull()
  })
})

describe('wireLength states', () => {
  it('derived: sums routed segment lengths', () => {
    expect(wireLength(routedDoc(), 'w1')).toEqual({ mm: 500, source: 'derived' })
  })
  it('specified: override wins over geometry', () => {
    const d = routedDoc()
    d.wires[0].specifiedLengthMm = 650
    expect(wireLength(d, 'w1')).toEqual({ mm: 650, source: 'specified' })
  })
  it('unknown: no route -> null, never 0', () => {
    const d = routedDoc()
    d.wireRoutes = []
    expect(wireLength(d, 'w1')).toEqual({ mm: null, source: 'unknown' })
  })
  it('unknown: route references an unplaced node', () => {
    const d = routedDoc()
    d.placements = d.placements.filter((p) => p.refId !== 'c2')
    expect(wireLength(d, 'w1')).toEqual({ mm: null, source: 'unknown' })
  })

  it('addLengthMm allowance is added to the derived centreline', () => {
    const d = routedDoc()
    d.wires[0].addLengthMm = 50
    expect(wireLength(d, 'w1')).toEqual({ mm: 550, source: 'derived' })
  })
  it('a negative addLengthMm is clamped to 0 (never shorter than the centreline)', () => {
    const d = routedDoc()
    d.wires[0].addLengthMm = -100
    expect(wireLength(d, 'w1')).toEqual({ mm: 500, source: 'derived' })
  })
  it('specifiedLengthMm overrides — allowance is NOT added on top', () => {
    const d = routedDoc()
    d.wires[0].specifiedLengthMm = 650
    d.wires[0].addLengthMm = 50
    expect(wireLength(d, 'w1')).toEqual({ mm: 650, source: 'specified' })
  })
})

describe('demo doc is routed', () => {
  it('every demo wire has a derived length', () => {
    const d = demoDocument()
    for (const w of d.wires) {
      const len = wireLength(d, w.id)
      expect(len.source).toBe('derived')
      expect(len.mm).toBeGreaterThan(0)
    }
  })
})

describe('routeConnected', () => {
  it('true for a single direct segment spanning the wire ends', () => {
    expect(routeConnected(routedDoc(), 'w1')).toBe(true)
  })
  it('keys the route start and goal by BODY, whichever cavity the wire uses', () => {
    const d = emptyDocument()
    d.connectors.push(
      {
        id: 'cA',
        designator: 'A',
        cavities: [
          { id: 'a1', position: '1', status: 'populated' },
          { id: 'a2', position: '2', status: 'populated' }
        ]
      },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b1', position: '1', status: 'populated' }] }
    )
    d.segments.push({ id: 's', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } })
    d.wires.push(
      {
        id: 'w1',
        ends: [
          { type: 'cavity', cavityId: 'a1' },
          { type: 'cavity', cavityId: 'b1' }
        ],
        gauge: { value: 1, unit: 'mm2' },
        color: { base: 'RD' }
      },
      {
        id: 'w2',
        ends: [
          { type: 'cavity', cavityId: 'b1' },
          { type: 'cavity', cavityId: 'a2' }
        ],
        gauge: { value: 1, unit: 'mm2' },
        color: { base: 'BK' }
      }
    )
    d.wireRoutes.push({ wireId: 'w1', path: ['s'] }, { wireId: 'w2', path: ['s'] })
    expect(routeConnected(d, 'w1')).toBe(true)
    expect(routeConnected(d, 'w2')).toBe(true) // reversed direction, same segment
  })
  it('false when the path does not reach the second endpoint', () => {
    const d = routedDoc()
    // segment from body c1 back to c1 (degenerate) cannot span to c2
    d.segments[0].to = { type: 'body', refId: 'c1' }
    expect(routeConnected(d, 'w1')).toBe(false)
  })
})

describe('spanLengthMm', () => {
  it('full span over one 100mm segment is 100', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b', position: '1', status: 'populated' }] }
    ]
    d.placements = [{ refId: 'cA', pos: { x: 0, y: 0 } }, { refId: 'cB', pos: { x: 100, y: 0 } }]
    d.segments = [{ id: 'seg', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    expect(spanLengthMm(d, { segmentIds: ['seg'] })).toBeCloseTo(100)
    expect(spanLengthMm(d, { segmentIds: ['seg'], startFraction: 0.25, endFraction: 0.75 })).toBeCloseTo(50)
  })

  it('fractional start removes the head of the first segment', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b', position: '1', status: 'populated' }] }
    ]
    d.placements = [{ refId: 'cA', pos: { x: 0, y: 0 } }, { refId: 'cB', pos: { x: 100, y: 0 } }]
    d.segments = [{ id: 'seg', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    // startFraction=0.1 cuts 10mm from head; no endFraction means full tail
    expect(spanLengthMm(d, { segmentIds: ['seg'], startFraction: 0.1 })).toBeCloseTo(90)
  })

  it('span over two segments sums both, minus fractions only on first/last', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b', position: '1', status: 'populated' }] },
      { id: 'cC', designator: 'C', cavities: [{ id: 'c', position: '1', status: 'populated' }] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 100, y: 0 } },
      { refId: 'cC', pos: { x: 200, y: 0 } }
    ]
    d.branchPoints = [{ id: 'bp', pos: { x: 100, y: 0 } }]
    d.segments = [
      { id: 'seg1', from: { type: 'body', refId: 'cA' }, to: { type: 'branch', branchId: 'bp' } },
      { id: 'seg2', from: { type: 'branch', branchId: 'bp' }, to: { type: 'body', refId: 'cC' } }
    ]
    // Dot-true lengths (schema 0.4.0): a body IS its placement, so
    //   dot cA = (0, 0), dot cC = (200, 0), branch bp = (100, 0).
    //   seg1 = 100, seg2 = 100 → full span 200
    expect(spanLengthMm(d, { segmentIds: ['seg1', 'seg2'] })).toBeCloseTo(200, 4)
    // startFraction=0.2 cuts 20 off seg1's head, endFraction=0.8 cuts 20 off
    // seg2's tail → 200 - 20 - 20 = 160 (= 0.8 * 200)
    expect(spanLengthMm(d, { segmentIds: ['seg1', 'seg2'], startFraction: 0.2, endFraction: 0.8 })).toBeCloseTo(160, 4)
  })

  it('I1: inverted fractions (startFraction > endFraction) return null, not negative', () => {
    // Single 100mm segment; startFraction=0.8, endFraction=0.2
    // Without guard: total = 100 - 0.8*100 - (1-0.2)*100 = 100 - 80 - 80 = -60 (bug)
    // With guard: return null (treat as unknown length, never a negative manufacturing figure)
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b', position: '1', status: 'populated' }] }
    ]
    d.placements = [{ refId: 'cA', pos: { x: 0, y: 0 } }, { refId: 'cB', pos: { x: 100, y: 0 } }]
    d.segments = [{ id: 'seg', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    expect(spanLengthMm(d, { segmentIds: ['seg'], startFraction: 0.8, endFraction: 0.2 })).toBeNull()
  })

  it('returns null when a segment length is unresolved (node not placed)', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b', position: '1', status: 'populated' }] }
    ]
    // Only place cA; cB is unplaced
    d.placements = [{ refId: 'cA', pos: { x: 0, y: 0 } }]
    d.segments = [{ id: 'seg', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    expect(spanLengthMm(d, { segmentIds: ['seg'] })).toBeNull()
  })

  it('default startFraction=0 and endFraction=1 give the full length', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b', position: '1', status: 'populated' }] }
    ]
    d.placements = [{ refId: 'cA', pos: { x: 0, y: 0 } }, { refId: 'cB', pos: { x: 60, y: 80 } }]
    d.segments = [{ id: 'seg', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    // 3-4-5 scaled: sqrt(60^2+80^2) = 100
    expect(spanLengthMm(d, { segmentIds: ['seg'], startFraction: 0, endFraction: 1 })).toBeCloseTo(100)
  })
})

describe('bundleLengthMm', () => {
  /** Three single-cavity connectors in a line: seg1 = 100 mm, seg2 = 50 mm. */
  function bundledDoc(): HarnessDocument {
    const body = (refId: string) => ({ type: 'body', refId }) as const
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b', position: '1', status: 'populated' }] },
      { id: 'cC', designator: 'C', cavities: [{ id: 'c', position: '1', status: 'populated' }] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 60, y: 80 } }, // 3-4-5 → 100 mm from cA
      { refId: 'cC', pos: { x: 60, y: 130 } } // 50 mm below cB
    ]
    d.segments = [
      { id: 'seg1', from: body('cA'), to: body('cB') },
      { id: 'seg2', from: body('cB'), to: body('cC') }
    ]
    return d
  }

  it('sums the lengths of every member segment', () => {
    const d = bundledDoc()
    expect(
      bundleLengthMm(d, { id: 'bn1', segmentIds: ['seg1', 'seg2'], memberWireIds: [] })
    ).toBeCloseTo(150)
  })

  it('is order-independent (segmentIds is document order, not route order)', () => {
    const d = bundledDoc()
    expect(
      bundleLengthMm(d, { id: 'bn1', segmentIds: ['seg2', 'seg1'], memberWireIds: [] })
    ).toBeCloseTo(150)
  })

  it('is 0 for a bundle with no segments', () => {
    expect(bundleLengthMm(emptyDocument(), { id: 'bn1', segmentIds: [], memberWireIds: [] })).toBe(0)
  })

  it('is null when any member segment is unresolved or missing', () => {
    const d = bundledDoc()
    expect(
      bundleLengthMm(d, { id: 'bn1', segmentIds: ['seg1', 'nope'], memberWireIds: [] })
    ).toBeNull()
    d.placements = d.placements.filter((p) => p.refId !== 'cC') // cC unplaced
    expect(
      bundleLengthMm(d, { id: 'bn1', segmentIds: ['seg1', 'seg2'], memberWireIds: [] })
    ).toBeNull()
  })
})

describe('isValidLengthMm (session-10 nit)', () => {
  it('accepts finite, non-negative millimetres — 0 included', () => {
    expect(isValidLengthMm(0)).toBe(true)
    expect(isValidLengthMm(0.5)).toBe(true)
    expect(isValidLengthMm(12345)).toBe(true)
  })
  it('rejects negative, NaN and non-finite', () => {
    expect(isValidLengthMm(-1)).toBe(false)
    expect(isValidLengthMm(-0.0001)).toBe(false)
    expect(isValidLengthMm(NaN)).toBe(false)
    expect(isValidLengthMm(Infinity)).toBe(false)
    expect(isValidLengthMm(-Infinity)).toBe(false)
  })
})

describe('typed segment length', () => {
  /** routedDoc's seg1 is 500 mm drawn; give it a typed length. */
  const typed = (mm: number, drawnX = 300): HarnessDocument => {
    const d = routedDoc()
    d.placements[1].pos = { x: drawnX, y: 400 }
    d.segments[0].specifiedLengthMm = mm
    return d
  }

  it('effective length is the typed value when set, the drawn one otherwise', () => {
    const d = routedDoc()
    d.placements[1].pos = { x: 1187, y: 0 }
    expect(effectiveSegmentLengthMm(d, 'seg1')).toBeCloseTo(1187)
    d.segments[0].specifiedLengthMm = 1200
    expect(effectiveSegmentLengthMm(d, 'seg1')).toBe(1200)
    expect(segmentLengthMm(d, 'seg1')).toBeCloseTo(1187)
  })

  it('broken: only when typed and off the drawn length by >= 0.5 mm', () => {
    const at = (typedMm: number | undefined, drawn: number): HarnessDocument => {
      const d = routedDoc()
      d.placements[1].pos = { x: drawn, y: 0 }
      if (typedMm !== undefined) d.segments[0].specifiedLengthMm = typedMm
      return d
    }
    expect(segmentLengthBroken(at(1200, 1187), 'seg1')).toBe(true)
    expect(segmentLengthBroken(at(1200, 1199.6), 'seg1')).toBe(false)
    expect(segmentLengthBroken(at(1200, 1199.5), 'seg1')).toBe(true)
    expect(segmentLengthBroken(at(undefined, 1187), 'seg1')).toBe(false)
    const unplaced = at(1200, 1187)
    unplaced.placements = unplaced.placements.filter((p) => p.refId !== 'c2')
    expect(segmentLengthBroken(unplaced, 'seg1')).toBe(false)
  })

  it('wireLength sums the typed length (derived); a wire override still wins', () => {
    const d = typed(777)
    expect(wireLength(d, 'w1')).toEqual({ mm: 777, source: 'derived' })
    d.wires[0].specifiedLengthMm = 42
    expect(wireLength(d, 'w1')).toEqual({ mm: 42, source: 'specified' })
  })

  it('span and bundle lengths use the typed value, fractions apply to it', () => {
    const d = typed(1000)
    expect(spanLengthMm(d, { segmentIds: ['seg1'] })).toBe(1000)
    expect(spanLengthMm(d, { segmentIds: ['seg1'], startFraction: 0.25, endFraction: 0.75 })).toBeCloseTo(500)
    expect(bundleLengthMm(d, { id: 'b', wireIds: ['w1'], segmentIds: ['seg1'] } as never)).toBe(1000)
  })
})
