import type { HarnessDocument, Id, Vec2, LabelTarget, Segment } from './schema'
import { resolveNodePos, routeNodeKey } from './geometry'

/** Ordered segment ids of a wire's route, or [] when it has no route. */
export function wireRoutePath(doc: HarnessDocument, wireId: Id): Id[] {
  return doc.wireRoutes.find((r) => r.wireId === wireId)?.path ?? []
}

/**
 * Segments the selected wires share — the run where they physically travel
 * together. Set intersection of the routes, ordered by the FIRST wire's path.
 * `[]` for fewer than two wires, any unrouted wire, or no common run.
 */
export function twistSpanSegments(doc: HarnessDocument, wireIds: Id[]): Id[] {
  if (wireIds.length < 2) return []
  const paths = wireIds.map((id) => wireRoutePath(doc, id))
  if (paths.some((p) => p.length === 0)) return []
  const [first, ...rest] = paths
  const restSets = rest.map((p) => new Set(p))
  return first.filter((seg) => restSets.every((s) => s.has(seg)))
}

/**
 * Resolve a sleeving target+span from a raw segment selection.
 * Valid IFF exactly one wire routes through every selected segment AND the
 * selection is a contiguous subsequence of that wire's ordered route. Returns
 * the wire id + the segments in route order, else null (caller disables the action).
 */
export function sleevingFromSegments(
  doc: HarnessDocument,
  segmentIds: Id[]
): { wireId: Id; orderedSegmentIds: Id[] } | null {
  if (segmentIds.length === 0) return null
  const sel = new Set(segmentIds)
  const candidates = doc.wireRoutes.filter((r) => {
    const ps = new Set(r.path)
    return [...sel].every((s) => ps.has(s))
  })
  if (candidates.length !== 1) return null
  const path = candidates[0].path
  const idxs = path.map((s, i) => (sel.has(s) ? i : -1)).filter((i) => i >= 0)
  const contiguous = idxs.length === sel.size && idxs[idxs.length - 1] - idxs[0] === idxs.length - 1
  if (!contiguous) return null
  return {
    wireId: candidates[0].wireId,
    orderedSegmentIds: path.slice(idxs[0], idxs[idxs.length - 1] + 1)
  }
}

/**
 * Resolve a sleeving target+span for a BUNDLE from a raw segment selection.
 * Valid IFF every selected segment belongs to exactly one bundle AND the
 * selection is a contiguous run within that bundle. Returns the bundle id + the
 * segments in physical route order, else null (caller disables the action).
 *
 * Ordering: `bundle.segmentIds` is in document order, NOT physical/route order,
 * so we order + contiguity-check against a member wire's `wireRoute.path` (the
 * same machinery `sleevingFromSegments` uses). We pick a member wire whose route
 * contains every selected segment, which also handles Y-split bundles where no
 * single member traverses the whole bundle.
 */
export function sleevingBundleFromSegments(
  doc: HarnessDocument,
  segmentIds: Id[]
): { bundleId: Id; orderedSegmentIds: Id[] } | null {
  if (segmentIds.length === 0) return null
  const sel = new Set(segmentIds)
  const bundles = doc.bundles.filter((b) => {
    const bs = new Set(b.segmentIds)
    return [...sel].every((s) => bs.has(s))
  })
  if (bundles.length !== 1) return null
  const bundle = bundles[0]
  for (const wireId of bundle.memberWireIds) {
    const path = wireRoutePath(doc, wireId)
    const ps = new Set(path)
    if (![...sel].every((s) => ps.has(s))) continue
    const idxs = path.map((s, i) => (sel.has(s) ? i : -1)).filter((i) => i >= 0)
    const contiguous = idxs.length === sel.size && idxs[idxs.length - 1] - idxs[0] === idxs.length - 1
    if (contiguous) {
      return { bundleId: bundle.id, orderedSegmentIds: path.slice(idxs[0], idxs[idxs.length - 1] + 1) }
    }
  }
  return null
}

/** Midpoint of a segment's two resolved node positions, or whichever resolves, or {0,0}. */
function segMidpoint(doc: HarnessDocument, segmentId: Id): Vec2 {
  const seg = doc.segments.find((s) => s.id === segmentId)
  if (!seg) return { x: 0, y: 0 }
  const a = resolveNodePos(doc, seg.from)
  const b = resolveNodePos(doc, seg.to)
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  return a ?? b ?? { x: 0, y: 0 }
}

/** A sensible default position for a new label, by target kind. */
export function labelDefaultPos(doc: HarnessDocument, target: LabelTarget): Vec2 {
  switch (target.type) {
    case 'branchPoint':
      return doc.branchPoints.find((b) => b.id === target.branchId)?.pos ?? { x: 0, y: 0 }
    case 'branch':
      return segMidpoint(doc, target.segmentId)
    case 'wire': {
      const path = wireRoutePath(doc, target.wireId)
      if (path.length === 0) return { x: 0, y: 0 }
      return segMidpoint(doc, path[Math.floor(path.length / 2)])
    }
    case 'bundle':
      return { x: 0, y: 0 } // bundles not authored in v1
  }
}

/**
 * Project point `p` onto the infinite line through `a`→`b` and return the
 * parameter t (0 at `a`, 1 at `b`), CLAMPED to [0,1] so the result stays within
 * the segment. A zero-length segment yields 0. This is the drag constraint: a
 * label dropped anywhere snaps to the nearest point ON its segment's line.
 */
