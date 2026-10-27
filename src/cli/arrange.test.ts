import { describe, it, expect } from 'vitest'
import { emptyDocument } from '@shared/model/document'
import type { HarnessDocument, Vec2 } from '@shared/model/schema'
import { arrangeSchematic, schematicBodySize, COLUMN_X, GAP } from './arrange'

function withConnector(d: HarnessDocument, id: string, n: number, schematicPos?: Vec2): void {
  d.connectors.push({
    id,
    designator: id,
    cavities: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, position: String(i + 1), status: 'populated' as const }))
  })
  d.placements.push({ refId: id, pos: { x: 3, y: 4 }, ...(schematicPos ? { schematicPos } : {}) })
}

type Box = { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('arrangeSchematic', () => {
  it('stacks three new connectors in the x = 0 column below the existing body, no overlaps', () => {
    const d = emptyDocument()
    withConnector(d, 'OLD', 6, { x: 10, y: 40 })
    withConnector(d, 'A', 4)
    withConnector(d, 'B', 12)
    withConnector(d, 'C', 1)
    const before = structuredClone(d.placements[0])
    const moves = arrangeSchematic(d, ['A', 'B', 'C'])
    expect(moves.map((m) => m.refId)).toEqual(['A', 'B', 'C'])
    expect(moves.every((m) => m.pos.x === COLUMN_X.connector)).toBe(true)
    const old = { x: 10, y: 40, ...schematicBodySize(d, 'OLD') }
    const boxes = [old, ...moves.map((m) => ({ ...m.pos, ...schematicBodySize(d, m.refId) }))]
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false)
    expect(moves[0].pos.y).toBe(old.y + old.h + GAP)
    expect(moves[1].pos.y).toBe(moves[0].pos.y + boxes[1].h + GAP)
    expect(d.placements[0]).toEqual(before)
    expect(moves.some((m) => m.refId === 'OLD')).toBe(false)
  })

  it('puts splices at x = 250 and terminals at x = 500, each column stacked on its own', () => {
    const d = emptyDocument()
    withConnector(d, 'OLD', 30, { x: 0, y: 0 })
    d.splices.push({ id: 'S', designator: 'SP1', kind: 'butt' }, { id: 'S2', designator: 'SP2', kind: 'butt' })
    d.freeTerminals.push({ id: 'T', designator: 'T1', kind: 'ring' })
    for (const id of ['S', 'S2', 'T']) d.placements.push({ refId: id, pos: { x: 0, y: 0 } })
    const moves = Object.fromEntries(arrangeSchematic(d, ['S', 'T', 'S2']).map((m) => [m.refId, m.pos]))
    expect(moves.S).toEqual({ x: 250, y: 0 })
    expect(moves.S2).toEqual({ x: 250, y: schematicBodySize(d, 'S').h + GAP })
    expect(moves.T).toEqual({ x: 500, y: 0 })
  })

  it('a body with no schematicPos falls back to pos, as the canvas does', () => {
    const d = emptyDocument()
    withConnector(d, 'OLD', 2) // pos {3,4}, no schematicPos
    withConnector(d, 'A', 2)
    const [m] = arrangeSchematic(d, ['A'])
    expect(m.pos.y).toBe(4 + schematicBodySize(d, 'OLD').h + GAP)
  })
})
