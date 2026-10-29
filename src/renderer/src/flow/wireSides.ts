import type { Endpoint, HarnessDocument, Id, Vec2, Wire } from '@shared/model/schema'
import { endpointHandleId, sideHandleId, type HandleSide } from '@shared/model/endpoints'
import { sortedCavities } from '@shared/model/anchors'

/**
 * Which side of its box each wire meets a body on, in the schematic.
 *
 * A free terminal or splice is ONE electrical point, so the side a wire enters
 * it on is drawing only: it has a handle on all four sides, and each wire takes
 * the side that faces its other end. A connector's wires leave the side its
 * `schematicExitSide` names; with `'nearest'` (inline parts: a fuse, a diode, a
 * relay) each wire leaves its pin row on whichever side, left or right, faces
 * its other end. Without this a wire whose other end lay behind a body looped
 * round it or ran underneath it.
 *
 * Decided here, in the projection, from the stored positions and ESTIMATED box
 * sizes (React Flow measures only after rendering, and feeding measurements
 * back would loop): the side updates when the document changes, e.g. when a
 * dragged body is dropped, not during the drag.
 */

/** Approximate schematic box sizes at zoom 1 (`index.css` `.node`, `.node__title`, `.cavity`). */
export const SCHEMATIC_BOX = { width: 100, titleH: 24, rowH: 22, terminalH: 55 } as const

/**
 * The side of a box centred at `c` that faces `p`, split at 45°: left or right
 * unless `p` lies more above or below than to the side. Not the edge a ray
 * would cross — the boxes are wider than tall, and that sent diagonal wires
 * into the top or bottom, where a schematic reads better entered from the side.
 */
export function facingSide(c: Vec2, p: Vec2): HandleSide {
  const dx = p.x - c.x
  const dy = p.y - c.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

type ExitSide = 'left' | 'right' | 'top' | 'bottom' | 'nearest'

/**
 * `(wire) → [handle of end 0, handle of end 1]` for `doc`, given each body's
 * schematic position. Builds its cavity index once, so call it once per
 * projection.
 */
export function wireHandles(doc: HarnessDocument, posOf: (refId: Id) => Vec2): (w: Wire) => [string, string] {
  const placement = new Map(doc.placements.map((p) => [p.refId, p]))
  // cavity id → its connector, display row and the connector's exit side.
  const cavity = new Map<Id, { at: Vec2; row: number; side: ExitSide }>()
  for (const c of doc.connectors) {
    const p = placement.get(c.id)
    const rows = sortedCavities(c)
    if (p?.schematicPinOrderReversed) rows.reverse()
    const at = posOf(c.id)
    const side: ExitSide = p?.schematicExitSide ?? 'right'
    rows.forEach((cv, row) => cavity.set(cv.id, { at, row, side }))
  }
  const { width, titleH, rowH, terminalH } = SCHEMATIC_BOX

  const isPoint = (ep: Endpoint): ep is Extract<Endpoint, { type: 'freeTerminal' | 'splice' }> =>
    ep.type === 'freeTerminal' || ep.type === 'splice'
  const pointCentre = (ep: Extract<Endpoint, { type: 'freeTerminal' | 'splice' }>): Vec2 => {
    const at = posOf(ep.type === 'freeTerminal' ? ep.terminalId : ep.spliceId)
    return { x: at.x + width / 2, y: at.y + terminalH / 2 }
  }

  /** Where the wire meets this end, as the OTHER end aims at it: a pin's handle, a row's middle, a box's centre. */
  const target = (ep: Endpoint): Vec2 | null => {
    if (isPoint(ep)) return pointCentre(ep)
    if (ep.type !== 'cavity') return null
    const cv = cavity.get(ep.cavityId)
    if (!cv) return null
    const x = cv.side === 'left' ? cv.at.x : cv.side === 'nearest' ? cv.at.x + width / 2 : cv.at.x + width
    return { x, y: cv.at.y + titleH + (cv.row + 0.5) * rowH }
  }

  const handle = (ep: Endpoint, other: Endpoint): string => {
    const aim = target(other)
    if (isPoint(ep)) return sideHandleId(ep, aim ? facingSide(pointCentre(ep), aim) : 'left')
    if (ep.type === 'cavity') {
      const cv = cavity.get(ep.cavityId)
      if (cv?.side === 'nearest') return sideHandleId(ep, aim && aim.x < cv.at.x + width / 2 ? 'left' : 'right')
    }
    return endpointHandleId(ep)
  }

  return (w) => [handle(w.ends[0], w.ends[1]), handle(w.ends[1], w.ends[0])]
}
