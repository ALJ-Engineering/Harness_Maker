/**
 * Anchor lookup + text metrics — the single source of truth for WHERE a wire
 * physically lands on a placed body.
 *
 * Since schema 0.4.0 the answer is trivial and there is no pin math left: a
 * body is ONE dot at its `Placement.pos`, so every wire on it lands on that
 * point whichever cavity it terminates in. The module still exists because the
 * drawn line and its measured length must agree: `computeFormboard` draws a
 * segment dot to dot from `placementPos`, and `geometry.resolveNodePos` reads
 * the same `Placement.pos` for `segmentLengthMm` — one stored point, two
 * readers, asserted equal in `anchors.test.ts`. (Before 0.4.0 this module held
 * the connector/terminal/splice pin layout; see the 2026-08-28 spec §1.1 for
 * why that went away.)
 *
 * There is deliberately no endpoint-shaped wrapper left: an `Endpoint`'s
 * landing point is `placementPos(doc, endpointBodyId(doc, ep))`, and the
 * routing layer asks `geometry.resolveNodePos` for the same point from a
 * `RouteNode` instead. `endpointAnchor` was that wrapper and had no caller
 * once the route graph became body-keyed (schema 0.4.0); it is gone.
 *
 * Pure model layer: no DOM, no Electron, no layout types. Imports only
 * `schema` (types), and must stay free of formboard/geometry imports to avoid
 * cycles.
 */

import type { Cavity, Connector, HarnessDocument, Id, Vec2 } from './schema'

/** Points → millimetres (1 pt = 1/72 inch). */
export const PT_TO_MM = 25.4 / 72
/** Minimum legible text size: 10 pt. ALL formboard/print text uses at least this. */
export const MIN_FONT = 10 * PT_TO_MM // ≈ 3.528 mm
/** Connector designator + terminal label font size in mm (12 pt — the largest text). */
export const LABEL_FONT = 12 * PT_TO_MM // ≈ 4.233 mm

/**
 * Rough text-width estimate: `text.length * fontMm * 0.62`.
 * No DOM font metrics are available in the model layer.
 */
export function estTextWidthMm(text: string, fontMm: number): number {
  return text.length * fontMm * 0.62
}

/** Numeric-aware compare for cavity positions ("2" < "10", "A1" < "A2"). */
export function natCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * A connector's cavities in DISPLAY order — natural, numeric-aware by
 * `position` ("1","2","10", "A1","A2","B1"). Cavity `position` is a string
 * (schema rule), so document order is whatever authoring produced and lexical
 * order puts "10" before "2".
 *
 * DISPLAY ONLY: returns a copy; the stored `cavities` array is never reordered
 * (ids are the stable handle, order carries no meaning). Every place that
 * LISTS cavities — the schematic connector node, the properties-panel cavity
 * table, the pinout table, the BOM walk, DRC findings — goes through this so
 * the engineer sees the same pin order everywhere.
 * `Array.prototype.sort` is stable, so equal-comparing positions keep their
 * relative document order.
 */
export function sortedCavities(c: Connector): Cavity[] {
  return [...c.cavities].sort((x, y) => natCompare(x.position, y.position))
}

/** The dot centre of a placed body, or null if it isn't placed. */
export function placementPos(doc: HarnessDocument, refId: Id): Vec2 | null {
  return doc.placements.find((p) => p.refId === refId)?.pos ?? null
}
