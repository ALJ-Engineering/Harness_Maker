import type { HarnessDocument, Id, Vec2 } from '@shared/model/schema'

/**
 * A readable first SCHEMATIC view for bodies a batch placed: connectors in a
 * column at x = 0, splices at x = 250, free terminals at x = 500, each new body
 * stacked downward below the lowest existing body occupying that column, with a
 * GAP between boxes. Existing bodies never move. Only `schematicPos` is
 * produced (applied with `commitNodePositions(…, 'schematic')`); the formboard
 * `pos` is the user's.
 *
 * Units are schematic-canvas units (the React Flow coordinates `schematicPos`
 * is in — the brief calls them mm). The box sizes below are estimates of the
 * rendered schematic nodes (`ConnectorNode` is a title row plus one row per
 * cavity; `index.css` `.cavity` is ~22 units with its padding and border).
 * `anchors.ts`, which the brief points to for body sizing, has held no body
 * geometry since schema 0.4.0 (bodies became dots), so the estimate lives here.
 */
export const COLUMN_X = { connector: 0, splice: 250, terminal: 500 } as const
export const GAP = 20

const TITLE_H = 28
const CAVITY_ROW_H = 24
const COLUMN_W = 200 // < 250: columns never overlap each other

type Kind = keyof typeof COLUMN_X

function kindOf(doc: HarnessDocument, id: Id): Kind | null {
  if (doc.connectors.some((c) => c.id === id)) return 'connector'
  if (doc.splices.some((s) => s.id === id)) return 'splice'
  if (doc.freeTerminals.some((t) => t.id === id)) return 'terminal'
  return null
}

/** Estimated schematic box of a body (width, height). */
export function schematicBodySize(doc: HarnessDocument, id: Id): { w: number; h: number } {
  const conn = doc.connectors.find((c) => c.id === id)
  if (conn) return { w: 120, h: TITLE_H + Math.max(1, conn.cavities.length) * CAVITY_ROW_H }
  const ft = doc.freeTerminals.find((t) => t.id === id)
  if (ft) return { w: 140, h: ft.landsOn ? 64 : 48 }
  return { w: 100, h: 48 }
}

function schematicPosOf(doc: HarnessDocument, id: Id): Vec2 | null {
  const p = doc.placements.find((pp) => pp.refId === id)
  return p ? (p.schematicPos ?? p.pos) : null
}

export function arrangeSchematic(doc: HarnessDocument, newIds: Id[]): { refId: Id; pos: Vec2 }[] {
  const fresh = new Set(newIds)
  // Bottom of the lowest existing box whose x-extent overlaps each column.
  const floor: Record<Kind, number> = { connector: 0, splice: 0, terminal: 0 }
  const seen: Record<Kind, boolean> = { connector: false, splice: false, terminal: false }
  for (const p of doc.placements) {
    if (fresh.has(p.refId) || !kindOf(doc, p.refId)) continue
    const pos = schematicPosOf(doc, p.refId)!
    const { w, h } = schematicBodySize(doc, p.refId)
    for (const k of Object.keys(COLUMN_X) as Kind[]) {
      const x0 = COLUMN_X[k]
      if (pos.x < x0 + COLUMN_W && x0 < pos.x + w) {
        const bottom = pos.y + h + GAP
        if (!seen[k] || bottom > floor[k]) floor[k] = bottom
        seen[k] = true
      }
    }
  }
  const out: { refId: Id; pos: Vec2 }[] = []
  for (const id of newIds) {
    const k = kindOf(doc, id)
    if (!k) continue
    out.push({ refId: id, pos: { x: COLUMN_X[k], y: floor[k] } })
    floor[k] += schematicBodySize(doc, id).h + GAP
  }
  return out
}
