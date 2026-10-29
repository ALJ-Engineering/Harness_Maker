import { describe, it, expect } from 'vitest'
import { demoDocument } from '@shared/model/document'
import type { HarnessDocument } from '@shared/model/schema'
import type { FlowNode } from '../flow/toFlow'
import { dragOutcome, BRANCH_MERGE_MM } from './dragGesture'

/** The demo document plus two nearby branch points and two labels (one anchored on seg-1). */
function fixture(): HarnessDocument {
  const doc = demoDocument()
  doc.branchPoints.push(
    { id: 'bp-1', pos: { x: 200, y: 200 } },
    { id: 'bp-2', pos: { x: 500, y: 500 } }
  )
  doc.labels.push(
    { id: 'lab-free', target: { type: 'branchPoint', branchId: 'bp-1' }, kind: 'callout', text: 'f', pos: { x: 1, y: 1 } },
    {
      id: 'lab-anch',
      target: { type: 'wire', wireId: 'wire-1' },
      kind: 'wireMarker',
      text: 'a',
      pos: { x: 0, y: 0 },
      anchor: { segmentId: 'seg-1', fraction: 0.5 }
    }
  )
  return doc
}

/** A plain-object FlowNode (the node env has no DOM; only id/type/position are read). */
const node = (id: string, type: string, x: number, y: number): FlowNode =>
  ({ id, type, position: { x, y }, data: {} }) as unknown as FlowNode

describe('dragOutcome', () => {
  it('mixed selection maps each node kind', () => {
    const doc = fixture()
    const out = dragOutcome(doc, 'formboard', [
      node('conn-x1', 'connector', 10, 20),
      node('bp-1', 'branch', 30, 40),
      node('lab-free', 'label', 50, 60),
      node('lab-anch', 'label', 200, 62), // near seg-1 (y = 60), off its midpoint
      node('tbl:conn-x1', 'pinoutTable', 1, 2),
      node('pic:conn-x1', 'pictureBlock', 3, 4),
      node('__bom', 'bomBlock', 5, 6)
    ])
    expect(out.kind).toBe('gesture')
    if (out.kind !== 'gesture') return
    const g = out.gesture
    expect(g.nodeMoves.map((m) => m.refId).sort()).toEqual(['bp-1', 'conn-x1'])
    expect(g.nodeMoves.find((m) => m.refId === 'conn-x1')!.pos).toEqual({ x: 10, y: 20 })
    expect(g.labelMoves).toEqual([{ id: 'lab-free', pos: { x: 50, y: 60 } }])
    expect(g.anchorMoves).toHaveLength(1)
    expect(g.anchorMoves[0].id).toBe('lab-anch')
    expect(g.anchorMoves[0].fraction).toBeGreaterThanOrEqual(0)
    expect(g.anchorMoves[0].fraction).toBeLessThanOrEqual(1)
    expect(g.anchorMoves[0].fraction).not.toBe(0.5)
    expect(g.blockMoves).toEqual([
      { kind: 'pinout', id: 'conn-x1', pos: { x: 1, y: 2 } },
      { kind: 'picture', id: 'conn-x1', pos: { x: 3, y: 4 } },
      { kind: 'bom', pos: { x: 5, y: 6 } }
    ])
  })

  it('anchored label alone: projected onto the current segment geometry', () => {
    // seg-1 runs X1 (52,60) -> X2 (372,60); the bead dropped at x = 292 is 3/4 along.
    const out = dragOutcome(fixture(), 'formboard', [node('lab-anch', 'label', 292, 60)])
    expect(out.kind).toBe('gesture')
    if (out.kind !== 'gesture') return
    expect(out.gesture.anchorMoves).toHaveLength(1)
    expect(out.gesture.anchorMoves[0].fraction).toBeCloseTo(0.75, 9)
  })

  it('group drag moving both ends of the anchor segment keeps the label fraction', () => {
    // X1, X2 and the label (bead at seg-1 midpoint x = 212) all move +100 mm in x:
    // the bead must be projected onto the POST-move segment, so it stays at 0.5.
    const doc = fixture()
    const out = dragOutcome(doc, 'formboard', [
      node('conn-x1', 'connector', 152, 60),
      node('conn-x2', 'connector', 472, 60),
      node('lab-anch', 'label', 312, 60)
    ])
    expect(out.kind).toBe('gesture')
    if (out.kind !== 'gesture') return
    expect(out.gesture.anchorMoves).toHaveLength(1)
    expect(Math.abs(out.gesture.anchorMoves[0].fraction - 0.5)).toBeLessThan(1e-9)
    // pure: the input document is not mutated by the projection
    expect(doc.placements.find((p) => p.refId === 'conn-x1')!.pos).toEqual({ x: 52, y: 60 })
  })

  it('group drag moving one end of the anchor segment projects on the moved segment', () => {
    // X2 swings below X1 to (52, 380): seg-1 turns vertical and the bead lands at
    // its new midpoint (52, 220). On the pre-move (horizontal) segment that point
    // would project to fraction 0.
    const out = dragOutcome(fixture(), 'formboard', [
      node('conn-x2', 'connector', 52, 380),
      node('lab-anch', 'label', 52, 220)
    ])
    expect(out.kind === 'gesture' && Math.abs(out.gesture.anchorMoves[0].fraction - 0.5)).toBeLessThan(1e-9)
  })

  it('furniture and sheet never become node moves', () => {
    const out = dragOutcome(fixture(), 'formboard', [node('__sheet', 'formboardSheet', 9, 9)])
    expect(out).toEqual({
      kind: 'gesture',
      gesture: { nodeMoves: [], target: 'physical', labelMoves: [], anchorMoves: [], blockMoves: [] }
    })
  })

  it('merge only for a lone branch point', () => {
    const doc = fixture()
    const near = node('bp-1', 'branch', 500 + BRANCH_MERGE_MM - 1, 500)
    expect(dragOutcome(doc, 'formboard', [near])).toEqual({ kind: 'merge', srcId: 'bp-1', dstId: 'bp-2' })
    const withConn = dragOutcome(doc, 'formboard', [near, node('conn-x1', 'connector', 0, 0)])
    expect(withConn.kind).toBe('gesture')
    // far away: no merge either
    expect(dragOutcome(doc, 'formboard', [node('bp-1', 'branch', 300, 300)]).kind).toBe('gesture')
  })

  it('schematic target', () => {
    const out = dragOutcome(fixture(), 'schematic', [node('conn-x1', 'connector', 1, 1)])
    expect(out.kind === 'gesture' && out.gesture.target).toBe('schematic')
  })

  it('no merge in schematic, even for a lone branch point dropped near another', () => {
    const near = node('bp-1', 'branch', 500 + BRANCH_MERGE_MM - 1, 500)
    expect(dragOutcome(fixture(), 'schematic', [near]).kind).toBe('gesture')
  })
})

