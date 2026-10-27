import type { Draft } from 'immer'
import type { HarnessDocument, Id, Vec2 } from './schema'
import { routeNodeKey, resolveNodePos, segmentLengthMm, segmentLengthBroken } from './geometry'
import { bodyKey } from './endpoints'

/** The end of the segment the pressed arrow points toward — that side moves. */
export type RescaleEnd = 'from' | 'to'

/**
 * - `ok`         — the side moved; the segment's drawn length now equals its typed one.
 * - `loop`       — the two ends are also joined some other way; refused, no change.
 * - `not-broken` — untyped, or drawn already within BROKEN_LENGTH_TOL_MM of typed.
 * - `unresolved` — an end has no position, or the limb has zero drawn length (no direction).
 * - `no-segment` — unknown segment id.
 */
export type RescaleResult = 'ok' | 'loop' | 'not-broken' | 'unresolved' | 'no-segment'

/**
 * Route-node keys (`b:<id>` / `n:<refId>`) on the `toward` side of segment S:
 * the connected component containing that end in the routing graph built from
 * `doc.segments` with S removed. Built from SEGMENTS only — never from geometry
 * or electrical wires (two-layer rule). `'loop'` when the other end of S is in
 * that component too (moving the side would stretch some other limb). An unknown
 * segment id yields an empty set.
 */
export function sideNodeKeys(doc: HarnessDocument, segmentId: Id, toward: RescaleEnd): Set<string> | 'loop' {
  const seg = doc.segments.find((s) => s.id === segmentId)
  if (!seg) return new Set()
  const start = routeNodeKey(toward === 'to' ? seg.to : seg.from)
  const other = routeNodeKey(toward === 'to' ? seg.from : seg.to)

  const adj = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    const list = adj.get(a)
    if (list) list.push(b)
    else adj.set(a, [b])
  }
  for (const s of doc.segments) {
    if (s.id === segmentId) continue
    const a = routeNodeKey(s.from)
    const b = routeNodeKey(s.to)
    link(a, b)
    link(b, a)
  }

  // BFS from the toward end. A self-loop S (start === other) lands here at once.
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length > 0) {
    const k = queue.shift()!
    for (const n of adj.get(k) ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      queue.push(n)
    }
  }
  return seen.has(other) ? 'loop' : seen
}

/**
 * The vector the `toward` side moves by, or a refusal code. Pure read — shared
 * by the dry run (store pre-check) and the draft mutation, so both agree.
 */
function planRescale(
  doc: HarnessDocument,
  segmentId: Id,
  toward: RescaleEnd
): { keys: Set<string>; d: Vec2 } | Exclude<RescaleResult, 'ok'> {
  const seg = doc.segments.find((s) => s.id === segmentId)
  if (!seg) return 'no-segment'
  const a = resolveNodePos(doc, toward === 'to' ? seg.from : seg.to) // fixed end
  const b = resolveNodePos(doc, toward === 'to' ? seg.to : seg.from) // moving end
  const drawn = segmentLengthMm(doc, segmentId)
  if (!a || !b || drawn == null) return 'unresolved'
  if (!segmentLengthBroken(doc, segmentId)) return 'not-broken'
  // A zero-length limb has no line to move along. (Unreachable through the UI:
  // a coincident pair has no visible label to press an arrow on.)
  if (drawn < 1e-9) return 'unresolved'
  const keys = sideNodeKeys(doc, segmentId, toward)
  if (keys === 'loop') return 'loop'
  const k = (seg.specifiedLengthMm! - drawn) / drawn // unit(b − a) × (typed − drawn)
  return { keys, d: { x: (b.x - a.x) * k, y: (b.y - a.y) * k } }
}

/** Dry run: what `applyRescaleSegment` would return, without touching the doc. */
export function checkRescaleSegment(doc: HarnessDocument, segmentId: Id, toward: RescaleEnd): RescaleResult {
  const plan = planRescale(doc, segmentId, toward)
  return typeof plan === 'string' ? plan : 'ok'
}

/**
 * Rescale segment S to its typed length by moving the `toward` end ALONG S's own
 * line by `typed − drawn` (negative = shrink), and every route node on that side
 * rigidly by the same vector (spec §3 "What that side means"). Nothing on the
 * other side moves, nor does the drawing sheet. Anchored labels, spans, bundles
 * and routes follow by reference and are never written; a free label moves only
 * when its target is on the moved side (below). Pure mutation on an Immer
 * draft; on any non-`ok` result nothing is written.
 *
 * Per moved node:
 *   - branch point `b:<id>` → `pos += d`;
 *   - placement `n:<refId>` → `schematicPos` frozen first (as `applyNodePositions`
 *     does — the schematic draws `schematicPos ?? pos`), then `pos += d`;
 *   - that body's PINNED pinout / picture block (`drawing.blocks`) → `+= d`, so
 *     its leader does not stretch. Unpinned blocks are left to the planner;
 *   - a FREE (unanchored) label targeting a moved branch point, or a segment
 *     whose BOTH ends moved (never S itself — its fixed end stays) → `pos += d`.
 */
export function applyRescaleSegment(d: Draft<HarnessDocument>, segmentId: Id, toward: RescaleEnd): RescaleResult {
  const plan = planRescale(d as HarnessDocument, segmentId, toward)
  if (typeof plan === 'string') return plan
  const { keys, d: v } = plan
  const shift = (p: Vec2): Vec2 => ({ x: p.x + v.x, y: p.y + v.y })

  for (const bp of d.branchPoints) if (keys.has(`b:${bp.id}`)) bp.pos = shift(bp.pos)

  const blocks = d.drawing.blocks
  for (const p of d.placements) {
    if (!keys.has(bodyKey(p.refId))) continue
    if (!p.schematicPos) p.schematicPos = p.pos
    p.pos = shift(p.pos)
    const pin = blocks?.pinout?.[p.refId]
    if (pin) blocks!.pinout![p.refId] = shift(pin)
    const pic = blocks?.picture?.[p.refId]
    if (pic) blocks!.picture![p.refId] = shift(pic)
  }

  // A FREE label whose target moved rigidly rides along, so its leader does not
  // stretch: a moved branch point, or a segment with both ends moved. (LabelTarget
  // has no body kind; anchored labels follow their segment by reference and are
  // not written.)
  const movedSegments = new Set(
    d.segments.filter((s) => keys.has(routeNodeKey(s.from)) && keys.has(routeNodeKey(s.to))).map((s) => s.id)
  )
  for (const l of d.labels) {
    if (l.anchor) continue
    const t = l.target
    const moved =
      (t.type === 'branchPoint' && keys.has(`b:${t.branchId}`)) ||
      (t.type === 'branch' && movedSegments.has(t.segmentId))
    if (moved) l.pos = shift(l.pos)
  }
  return 'ok'
}