export function projectFraction(a: Vec2, b: Vec2, p: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return 0
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Resolve a label anchor to its on-wire bead position: lerp(from, to, fraction)
 * of the segment's resolved node positions. Null when the segment is missing or
 * either endpoint is unplaced. Drag-by-reference: recomputes from the segment's
 * endpoints, so the bead follows the loom when a branch point moves.
 */
export function labelAnchorPos(
  doc: HarnessDocument,
  anchor: { segmentId: Id; fraction: number }
): Vec2 | null {
  const seg = doc.segments.find((s) => s.id === anchor.segmentId)
  if (!seg) return null
  const a = resolveNodePos(doc, seg.from)
  const b = resolveNodePos(doc, seg.to)
  if (!a || !b) return null
  const t = anchor.fraction
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * Default segment anchor for a new label, by target kind. Wire → middle segment
 * of its route; branch → that segment; bundle → middle of its segments; all at
 * fraction 0.5. Returns null for a branchPoint target (no segment to slide on —
 * stays a free `pos` label) or an unrouted/empty target.
 */
export function defaultAnchor(
  doc: HarnessDocument,
  target: LabelTarget
): { segmentId: Id; fraction: number } | null {
  switch (target.type) {
    case 'branch':
      // Guard the segment's existence: reconcileLabelAnchors heals via this
      // function, so returning a dead id verbatim would re-install the dangling
      // anchor instead of dropping it.
      return doc.segments.some((s) => s.id === target.segmentId)
        ? { segmentId: target.segmentId, fraction: 0.5 }
        : null
    case 'wire': {
      const path = wireRoutePath(doc, target.wireId)
      if (path.length === 0) return null
      return { segmentId: path[Math.floor(path.length / 2)], fraction: 0.5 }
    }
    case 'bundle': {
      const b = doc.bundles.find((x) => x.id === target.bundleId)
      if (!b || b.segmentIds.length === 0) return null
      return { segmentId: b.segmentIds[Math.floor(b.segmentIds.length / 2)], fraction: 0.5 }
    }
    case 'branchPoint':
      return null
  }
}

/** Distance (mm) of an anchor from the NEAREST end of its segment. */
export function anchorMmFromNearestEnd(fraction: number, lengthMm: number): number {
  const fromStart = fraction * lengthMm
  return Math.min(fromStart, lengthMm - fromStart)
}

/**
 * New fraction that places the anchor `mm` from whichever end is currently
 * nearest (decided by `currentFraction`). Clamped to [0,1]; a non-positive
 * length returns the current fraction unchanged.
 */
export function anchorFractionFromNearestEnd(
  currentFraction: number,
  mm: number,
  lengthMm: number
): number {
  if (lengthMm <= 0) return currentFraction
  const f = currentFraction <= 0.5 ? mm / lengthMm : 1 - mm / lengthMm
  return Math.min(1, Math.max(0, f))
}

// ───────────────────────────── Span contiguity ──────────────────────────────
// A Span is "a contiguous run along the loom" (schema.ts). Everything that
// consumes one — spanLengthMm's head/tail trimming, applyInsertBranchPoint's
// fraction remap, the formboard sleeve/twist decoration — relies on that, so
// contiguity is checked HERE, once, and used by both the store guard (reject at
// creation) and DRC (report on load).  R2/R4.

/**
 * Split `segmentIds` into maximal contiguous runs and return the longest one
 * (ties → the earliest run, so a trim keeps the span's start when it can).
 *
 * Contiguous = consecutive segments meet at a shared route node, walked with a
 * cursor so a chain cannot double back through the same node twice. Segment ids
 * that no longer exist, and repeats, end the current run — which is exactly what
 * a topology op needs when it heals a span after a GC. Empty input → `[]`.
 */
export function largestContiguousRun(doc: HarnessDocument, segmentIds: Id[]): Id[] {
  const byId = new Map<Id, Segment>(doc.segments.map((s) => [s.id, s as Segment]))
  const keys = (s: Segment): [string, string] => [routeNodeKey(s.from), routeNodeKey(s.to)]
  const runs: Id[][] = []
  let cur: Id[] = []
  let cursor: string | null = null
  const seen = new Set<Id>()
  const flush = (): void => {
    if (cur.length > 0) runs.push(cur)
    cur = []
    cursor = null
  }
  for (const id of segmentIds) {
    const seg = byId.get(id)
    if (!seg || seen.has(id)) {
      // A dead or repeated id is a break in the chain, not a member of it.
      flush()
      continue
    }
    seen.add(id)
    const [a, b] = keys(seg)
    if (cur.length === 0) {
      cur = [id]
      continue
    }
    if (cur.length === 1) {
      // Orientation of the run's first segment is only decided by its successor.
      const [fa, fb] = keys(byId.get(cur[0])!)
      if (a === fb || b === fb) cursor = fb
      else if (a === fa || b === fa) cursor = fa
      else {
        flush()
        cur = [id]
        continue
      }
    }
    if (a === cursor) {
      cursor = b
      cur.push(id)
    } else if (b === cursor) {
      cursor = a
      cur.push(id)
    } else {
      flush()
      cur = [id]
    }
  }
  flush()
  let best: Id[] = []
  for (const r of runs) if (r.length > best.length) best = r
  return best
}

/**
 * Does `segmentIds` satisfy the Span precondition — every id live, no repeats,
 * and one single chain through the routing graph?
 *
 * The EMPTY span is contiguous by definition: the twist authoring UI creates a
 * twist before its wires are co-routed and lets the span fill in later, so an
 * empty span is a legal intermediate, not a defect (see the `empty-span` DRC
 * rule, which reports it as info).
 */
export function isSpanContiguous(doc: HarnessDocument, segmentIds: Id[]): boolean {
  if (segmentIds.length === 0) return true
  return largestContiguousRun(doc, segmentIds).length === segmentIds.length
}
