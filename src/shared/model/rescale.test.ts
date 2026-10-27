import { describe, it, expect } from 'vitest'
import { produce } from 'immer'
import { applyRescaleSegment, sideNodeKeys, type RescaleEnd } from './rescale'
import { segmentLengthMm } from './geometry'
import { emptyDocument } from './document'
import type { HarnessDocument, RouteNode, Segment, Vec2 } from './schema'

/** A body route-node (schema 0.4.0: limbs reach BODIES, not cavities). */
const body = (refId: string): RouteNode => ({ type: 'body', refId })
const branch = (branchId: string): RouteNode => ({ type: 'branch', branchId })
const segOf = (id: string, from: RouteNode, to: RouteNode, specifiedLengthMm?: number): Segment =>
  specifiedLengthMm === undefined ? { id, from, to } : { id, from, to, specifiedLengthMm }

/** Every position in the doc, keyed — for "nothing moved" deep-equals. */
function positions(d: HarnessDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of d.placements) out[`n:${p.refId}`] = { pos: p.pos, schematicPos: p.schematicPos }
  for (const b of d.branchPoints) out[`b:${b.id}`] = b.pos
  out.blocks = d.drawing.blocks
  out.labels = d.labels.map((l) => l.pos)
  out.sheetOrigin = d.drawing.sheetOrigin
  return out
}

const posOf = (d: HarnessDocument, refId: string): Vec2 => d.placements.find((p) => p.refId === refId)!.pos
const bpOf = (d: HarnessDocument, id: string): Vec2 => d.branchPoints.find((b) => b.id === id)!.pos

const rescale = (d: HarnessDocument, segId: string, toward: RescaleEnd) => {
  let result: ReturnType<typeof applyRescaleSegment> | undefined
  const next = produce(d, (draft) => {
    result = applyRescaleSegment(draft, segId, toward)
  })
  return { next, result: result! }
}

/** A(0,0) —S— B(1000,0) —T— C(1500,0); S typed `typed`. */
function chain(typed = 1100): HarnessDocument {
  const d = emptyDocument()
  d.drawing.sheetOrigin = { x: -50, y: -50 }
  d.placements = [
    { refId: 'A', pos: { x: 0, y: 0 } },
    { refId: 'B', pos: { x: 1000, y: 0 } },
    { refId: 'C', pos: { x: 1500, y: 0 } }
  ]
  d.segments = [segOf('S', body('A'), body('B'), typed), segOf('T', body('B'), body('C'))]
  return d
}

