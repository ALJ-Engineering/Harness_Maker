import type { HarnessDocument, RouteNode, Id, Vec2, Segment, Span, Bundle } from './schema'
import { bodyKey, endpointBodyKey } from './endpoints'

/** A stable key for a route-node: `b:<branchId>` or `n:<bodyRefId>`. */
export function routeNodeKey(node: RouteNode): string {
  return node.type === 'branch' ? `b:${node.branchId}` : bodyKey(node.refId)
}

/** Resolve a route-node to its mm position, or null if it isn't placed. */
export function resolveNodePos(doc: HarnessDocument, node: RouteNode): Vec2 | null {
  if (node.type === 'branch') {
    return doc.branchPoints.find((b) => b.id === node.branchId)?.pos ?? null
  }
  // The body's placement IS the dot every wire on it lands on (schema 0.4.0).
  return doc.placements.find((p) => p.refId === node.refId)?.pos ?? null
}

/** Straight-line mm length of a segment, or null if either node is unresolved. */
export function segmentLengthMm(doc: HarnessDocument, segmentId: Id): number | null {
  const seg = doc.segments.find((s) => s.id === segmentId)
  if (!seg) return null
  const a = resolveNodePos(doc, seg.from)
  const b = resolveNodePos(doc, seg.to)
  if (!a || !b) return null
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** A typed segment length this far (mm) from the drawn one reads as "broken". */
export const BROKEN_LENGTH_TOL_MM = 0.5

/**
 * The length the build uses for a segment: the typed `specifiedLengthMm` when set,
 * else the drawn (geometry-derived) length. Null only when untyped and unresolved.
 */
export function effectiveSegmentLengthMm(doc: HarnessDocument, segmentId: Id): number | null {
  const typed = doc.segments.find((s) => s.id === segmentId)?.specifiedLengthMm
  return typed != null ? typed : segmentLengthMm(doc, segmentId)
}

/**
 * Typed length that no longer matches the drawing (>= BROKEN_LENGTH_TOL_MM apart).
 * False when untyped, or when the drawn length cannot be resolved.
 */
export function segmentLengthBroken(doc: HarnessDocument, segmentId: Id): boolean {
  const typed = doc.segments.find((s) => s.id === segmentId)?.specifiedLengthMm
  if (typed == null) return false
  const drawn = segmentLengthMm(doc, segmentId)
  if (drawn == null) return false
  // Tolerance compare with a hair of slack so 1199.5 vs 1200 is not lost to float error.
  return Math.abs(typed - drawn) >= BROKEN_LENGTH_TOL_MM - 1e-9
}

/** True if the route's segments form a connected chain from ends[0] to ends[1]. */
export function routeConnected(doc: HarnessDocument, wireId: Id): boolean {
  const wire = doc.wires.find((w) => w.id === wireId)
  const route = doc.wireRoutes.find((r) => r.wireId === wireId)
  if (!wire || !route || route.path.length === 0) return false
  const segs = route.path.map((id) => doc.segments.find((s) => s.id === id))
  if (segs.some((s) => !s)) return false
  const start = endpointBodyKey(doc, wire.ends[0])
  const goal = endpointBodyKey(doc, wire.ends[1])
  if (!start || !goal) return false
  let cursor = start
  for (const seg of segs as Segment[]) {
    const f = routeNodeKey(seg.from)
    const t = routeNodeKey(seg.to)
    if (f === cursor) cursor = t
    else if (t === cursor) cursor = f
    else return false
  }
  return cursor === goal
}

/**
 * Is `v` an acceptable hand-entered millimetre length?
 *
 * Valid = finite AND non-negative. **Zero is LEGAL**: an explicit 0 mm override
 * is a real statement ("this conductor is a stud-to-stud strap, nothing to
 * cut"), and it is distinguishable from `undefined`, which means "derive the
 * length from the route". Negative, NaN and ±Infinity are not physical and are
 * rejected at the store-action boundary (`setWireLengthOverride` /
 * `setWireAllowance`) and flagged by the `invalid-specified-length` DRC rule for
 * documents that already contain one.
 *
 * Applies to every hand-entered mm override: `Wire.specifiedLengthMm`,
 * `Wire.addLengthMm`, `Cable.specifiedLengthMm`.
 */
export function isValidLengthMm(v: number): boolean {
  return Number.isFinite(v) && v >= 0
}

export type LengthSource = 'specified' | 'derived' | 'unknown'
export interface WireLength {
  mm: number | null
  source: LengthSource
}

/**
 * Length of a sleeving/twist span in mm.
 *
 * Sums the full lengths of all interior segments, then subtracts the unused
 * head of the first segment (startFraction × firstLen, default startFraction=0)
 * and the unused tail of the last segment ((1 − endFraction) × lastLen,
 * default endFraction=1).  For a single-segment span both head and tail are
 * subtracted from the same segment.
 *
 * Returns null if any segment length is unresolved.
 */
export function spanLengthMm(doc: HarnessDocument, span: Span): number | null {
  const { segmentIds, startFraction = 0, endFraction = 1 } = span
  if (segmentIds.length === 0) return 0
  const lengths: (number | null)[] = segmentIds.map((id) => effectiveSegmentLengthMm(doc, id))
  if (lengths.some((l) => l == null)) return null
  const lens = lengths as number[]
  let total = lens.reduce((s, l) => s + l, 0)
  // Subtract unused head of the first segment
  total -= startFraction * lens[0]
  // Subtract unused tail of the last segment
  total -= (1 - endFraction) * lens[lens.length - 1]
  // Guard: inverted fractions (startFraction > endFraction on a single segment)
  // can produce a negative total — treat as unknown rather than a bogus BOM figure.
  if (total < 0) return null
  return total
}

/**
 * The mm a span covers on EACH of its segments, in span order: a segment's full
 * length, less the unused head of the first and tail of the last (one segment:
 * `endFraction - startFraction` of it). Null for a segment whose length is
 * unknown, or a piece that comes out negative (inverted fractions). These are
 * the pieces a sleeve is cut into — one per limb — and they sum to `spanLengthMm`.
 */
export function spanPieceLengthsMm(doc: HarnessDocument, span: Span): (number | null)[] {
  const { segmentIds, startFraction = 0, endFraction = 1 } = span
  const last = segmentIds.length - 1
  return segmentIds.map((id, i) => {
    const len = effectiveSegmentLengthMm(doc, id)
    if (len == null) return null
    const from = i === 0 ? startFraction : 0
    const to = i === last ? endFraction : 1
    const piece = (to - from) * len
    return piece < 0 ? null : piece
  })
}

/**
 * Total mm of loom run a bundle covers — what a tape/wrap part is consumed over.
 *
 * A bundle is NOT a Span: `segmentIds` is document order, not route order, and a
 * bundle may Y-split, so there are no fractional ends to trim. The figure is
 * therefore the plain Σ of its member segments' full lengths (order-independent),
 * 0 for an empty bundle, and null if ANY member segment is unresolved or missing.
 */
export function bundleLengthMm(doc: HarnessDocument, bundle: Bundle): number | null {
  return spanLengthMm(doc, { segmentIds: bundle.segmentIds })
}

/** Wire length with its provenance. Never returns 0 for an unknown length. */
export function wireLength(doc: HarnessDocument, wireId: Id): WireLength {
  const wire = doc.wires.find((w) => w.id === wireId)
  if (!wire) return { mm: null, source: 'unknown' }
  if (wire.specifiedLengthMm != null) return { mm: wire.specifiedLengthMm, source: 'specified' }
  const route = doc.wireRoutes.find((r) => r.wireId === wireId)
  if (!route || route.path.length === 0 || !routeConnected(doc, wireId)) {
    return { mm: null, source: 'unknown' }
  }
  let sum = 0
  for (const segId of route.path) {
    const len = effectiveSegmentLengthMm(doc, segId)
    if (len == null) return { mm: null, source: 'unknown' }
    sum += len
  }
  // Add the strip/termination/service-loop allowance to the routed centreline.
  // (specifiedLengthMm already returned above — a hand-specified length is final.)
  const allowance = Math.max(0, wire.addLengthMm ?? 0)
  return { mm: sum + allowance, source: 'derived' }
}