describe('dragging an anchored label along its track', () => {
  /**
   * wire-1 runs X1 (52,60) → bp-m (212,200) → X2 (372,60) over seg-a + seg-b.
   * Both labels start on seg-a: one targets the wire, one the limb seg-a itself.
   */
  function bent(): HarnessDocument {
    const doc = demoDocument()
    doc.branchPoints.push({ id: 'bp-m', pos: { x: 212, y: 200 } })
    doc.segments = doc.segments.filter((s) => s.id !== 'seg-1')
    doc.segments.push(
      { id: 'seg-a', from: { type: 'body', refId: 'conn-x1' }, to: { type: 'branch', branchId: 'bp-m' } },
      { id: 'seg-b', from: { type: 'branch', branchId: 'bp-m' }, to: { type: 'body', refId: 'conn-x2' } }
    )
    doc.wireRoutes.find((r) => r.wireId === 'wire-1')!.path = ['seg-a', 'seg-b']
    const label = (id: string, target: HarnessDocument['labels'][number]['target']): void => {
      doc.labels.push({ id, target, kind: 'wireMarker', text: id, pos: { x: 0, y: 0 }, anchor: { segmentId: 'seg-a', fraction: 0.5 } })
    }
    label('lab-wire', { type: 'wire', wireId: 'wire-1' })
    label('lab-limb', { type: 'branch', segmentId: 'seg-a' })
    return doc
  }
  const anchorOf = (doc: HarnessDocument, id: string, x: number, y: number) => {
    const out = dragOutcome(doc, 'formboard', [node(id, 'label', x, y)])
    return out.kind === 'gesture' ? out.gesture.anchorMoves[0] : undefined
  }

  it('a wire label moves onto another segment of its route, the nearest to the drop', () => {
    // (292,130) is the midpoint of seg-b: the label leaves seg-a, where a
    // bundle trunk would have held it, for the wire's own limb.
    const m = anchorOf(bent(), 'lab-wire', 292, 130)!
    expect(m.segmentId).toBe('seg-b')
    expect(m.fraction).toBeCloseTo(0.5, 9)
  })

  it('a drop nearest its own segment keeps it there', () => {
    const m = anchorOf(bent(), 'lab-wire', 132, 130)!
    expect(m.segmentId).toBe('seg-a')
    expect(m.fraction).toBeCloseTo(0.5, 9)
  })

  it('a limb label stays on its limb, clamped to the end nearest the drop', () => {
    const m = anchorOf(bent(), 'lab-limb', 292, 130)!
    expect(m.segmentId).toBe('seg-a')
    expect(m.fraction).toBe(1)
  })
})