describe('applyRescaleSegment', () => {
  it('straight chain: B and C move +100 along S, A unchanged, S drawn === typed', () => {
    const { next, result } = rescale(chain(1100), 'S', 'to')
    expect(result).toBe('ok')
    expect(posOf(next, 'A')).toEqual({ x: 0, y: 0 })
    expect(posOf(next, 'B').x).toBeCloseTo(1100, 9)
    expect(posOf(next, 'B').y).toBeCloseTo(0, 9)
    expect(posOf(next, 'C').x).toBeCloseTo(1600, 9)
    expect(Math.abs(segmentLengthMm(next, 'S')! - 1100)).toBeLessThan(1e-6)
    // the drawing sheet is pinned, never moved by a rescale
    expect(next.drawing.sheetOrigin).toEqual({ x: -50, y: -50 })
  })

  it('toward the FROM end moves A instead; B and C stay', () => {
    const { next, result } = rescale(chain(1100), 'S', 'from')
    expect(result).toBe('ok')
    expect(posOf(next, 'A').x).toBeCloseTo(-100, 9)
    expect(posOf(next, 'B')).toEqual({ x: 1000, y: 0 })
    expect(posOf(next, 'C')).toEqual({ x: 1500, y: 0 })
    expect(Math.abs(segmentLengthMm(next, 'S')! - 1100)).toBeLessThan(1e-6)
  })

  it('shrink: typed = drawn − 100 moves −100', () => {
    const { next, result } = rescale(chain(900), 'S', 'to')
    expect(result).toBe('ok')
    expect(posOf(next, 'B').x).toBeCloseTo(900, 9)
    expect(posOf(next, 'C').x).toBeCloseTo(1400, 9)
    expect(posOf(next, 'A')).toEqual({ x: 0, y: 0 })
    expect(Math.abs(segmentLengthMm(next, 'S')! - 900)).toBeLessThan(1e-6)
  })

  it('angled limb at 30°: direction unchanged, length exact to 1e-6', () => {
    const d = emptyDocument()
    const rad = Math.PI / 6
    const a = { x: 37.3, y: -12.9 }
    const b = { x: a.x + 777.7 * Math.cos(rad), y: a.y + 777.7 * Math.sin(rad) }
    d.placements = [
      { refId: 'A', pos: a },
      { refId: 'B', pos: b }
    ]
    d.segments = [segOf('S', body('A'), body('B'), 1234.5)]
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('ok')
    const nb = posOf(next, 'B')
    const before = { x: b.x - a.x, y: b.y - a.y }
    const after = { x: nb.x - a.x, y: nb.y - a.y }
    const cross = (before.x * after.y - before.y * after.x) / (Math.hypot(before.x, before.y) * Math.hypot(after.x, after.y))
    expect(Math.abs(cross)).toBeLessThan(1e-12)
    expect(before.x * after.x + before.y * after.y).toBeGreaterThan(0) // not flipped
    expect(Math.abs(segmentLengthMm(next, 'S')! - 1234.5)).toBeLessThan(1e-6)
  })

  /** A(0,0) —S— bp1(1000,0), bp1 —U→ X(1500,200), bp1 —V→ Y(1500,−200); A —W→ F(−300,0) —Z→ G(−300,400). */
  function yDoc(): HarnessDocument {
    const d = emptyDocument()
    d.placements = [
      { refId: 'A', pos: { x: 0, y: 0 } },
      { refId: 'X', pos: { x: 1500, y: 200 } },
      { refId: 'Y', pos: { x: 1500, y: -200 } },
      { refId: 'F', pos: { x: -300, y: 0 } },
      { refId: 'G', pos: { x: -300, y: 400 } }
    ]
    d.branchPoints = [
      { id: 'bp1', pos: { x: 1000, y: 0 } },
      { id: 'bp2', pos: { x: -150, y: 0 } }
    ]
    d.segments = [
      segOf('S', body('A'), branch('bp1'), 1050),
      segOf('U', branch('bp1'), body('X')),
      segOf('V', body('Y'), branch('bp1')), // reversed orientation: adjacency is undirected
      segOf('W1', body('A'), branch('bp2')),
      segOf('W2', branch('bp2'), body('F')),
      segOf('Z', body('F'), body('G'))
    ]
    return d
  }

  it('Y-branch on the moved side: the whole subtree moves rigidly', () => {
    const { next, result } = rescale(yDoc(), 'S', 'to')
    expect(result).toBe('ok')
    expect(bpOf(next, 'bp1').x).toBeCloseTo(1050, 9)
    expect(posOf(next, 'X')).toEqual({ x: 1550, y: 200 })
    expect(posOf(next, 'Y')).toEqual({ x: 1550, y: -200 })
    expect(Math.abs(segmentLengthMm(next, 'S')! - 1050)).toBeLessThan(1e-6)
  })

  it('Y-branch on the fixed side (a body with other limbs): untouched', () => {
    const d = yDoc()
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('ok')
    for (const id of ['A', 'F', 'G']) expect(posOf(next, id)).toEqual(posOf(d, id))
    expect(bpOf(next, 'bp2')).toEqual(bpOf(d, 'bp2'))
  })

  it('loop refuses: A—S—B plus A—X—B → loop, doc unchanged', () => {
    const d = emptyDocument()
    d.placements = [
      { refId: 'A', pos: { x: 0, y: 0 } },
      { refId: 'B', pos: { x: 1000, y: 0 } }
    ]
    d.branchPoints = [{ id: 'X', pos: { x: 500, y: 300 } }]
    d.segments = [
      segOf('S', body('A'), body('B'), 1100),
      segOf('AX', body('A'), branch('X')),
      segOf('XB', branch('X'), body('B'))
    ]
    expect(sideNodeKeys(d, 'S', 'to')).toBe('loop')
    expect(sideNodeKeys(d, 'S', 'from')).toBe('loop')
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('loop')
    expect(positions(next)).toEqual(positions(d))
  })

  it('sideNodeKeys: the toward side only, never the other end', () => {
    const keys = sideNodeKeys(yDoc(), 'S', 'to')
    expect(keys).not.toBe('loop')
    expect([...(keys as Set<string>)].sort()).toEqual(['b:bp1', 'n:X', 'n:Y'])
  })

  it('moves every placement kind on the side; schematicPos frozen at its pre-move value', () => {
    const d = emptyDocument()
    d.connectors.push({ id: 'J1', designator: 'J1', cavities: [{ id: 'J1-1', position: '1', status: 'populated' }] })
    d.connectors.push({ id: 'J2', designator: 'J2', cavities: [{ id: 'J2-1', position: '1', status: 'populated' }] })
    d.splices.push({ id: 'SP1', designator: 'SP1', kind: 'butt' })
    d.freeTerminals.push({ id: 'T1', designator: 'T1', kind: 'ring' })
    d.cables.push({ id: 'CB1', name: 'CAN-1', coreWireIds: [] })
    d.placements = [
      { refId: 'J1', pos: { x: 0, y: 0 } },
      { refId: 'J2', pos: { x: 100, y: 0 } },
      { refId: 'SP1', pos: { x: 200, y: 0 }, schematicPos: { x: -7, y: -8 } },
      { refId: 'T1', pos: { x: 300, y: 0 } },
      { refId: 'CB1', pos: { x: 200, y: 100 } }
    ]
    d.segments = [
      segOf('S', body('J1'), body('J2'), 150),
      segOf('a', body('J2'), body('SP1')),
      segOf('b', body('SP1'), body('T1')),
      segOf('c', body('SP1'), body('CB1'))
    ]
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('ok')
    const p = (id: string) => next.placements.find((x) => x.refId === id)!
    expect(p('J1')).toEqual({ refId: 'J1', pos: { x: 0, y: 0 } }) // fixed side: schematicPos not written
    expect(p('J2')).toEqual({ refId: 'J2', pos: { x: 150, y: 0 }, schematicPos: { x: 100, y: 0 } })
    expect(p('SP1')).toEqual({ refId: 'SP1', pos: { x: 250, y: 0 }, schematicPos: { x: -7, y: -8 } })
    expect(p('T1')).toEqual({ refId: 'T1', pos: { x: 350, y: 0 }, schematicPos: { x: 300, y: 0 } })
    expect(p('CB1')).toEqual({ refId: 'CB1', pos: { x: 250, y: 100 }, schematicPos: { x: 200, y: 100 } })
  })

  it('pinned blocks follow their body; unpinned blocks are not written; free labels stay', () => {
    const d = chain(1100)
    d.drawing.blocks = {
      pinout: { B: { x: 990, y: 40 }, A: { x: -10, y: 40 } },
      picture: { C: { x: 1480, y: -90 } },
      bom: { x: 5, y: 5 }
    }
    // a free (unanchored) branch-point label sitting by C: it does not ride the rescale
    d.labels = [{ id: 'L1', target: { type: 'branchPoint', branchId: 'none' }, kind: 'flag', text: 'x', pos: { x: 1500, y: 50 } }]
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('ok')
    expect(next.drawing.blocks!.pinout).toEqual({ B: { x: 1090, y: 40 }, A: { x: -10, y: 40 } })
    expect(next.drawing.blocks!.picture).toEqual({ C: { x: 1580, y: -90 } })
    expect(next.drawing.blocks!.bom).toEqual({ x: 5, y: 5 })
    expect('B' in (next.drawing.blocks!.picture ?? {})).toBe(false) // unpinned: not written
    expect(next.labels[0].pos).toEqual({ x: 1500, y: 50 })
  })

  it('a free label targeting a branch point on the moved side moves by d; one on the fixed side stays', () => {
    // A —S— BP1 —T— C, plus a stub A —U— BP0 on the fixed side.
    const d = emptyDocument()
    d.placements = [
      { refId: 'A', pos: { x: 0, y: 0 } },
      { refId: 'C', pos: { x: 1500, y: 0 } }
    ]
    d.branchPoints = [
      { id: 'BP1', pos: { x: 1000, y: 0 } },
      { id: 'BP0', pos: { x: -200, y: 0 } }
    ]
    d.segments = [
      segOf('S', body('A'), branch('BP1'), 1100),
      segOf('T', branch('BP1'), body('C')),
      segOf('U', body('A'), branch('BP0'))
    ]
    d.labels = [
      { id: 'Lm', target: { type: 'branchPoint', branchId: 'BP1' }, kind: 'flag', text: 'm', pos: { x: 1000, y: 60 }, leader: true },
      { id: 'Lf', target: { type: 'branchPoint', branchId: 'BP0' }, kind: 'flag', text: 'f', pos: { x: -200, y: 60 }, leader: true }
    ]
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('ok')
    expect(bpOf(next, 'BP1').x).toBeCloseTo(1100, 9)
    expect(next.labels[0].pos.x).toBeCloseTo(1100, 9)
    expect(next.labels[0].pos.y).toBeCloseTo(60, 9)
    expect(next.labels[1].pos).toEqual({ x: -200, y: 60 })
  })

  it('an ANCHORED label targeting a moved branch point is not written (it follows its segment)', () => {
    const d = chain(1100)
    d.branchPoints = [{ id: 'BP', pos: { x: 1200, y: 0 } }]
    d.segments = [segOf('S', body('A'), body('B'), 1100), segOf('T', body('B'), branch('BP')), segOf('V', branch('BP'), body('C'))]
    d.labels = [
      { id: 'La', target: { type: 'branchPoint', branchId: 'BP' }, kind: 'flag', text: 'a', pos: { x: 7, y: 7 }, anchor: { segmentId: 'T', fraction: 0.5 } }
    ]
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('ok')
    expect(bpOf(next, 'BP').x).toBeCloseTo(1300, 9)
    expect(next.labels[0].pos).toEqual({ x: 7, y: 7 })
  })

  it('a free label on a segment with BOTH ends on the moved side rides along; one on S or the fixed side stays', () => {
    // U: A0 —U— A —S— B —T— C. Pressing S's 'to' arrow moves B and C: T lies
    // wholly on the moved side, S straddles, U is on the fixed side.
    const d = chain(1100)
    d.placements.push({ refId: 'A0', pos: { x: -300, y: 0 } })
    d.segments.push(segOf('U', body('A0'), body('A')))
    d.labels = [
      { id: 'Lt', target: { type: 'branch', segmentId: 'T' }, kind: 'callout', text: 't', pos: { x: 1250, y: 40 }, leader: true },
      { id: 'Ls', target: { type: 'branch', segmentId: 'S' }, kind: 'callout', text: 's', pos: { x: 500, y: 40 }, leader: true },
      { id: 'Lu', target: { type: 'branch', segmentId: 'U' }, kind: 'callout', text: 'u', pos: { x: -150, y: 40 }, leader: true },
      { id: 'La', target: { type: 'branch', segmentId: 'T' }, kind: 'callout', text: 'a', pos: { x: 9, y: 9 }, anchor: { segmentId: 'T', fraction: 0.5 } }
    ]
    const { next, result } = rescale(d, 'S', 'to')
    expect(result).toBe('ok')
    const lp = (id: string) => next.labels.find((l) => l.id === id)!.pos
    expect(lp('Lt').x).toBeCloseTo(1350, 9)
    expect(lp('Lt').y).toBeCloseTo(40, 9)
    expect(lp('Ls')).toEqual({ x: 500, y: 40 })
    expect(lp('Lu')).toEqual({ x: -150, y: 40 })
    expect(lp('La')).toEqual({ x: 9, y: 9 }) // anchored: follows by reference, never written
  })

  it('no drawing.blocks at all: none created', () => {
    const { next } = rescale(chain(1100), 'S', 'to')
    expect(next.drawing.blocks).toBeUndefined()
  })

  it.each([
    ['not-broken (untyped)', () => chain(1100), (d: HarnessDocument) => delete d.segments[0].specifiedLengthMm, 'S'],
    ['not-broken (within tolerance)', () => chain(1000.4), () => {}, 'S'],
    ['unresolved (an end not placed)', () => chain(1100), (d: HarnessDocument) => d.placements.splice(1, 1), 'S'],
    ['no-segment', () => chain(1100), () => {}, 'nope']
  ] as const)('%s → code, no change', (name, make, tweak, segId) => {
    const d = produce(make(), (x) => void tweak(x as HarnessDocument))
    const { next, result } = rescale(d, segId, 'to')
    expect(result).toBe(name.split(' ')[0])
    expect(next).toBe(d) // Immer returns the same object when the recipe wrote nothing
  })
})
