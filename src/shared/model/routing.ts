import type { Draft } from 'immer'
import type { HarnessDocument, Id, Vec2, Segment, RouteNode, Span, PartRef } from './schema'
import { routeNodeKey, resolveNodePos, segmentLengthMm } from './geometry'
import { endpointBodyKey } from './endpoints'
import { newId } from './ids'
import { defaultAnchor, largestContiguousRun } from './treatments'
import { incidentSegments, isSelfLoopSegment } from './topology'

/**
 * Below this (mm) a typed-length share from a branch-point insert is treated as
 * zero: that half is left untyped and the other half takes the whole typed value.
 */
const SPLIT_EPS_MM = 1e-6

export interface InsertBranchIds {
  branchId: Id
  segAId: Id
  segBId: Id
}

export interface RemoveBranchIds {
  mergedSegId: Id
}

/**
 * Re-validate every label anchor after a topology change. An anchor whose
 * segment no longer exists (a coalesced self-loop, a GC'd stub) is re-derived
 * from the label's `target` via `defaultAnchor`; if that yields nothing (e.g.
 * an unrouted wire), the anchor is dropped and the label falls back to its free
 * `pos`. The label itself is NEVER removed here.
 */
export function reconcileLabelAnchors(doc: Draft<HarnessDocument>): void {
  const live = new Set(doc.segments.map((s) => s.id))
  for (const l of doc.labels) {
    if (!l.anchor || live.has(l.anchor.segmentId)) continue
    const a = defaultAnchor(doc, l.target)
    if (a) l.anchor = a
    else delete l.anchor
  }
}

/**
 * Re-validate every sleeving/twist span after a topology change (R2/R3/R4) —
 * run after any op that drops or coalesces segments, and always AFTER the
 * segment GC so the spans are healed against the surviving geometry.
 *
 * Per treatment:
 *   - ids whose segment is gone, and repeats, are dropped;
 *   - what remains is trimmed to the LARGEST surviving contiguous run, because
 *     a Span must stay one chain (`spanLengthMm` trims a head and a tail off
 *     the first/last segment — a span in pieces has no meaningful length);
 *   - `startFraction` / `endFraction` are dropped when the segment they were
 *     measured from is no longer the run's first / last (the fraction refers to
 *     a different segment now; falling back to the full 0..1 end is the safe
 *     reading, and the user can re-drag);
 *   - a treatment whose span HAD segments and now has none is REMOVED (R3) —
 *     it covers nothing and would otherwise become a 0 mm BOM line.
 *
 * A treatment authored with an already-empty span is left alone: the twist UI
 * creates one before its wires are co-routed and lets the span fill in later.
 * Pass `hadSegments` — captured with `spansWithSegments(doc)` BEFORE the op —
 * when the op rewrites spans itself (a merge drops coalesced ids), so an
 * already-emptied span is still recognised as one the op emptied.
 */
export function healSpans(doc: Draft<HarnessDocument>, hadSegments?: Set<string>): void {
  const heal = (key: string, span: Draft<Span>): boolean => {
    const before = span.segmentIds
    const had = hadSegments ? hadSegments.has(key) : before.length > 0
    if (before.length === 0) return !had // empty by authoring → keep; emptied by the op → drop
    const run = largestContiguousRun(doc, before)
    if (run.length === before.length) return true // unchanged (order is preserved)
    if (run.length === 0) return false // emptied by the op → remove the treatment
    if (run[0] !== before[0]) delete span.startFraction
    if (run[run.length - 1] !== before[before.length - 1]) delete span.endFraction
    span.segmentIds = run
    return true
  }
  doc.sleeving = doc.sleeving.filter((sl) => heal(`sl:${sl.id}`, sl.span))
  doc.twists = doc.twists.filter((tw) => heal(`tw:${tw.id}`, tw.span))
}

/**
 * Keys of the treatments whose span currently covers at least one segment —
 * snapshot this BEFORE a topology op and hand it to `healSpans` afterwards, so
 * a span the op emptied is told apart from one authored empty.
 */
export function spansWithSegments(doc: HarnessDocument): Set<string> {
  const keys = new Set<string>()
  for (const sl of doc.sleeving) if (sl.span.segmentIds.length > 0) keys.add(`sl:${sl.id}`)
  for (const tw of doc.twists) if (tw.span.segmentIds.length > 0) keys.add(`tw:${tw.id}`)
  return keys
}

/**
 * Prune labels whose branch/branch-point target no longer resolves — run after
 * any op that GCs segments or branch points. Wire/bundle-target pruning lives
 * in removeWire / syncBundles respectively.
 */
export function pruneDanglingBranchLabels(doc: Draft<HarnessDocument>): void {
  doc.labels = doc.labels.filter((l) => {
    if (l.target.type === 'branch') {
      const sid = l.target.segmentId
      return doc.segments.some((s) => s.id === sid)
    }
    if (l.target.type === 'branchPoint') {
      const bid = l.target.branchId
      return doc.branchPoints.some((b) => b.id === bid)
    }
    return true
  })
}

/**
 * Insert a branch point on an existing segment, splitting it into two and
 * rewriting EVERY reference (routes, bundles, spans, labels) that used the
 * original segment. Orientation-preserving. Pure mutation on an Immer draft;
 * the caller supplies fresh ids. The flagged most-bug-prone op (spec §6).
 *
 * Precondition: a Span's segmentIds is a simple contiguous run with no repeated segment id.
 */
export function applyInsertBranchPoint(
  doc: Draft<HarnessDocument>,
  segmentId: Id,
  pos: Vec2,
  ids: InsertBranchIds
): void {
  const idx = doc.segments.findIndex((s) => s.id === segmentId)
  if (idx < 0) return
  const orig = doc.segments[idx]
  const from = orig.from as RouteNode
  const to = orig.to as RouteNode
  const fromKey = routeNodeKey(from)
  const toKey = routeNodeKey(to)
  const branchNode: RouteNode = { type: 'branch', branchId: ids.branchId }

  // Split fraction t along the original: clamped scalar projection of pos onto
  // the segment line from→to.  t = clamp(dot(pos-from, to-from) / |to-from|², 0, 1).
  // This is correct even when the click is off-axis or outside the segment range.
  const a = resolveNodePos(doc, from)
  const b = resolveNodePos(doc, to)
  let t = 0.5
  if (a && b) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 > 0) {
      const raw = ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2
      t = Math.min(1, Math.max(0, raw))
    }
  }

  doc.branchPoints.push({ id: ids.branchId, pos })
  const segA: Segment = { id: ids.segAId, from, to: branchNode }
  const segB: Segment = { id: ids.segBId, from: branchNode, to }
  // A typed (cut) length is split in proportion to the two DRAWN pieces, so the
  // wires' effective length is unchanged by the insert. The branch point sits at
  // the RAW `pos` (the click), not at the clamped projection, so the drawn pieces
  // are d1 = |a−pos| and d2 = |pos−b| — not t·L / (1−t)·L, which only holds for a
  // click on the segment. segA gets typed × d1/(d1+d2); segB is computed by
  // SUBTRACTION so the halves sum back to the typed value exactly. Unresolved
  // ends or d1+d2 = 0 fall back to the projection fraction t.
  // A typed length must be > 0, so a half that comes out ≤ SPLIT_EPS_MM (pos on
  // an endpoint, or float residue near it) gets NO typed value and the other
  // half carries the full typed length — never store 0 or a ~1e-13 sliver.
  // NEVER copy the typed value onto both halves — that would double the cut
  // length of every wire through this limb. Untyped → both halves untyped (no key).
  if (orig.specifiedLengthMm != null) {
    const typed = orig.specifiedLengthMm
    const d1 = a ? Math.hypot(pos.x - a.x, pos.y - a.y) : 0
    const d2 = b ? Math.hypot(b.x - pos.x, b.y - pos.y) : 0
    const share = a && b && d1 + d2 > 0 ? d1 / (d1 + d2) : t
    const first = typed * share
    const second = typed - first
    if (first <= SPLIT_EPS_MM) segB.specifiedLengthMm = typed
    else if (second <= SPLIT_EPS_MM) segA.specifiedLengthMm = typed
    else {
      segA.specifiedLengthMm = first
      segB.specifiedLengthMm = second
    }
  }
  doc.segments.splice(idx, 1, segA, segB)

  // Entry node into the occurrence at index i within an ordered id list.
  // firstEntryKeyOverride: when provided, it is used as the entry for the FIRST
  // occurrence only (i === 0 and no predecessor available). Allows wireRoutes to
  // pass the wire's starts[0] key so single-segment reversed routes are handled
  // correctly. Bundles/spans leave this undefined and fall back to fromKey.
  const entryKey = (path: Id[], i: number, firstEntryKeyOverride?: string): string => {
    if (i > 0) {
      const prev = doc.segments.find((s) => s.id === path[i - 1])
      if (prev) {
        const pk = [routeNodeKey(prev.from), routeNodeKey(prev.to)]
        if (pk.includes(fromKey)) return fromKey
        if (pk.includes(toKey)) return toKey
      }
    }
    if (i < path.length - 1) {
      const next = doc.segments.find((s) => s.id === path[i + 1])
      if (next) {
        const nk = [routeNodeKey(next.from), routeNodeKey(next.to)]
        if (nk.includes(toKey)) return fromKey
        if (nk.includes(fromKey)) return toKey
      }
    }
    // Single-element list / indeterminate: use wire-start override if provided,
    // then match it to fromKey or toKey; fall back to fromKey (forward default).
    if (firstEntryKeyOverride != null) {
      if (firstEntryKeyOverride === toKey) return toKey
      if (firstEntryKeyOverride === fromKey) return fromKey
    }
    return fromKey // forward default for bundles/spans
  }

  const substitute = (path: Id[], firstEntryKeyOverride?: string): Id[] => {
    const out: Id[] = []
    for (let i = 0; i < path.length; i++) {
      if (path[i] !== segmentId) {
        out.push(path[i])
        continue
      }
      if (entryKey(path, i, i === 0 ? firstEntryKeyOverride : undefined) === fromKey) {
        out.push(ids.segAId, ids.segBId)
      } else {
        out.push(ids.segBId, ids.segAId)
      }
    }
    return out
  }

  // wireRoutes carry a true direction: thread the owning wire's ends[0] key so
  // single-segment reversed routes are correctly oriented after the split.
  for (const r of doc.wireRoutes) {
    const wire = doc.wires.find((w) => w.id === r.wireId)
    const firstEntryKeyOverride = wire ? endpointBodyKey(doc, wire.ends[0]) ?? undefined : undefined
    r.path = substitute(r.path, firstEntryKeyOverride)
  }
  // Bundles/spans have no intrinsic direction; forward default is correct.
  for (const bnd of doc.bundles) bnd.segmentIds = substitute(bnd.segmentIds)

  // Spans: substitute ids; remap fractions when the split lands in the first/last span segment.
  const remap = (span: Span): void => {
    const firstIdx = span.segmentIds.indexOf(segmentId)
    const lastIdx = span.segmentIds.lastIndexOf(segmentId)
    const first = firstIdx === 0
    const last = lastIdx === span.segmentIds.length - 1

    // Determine traversal orientation for the split segment within the span.
    // forward: span enters at `from` node; reversed: span enters at `to` node.
    // Reuses entryKey (which operates on the ORIGINAL path before substitute).
    const spanIdx = firstIdx >= 0 ? firstIdx : lastIdx
    const forward = spanIdx < 0 || entryKey(span.segmentIds, spanIdx) === fromKey

    span.segmentIds = substitute(span.segmentIds)

    if (forward) {
      // Forward traversal: span fraction matches the segment's intrinsic frame.
      // nearLimb = segA (entered first from `from`), farLimb = segB.
      if (first && span.startFraction != null) {
        const sf = span.startFraction
        if (sf <= t) {
          span.startFraction = t === 0 ? 0 : sf / t // within segA
        } else {
          // start moves into segB; drop segA from the span's leading coverage
          span.segmentIds = span.segmentIds.filter((id) => id !== ids.segAId)
          span.startFraction = t === 1 ? 1 : (sf - t) / (1 - t)
        }
      }
      if (last && span.endFraction != null) {
        const ef = span.endFraction
        if (ef >= t) {
          span.endFraction = t === 1 ? 1 : (ef - t) / (1 - t) // within segB
        } else {
          span.segmentIds = span.segmentIds.filter((id) => id !== ids.segBId)
          span.endFraction = t === 0 ? 0 : ef / t
        }
      }
    } else {
      // Reversed traversal: span enters the split segment at `to` (cavB-side = segB).
      // nearLimb = segB, farLimb = segA.
      // A span fraction f in reversed frame = intrinsic position 1 - f.
      // The split threshold in reversed-frame is: tRev = 1 - t.
      const tRev = 1 - t
      if (first && span.startFraction != null) {
        const sf = span.startFraction // fraction in span's (reversed) traversal direction
        if (sf <= tRev) {
          // start is in the near limb (segB, intrinsic [t, 1])
          // local intrinsic pos: 1 - sf; within segB: (1 - sf - t) / (1 - t)
          // in segB's reversed frame: 1 - (1 - sf - t) / (1 - t) = (sf - tRev + 1 - t) ... simplifies:
          // = 1 - (1 - sf - t)/(1 - t) = (1 - t - 1 + sf + t)/(1 - t) = sf / (1 - t)
          span.startFraction = t === 1 ? 0 : sf / (1 - t)
        } else {
          // start is in the far limb (segA, intrinsic [0, t])
          // drop the near limb (segB) from the span's leading coverage
          span.segmentIds = span.segmentIds.filter((id) => id !== ids.segBId)
          // local intrinsic pos in segA: 1 - sf; within segA: (1 - sf) / t; reversed: 1 - (1-sf)/t
          // simplification: sf - tRev = sf - (1-t), reversed frac = 1 - (1-sf)/t = (sf - 1 + t)/t... wait:
          // intrinsic pos = 1 - sf; in segA (intrinsic [0,t]), local frac = (1-sf)/t;
          // traversal is still reversed within segA, so span frac = 1 - (1-sf)/t
          span.startFraction = t === 0 ? 1 : 1 - (1 - sf) / t
        }
      }
      if (last && span.endFraction != null) {
        const ef = span.endFraction // fraction in span's (reversed) traversal direction
        if (ef <= tRev) {
          // end is in the near limb (segB, intrinsic [t, 1]); drop the far limb (segA)
          span.segmentIds = span.segmentIds.filter((id) => id !== ids.segAId)
          span.endFraction = t === 1 ? 0 : ef / (1 - t)
        } else {
          // end is in the far limb (segA, intrinsic [0, t])
          // local intrinsic pos in segA: 1 - ef; within segA: (1 - ef) / t;
          // reversed frame within segA: 1 - (1 - ef) / t
          span.endFraction = t === 0 ? 1 : 1 - (1 - ef) / t
        }
      }
    }
  }
  for (const s of doc.sleeving) {
    if (s.span.segmentIds.includes(segmentId)) remap(s.span)
  }
  for (const tw of doc.twists) {
    if (tw.span.segmentIds.includes(segmentId)) remap(tw.span)
  }

  // Branch-targeted labels keep the near limb (segA).
  for (const l of doc.labels) {
    if (l.target.type === 'branch' && l.target.segmentId === segmentId) {
      l.target.segmentId = ids.segAId
    }
  }

  // Anchored labels riding the split segment: rescale the fraction onto the
  // child limb that holds the bead. Both children keep the original from→to
  // orientation, so the fraction stays in the same frame. f≤t → segA (f/t);
  // else segB ((f−t)/(1−t)); a degenerate t collapses onto the surviving child.
  for (const l of doc.labels) {
    if (!l.anchor || l.anchor.segmentId !== segmentId) continue
    const f = l.anchor.fraction
    if (t > 0 && f <= t) {
      l.anchor = { segmentId: ids.segAId, fraction: f / t }
    } else if (t < 1) {
      l.anchor = { segmentId: ids.segBId, fraction: (f - t) / (1 - t) }
    } else {
      l.anchor = { segmentId: ids.segAId, fraction: f }
    }
  }
}

/**
 * Remove a degree-2 branch point, merging its two incident segments into one.
 * This is the inverse of applyInsertBranchPoint.
 *
 * Returns true if the branch was removed, false if it is a no-op (branch does
 * not exist or is not exactly degree-2 — Y-splits with ≥3 incident segments
 * and orphaned degree-0/1 branches are not removable here).
 *
 * Rewriting rules (mirror image of insert):
 *   - wireRoutes / bundle segmentIds: replace the adjacent pair [seg1,seg2] or
 *     [seg2,seg1] with [mergedSegId]. The pair is always adjacent because both
 *     segments meet at the branch.
 *   - Span segmentIds: same substitution of the adjacent pair.
 *     NOTE: startFraction / endFraction are left as-is when the merged segment
 *     spans across the old pair — this is a known limitation (fraction
 *     re-derivation across a merge is out of scope; no span-creation UI exists
 *     yet that exercises this path). Fractions that fall on the first or last
 *     segment of a span are preserved without rescaling.
 *   - Labels with target.type==='branch' referencing seg1 or seg2 are retargeted
 *     to mergedSegId.
 *   - The branch point is removed from doc.branchPoints.
 *   - Typed length: if either half carries `specifiedLengthMm`, the merged
 *     segment gets `(typed1 ?? drawn1) + (typed2 ?? drawn2)` so the wires'
 *     effective length is preserved; neither typed → none. Drawn lengths are
 *     measured BEFORE the branch point is deleted (they resolve through it).
 *
 * Precondition: caller supplies a fresh mergedSegId that does not clash with
 * any existing id.
 */
export function applyRemoveBranchPoint(
  doc: Draft<HarnessDocument>,
  branchId: Id,
  ids: RemoveBranchIds
): boolean {
  // Find segments incident to this branch point (from OR to is this branch).
  const branchNode: RouteNode = { type: 'branch', branchId }
  const branchKey = routeNodeKey(branchNode)

  // Shared derived degree — a self-loop counts ONCE (see topology.ts).
  const incident = incidentSegments(doc, branchId)

  if (incident.length !== 2) return false // degree ≠ 2 → no-op
  // A self-loop has no "non-branch end", so merging across it would emit a
  // segment still pointing at the branch point we are about to delete. Refuse.
  if (incident.some(isSelfLoopSegment)) return false

  const [seg1, seg2] = incident

  // Determine which end of each segment is NOT the branch — those become the
  // merged segment's endpoints.
  const seg1NonBranch: RouteNode =
    routeNodeKey(seg1.from) === branchKey ? (seg1.to as RouteNode) : (seg1.from as RouteNode)
  const seg2NonBranch: RouteNode =
    routeNodeKey(seg2.from) === branchKey ? (seg2.to as RouteNode) : (seg2.from as RouteNode)

  const merged: Segment = {
    id: ids.mergedSegId,
    from: seg1NonBranch,
    to: seg2NonBranch
  }

  // Typed length survives the heal as the sum of the two halves' EFFECTIVE
  // lengths. Measured now, while both segments and the branch point still exist
  // (the drawn length of either half resolves through the branch point's pos).
  // If a needed drawn length can't be resolved (an unplaced body), there is no
  // honest sum to store, so the merged segment stays untyped and falls back to
  // its own drawn length.
  if (seg1.specifiedLengthMm != null || seg2.specifiedLengthMm != null) {
    const len1 = seg1.specifiedLengthMm ?? segmentLengthMm(doc, seg1.id)
    const len2 = seg2.specifiedLengthMm ?? segmentLengthMm(doc, seg2.id)
    if (len1 != null && len2 != null) merged.specifiedLengthMm = len1 + len2
  }

  // Replace seg1 + seg2 with the merged segment. Keep the position of seg1 in
  // the array for minimal diff noise — remove both, insert merged at the earlier
  // index.
  const idx1 = doc.segments.findIndex((s) => s.id === seg1.id)
  const idx2 = doc.segments.findIndex((s) => s.id === seg2.id)
  // Remove in reverse order so indices stay stable.
  const removeFirst = idx1 < idx2 ? idx2 : idx1
  const removeSecond = idx1 < idx2 ? idx1 : idx2
  doc.segments.splice(removeFirst, 1)
  doc.segments.splice(removeSecond, 1, merged)

  const seg1Id = seg1.id
  const seg2Id = seg2.id

  /**
   * In an ordered id list, replace the merged pair with [mergedSegId]:
   *   - an adjacent pair (seg1Id, seg2Id) / (seg2Id, seg1Id) → one mergedSegId
   *   - a LONE occurrence of seg1Id or seg2Id (e.g. a Span/Bundle covering only
   *     one limb of the bend) → mergedSegId, deduped if it would repeat adjacently
   * Returns a new array (does not mutate the input). wireRoutes always contain
   * the pair adjacently, so the lone branch only fires for spans/bundles.
   */
  const substituteInPath = (path: Id[]): Id[] => {
    const out: Id[] = []
    let i = 0
    while (i < path.length) {
      if (
        i + 1 < path.length &&
        ((path[i] === seg1Id && path[i + 1] === seg2Id) ||
          (path[i] === seg2Id && path[i + 1] === seg1Id))
      ) {
        out.push(ids.mergedSegId)
        i += 2
      } else if (path[i] === seg1Id || path[i] === seg2Id) {
        if (out[out.length - 1] !== ids.mergedSegId) out.push(ids.mergedSegId)
        i++
      } else {
        out.push(path[i])
        i++
      }
    }
    return out
  }

  // Rewrite wireRoutes and bundles.
  for (const r of doc.wireRoutes) {
    r.path = substituteInPath(r.path)
  }
  for (const bnd of doc.bundles) {
    bnd.segmentIds = substituteInPath(bnd.segmentIds)
  }

  // Rewrite span segmentIds for sleeving and twists.
  // Fraction re-derivation across the merge boundary is out of scope (see
  // docstring). Fractions on the boundary segment endpoints are left verbatim;
  // they remain valid relative to the merged segment's traversal direction
  // (which matches seg1's non-branch end → seg2's non-branch end).
  const substituteSpan = (span: Span): void => {
    span.segmentIds = substituteInPath(span.segmentIds)
  }
  for (const s of doc.sleeving) {
    if (s.span.segmentIds.includes(seg1Id) || s.span.segmentIds.includes(seg2Id)) {
      substituteSpan(s.span)
    }
  }
  for (const tw of doc.twists) {
    if (tw.span.segmentIds.includes(seg1Id) || tw.span.segmentIds.includes(seg2Id)) {
      substituteSpan(tw.span)
    }
  }

  // Retarget branch-segment labels from seg1/seg2 to the merged segment.
  // Also retarget branchPoint-targeted labels for the removed branch point.
  for (const l of doc.labels) {
    if (l.target.type === 'branch') {
      if (l.target.segmentId === seg1Id || l.target.segmentId === seg2Id) {
        l.target.segmentId = ids.mergedSegId
      }
    } else if (l.target.type === 'branchPoint' && l.target.branchId === branchId) {
      l.target = { type: 'branch', segmentId: ids.mergedSegId }
    }
    if (l.anchor && (l.anchor.segmentId === seg1Id || l.anchor.segmentId === seg2Id)) {
      // Fraction left verbatim across the merge boundary (mirrors the span
      // limitation documented above); re-drag if it lands off the intended spot.
      l.anchor.segmentId = ids.mergedSegId
    }
  }

  // Remove the branch point.
  const bpIdx = doc.branchPoints.findIndex((b) => b.id === branchId)
  if (bpIdx >= 0) doc.branchPoints.splice(bpIdx, 1)

  return true
}

/**
 * Recompute `doc.bundles` from the current routing topology so the first-class
 * Bundle entities reflect reality. A "bundle" is a maximal connected run of
 * SHARED segments — segments carried by 2+ wire routes — where adjacency is
 * meeting at a common route node (branch point or endpoint). Each connected
 * component becomes one Bundle; its `memberWireIds` is the union of wires routed
 * through any of its segments, and `segmentIds` are the component's segments in
 * document order. Single-wire segments are never bundles.
 * Ids/names are preserved across recomputes by matching each new component to
 * the prior Bundle with the largest segment-id overlap; unmatched components get
 * a fresh id. Any sleeving/label whose `target` is a bundle that no longer exists
 * after the recompute is PRUNED here (the one place bundle ids change), so a
 * dissolved bundle drops its sleeve/label too. Pure mutation on an Immer draft.
 * Idempotent.
 */
export function syncBundles(doc: Draft<HarnessDocument>): void {
  // segment id -> wire ids routed through it
  const segWires = new Map<Id, Id[]>()
  for (const r of doc.wireRoutes)
    for (const sid of r.path) {
      const arr = segWires.get(sid) ?? []
      if (!arr.includes(r.wireId)) arr.push(r.wireId)
      segWires.set(sid, arr)
    }

  // Shared segments (2+ wires) are the bundle limbs.
  const shared = doc.segments.filter((s) => (segWires.get(s.id)?.length ?? 0) >= 2)

  // Union-find over shared segments; union two that meet at a common route node.
  const parent = new Map<Id, Id>()
  for (const s of shared) parent.set(s.id, s.id)
  const find = (x: Id): Id => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: Id, b: Id): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const byNode = new Map<string, Id[]>()
  for (const s of shared) {
    for (const key of [routeNodeKey(s.from), routeNodeKey(s.to)]) {
      const arr = byNode.get(key) ?? []
      arr.push(s.id)
      byNode.set(key, arr)
    }
  }
  for (const ids of byNode.values()) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i])

  // Group shared segments into components (preserve document order within each).
  const comps = new Map<Id, Id[]>()
  for (const s of shared) {
    const root = find(s.id)
    const arr = comps.get(root) ?? []
    arr.push(s.id)
    comps.set(root, arr)
  }

  const oldBundles = doc.bundles
  const claimed = new Set<Id>()
  const next: HarnessDocument['bundles'] = []
  for (const segmentIds of comps.values()) {
    const memberWireIds: Id[] = []
    for (const sid of segmentIds)
      for (const w of segWires.get(sid) ?? []) if (!memberWireIds.includes(w)) memberWireIds.push(w)
    // Inherit id+name+part from the prior bundle that overlaps these segments
    // most (user-authored data must survive a topology recompute).
    let bestId: Id | undefined
    let bestName: string | undefined
    let bestPart: PartRef | undefined
    let bestOverlap = 0
    for (const ob of oldBundles) {
      if (claimed.has(ob.id)) continue
      const overlap = ob.segmentIds.reduce((n, x) => n + (segmentIds.includes(x) ? 1 : 0), 0)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestId = ob.id
        bestName = ob.name
        bestPart = ob.part
      }
    }
    const id = bestOverlap > 0 && bestId != null ? bestId : newId()
    if (bestOverlap > 0 && bestId != null) claimed.add(bestId)
    next.push({
      id,
      ...(bestName != null ? { name: bestName } : {}),
      segmentIds,
      memberWireIds,
      ...(bestPart != null ? { part: bestPart } : {})
    })
  }
  doc.bundles = next

  // A bundle that dissolved (dropped below 2 wires) takes its sleeve/label with
  // it — prune annotations targeting a bundle id that no longer exists.
  const liveBundleIds = new Set(next.map((b) => b.id))
  doc.sleeving = doc.sleeving.filter(
    (sl) => sl.target.type !== 'bundle' || liveBundleIds.has(sl.target.bundleId)
  )
  doc.labels = doc.labels.filter(
    (l) => l.target.type !== 'bundle' || liveBundleIds.has(l.target.bundleId)
  )
}

/**
 * Merge branch point `srcId` into `dstId` — the "collapse two bundle branch
 * points into one" gesture. This is how bundles are authored in the formboard:
 * put a branch point on each wire, then drag one onto another to fuse them. Do
 * it again further down the loom and the parallel limbs between the two fused
 * points coalesce into ONE shared segment that carries every wire — a bundle.
 *
 * Steps (all on one Immer draft, one atomic undoable command at the store level):
 *   1. Re-point every segment end referencing `srcId` to `dstId`.
 *   2. Remove the `srcId` branch point.
 *   3. Drop zero-length self-loops (a segment whose two ends are now the same
 *      node) and rewrite every ordered id list to skip them.
 *   4. Coalesce parallel segments (same unordered node pair) onto a single
 *      canonical id, rewriting routes / bundles / spans / branch labels; the
 *      canonical keeps its typed length, or inherits a lone duplicate's.
 *   5. GC branch points left at degree 0; prune labels whose target vanished.
 *   6. `syncBundles` so the Bundle entities reflect the new shared limbs.
 *
 * Returns false (no-op) when `srcId === dstId` or either branch point is absent.
 * Wires keep their own routes through the shared limb, so an unlimited number of
 * wires can bundle and they need not share a destination.
 */
export function applyMergeBranchPoints(doc: Draft<HarnessDocument>, srcId: Id, dstId: Id): boolean {
  if (srcId === dstId) return false
  if (!doc.branchPoints.some((b) => b.id === srcId)) return false
  if (!doc.branchPoints.some((b) => b.id === dstId)) return false
  const hadSpanSegments = spansWithSegments(doc) // for healSpans (R3), see step 6

  // 1. Re-point segment ends from src → dst.
  for (const seg of doc.segments) {
    if (seg.from.type === 'branch' && seg.from.branchId === srcId)
      seg.from = { type: 'branch', branchId: dstId }
    if (seg.to.type === 'branch' && seg.to.branchId === srcId)
      seg.to = { type: 'branch', branchId: dstId }
  }
  // 2. Remove the merged-away branch point.
  doc.branchPoints = doc.branchPoints.filter((b) => b.id !== srcId)

  // 3. Self-loops: zero-length segments whose ends collapsed to one node.
  const loopIds = new Set<Id>(
    doc.segments.filter((s) => routeNodeKey(s.from) === routeNodeKey(s.to)).map((s) => s.id)
  )

  // 4. Parallel duplicates: map every non-canonical segment to the first segment
  //    (in document order) sharing its unordered node pair.
  const canonicalByPair = new Map<string, Id>()
  const canonicalFromKey = new Map<string, string>() // pairKey -> canonical's `from` node key
  const remap = new Map<Id, Id>() // duplicate id -> canonical id
  const remapFlip = new Map<Id, boolean>() // duplicate id -> reversed vs the canonical
  for (const s of doc.segments) {
    if (loopIds.has(s.id)) continue
    const k1 = routeNodeKey(s.from)
    const k2 = routeNodeKey(s.to)
    const pairKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
    const canon = canonicalByPair.get(pairKey)
    if (canon == null) {
      canonicalByPair.set(pairKey, s.id)
      canonicalFromKey.set(pairKey, k1)
    } else {
      remap.set(s.id, canon)
      remapFlip.set(s.id, k1 !== canonicalFromKey.get(pairKey))
    }
  }

  // Typed length on a coalesced limb: the canonical keeps its own value; if it
  // has none, it inherits the first (document-order) duplicate's typed value, so
  // a length typed on the absorbed segment isn't silently lost. Two different
  // typed values meeting → the canonical's wins, no finding raised here (rare;
  // the broken-length DRC still flags it if it disagrees with the drawing).
  // A dropped self-loop's typed value has nowhere to go and is discarded with it.
  for (const s of doc.segments) {
    const canonId = remap.get(s.id)
    if (canonId == null || s.specifiedLengthMm == null) continue
    const canon = doc.segments.find((c) => c.id === canonId)
    if (canon && canon.specifiedLengthMm == null) canon.specifiedLengthMm = s.specifiedLengthMm
  }

  // Remove dropped segments (loops + non-canonical duplicates).
  const dropped = new Set<Id>([...loopIds, ...remap.keys()])
  doc.segments = doc.segments.filter((s) => !dropped.has(s.id))

  // Rewrite an ordered segment-id list: skip dropped loops, remap duplicates to
  // the canonical id, and collapse any resulting adjacent repeat.
  const rewritePath = (path: Id[]): Id[] => {
    const out: Id[] = []
    for (const id of path) {
      if (loopIds.has(id)) continue
      const mapped = remap.get(id) ?? id
      if (out.length === 0 || out[out.length - 1] !== mapped) out.push(mapped)
    }
    return out
  }
  for (const r of doc.wireRoutes) r.path = rewritePath(r.path)
  for (const b of doc.bundles) b.segmentIds = rewritePath(b.segmentIds)

  // Spans additionally carry fractions. A single-segment span renders in its
  // segment's intrinsic from→to frame, so when its lone segment coalesces onto
  // an opposite-direction canonical, mirror the fractions into the new frame
  // (multi-segment spans re-orient by node-chaining and need no flip).
  const rewriteSpan = (span: Span): void => {
    const before = [...span.segmentIds]
    span.segmentIds = rewritePath(span.segmentIds)
    if (before.length === 1 && span.segmentIds.length === 1 && remapFlip.get(before[0])) {
      const s = span.startFraction ?? 0
      const e = span.endFraction ?? 1
      span.startFraction = 1 - e
      span.endFraction = 1 - s
    }
  }
  for (const sl of doc.sleeving) rewriteSpan(sl.span)
  for (const tw of doc.twists) rewriteSpan(tw.span)

  // Retarget branch-segment labels and anchors off a coalesced duplicate onto
  // the canonical segment; flip the anchor fraction when the duplicate ran the
  // opposite direction (same unordered node pair, reversed from/to).
  for (const l of doc.labels) {
    if (l.target.type === 'branch') {
      const m = remap.get(l.target.segmentId)
      if (m) l.target.segmentId = m
    }
    if (l.anchor) {
      const m = remap.get(l.anchor.segmentId)
      if (m) {
        const flipped = remapFlip.get(l.anchor.segmentId) ?? false
        l.anchor = { segmentId: m, fraction: flipped ? 1 - l.anchor.fraction : l.anchor.fraction }
      }
    }
  }

  // 5. GC branch points no surviving segment touches.
  const liveBranch = new Set<Id>()
  for (const seg of doc.segments) {
    if (seg.from.type === 'branch') liveBranch.add(seg.from.branchId)
    if (seg.to.type === 'branch') liveBranch.add(seg.to.branchId)
  }
  doc.branchPoints = doc.branchPoints.filter((b) => liveBranch.has(b.id))

  // Prune labels whose target was dropped (a self-loop segment with no canonical
  // replacement, or a branch point that was merged/GC'd).
  doc.labels = doc.labels.filter((l) => {
    if (l.target.type === 'branch') return !loopIds.has(l.target.segmentId)
    if (l.target.type === 'branchPoint') {
      const bid = l.target.branchId
      return doc.branchPoints.some((b) => b.id === bid)
    }
    return true
  })

  // A coalesce can leave a span in pieces, or covering nothing at all when its
  // only segment was a dropped self-loop — heal/prune before anything derives a
  // length from it (R3).
  healSpans(doc, hadSpanSegments)

  // 6. Refresh the first-class Bundle entities from the new topology.
  syncBundles(doc)
  // Heal any anchor whose segment vanished (a dropped self-loop) by re-deriving
  // it from the target.
  reconcileLabelAnchors(doc)

  return true
}

/**
 * Disconnect a single wire from a bundle AT ONE branch point (the formboard
 * "break out here" gesture). The wire detaches from the loom only at `branchId`:
 * the two segments of its route that meet at that point are spliced out and
 * replaced by ONE direct segment between their far ends, so the wire bypasses
 * this point but keeps the rest of its route — including any OTHER bundle limbs
 * it still runs in. Orphaned segments + degree-0 branch points are GC'd, then
 * `syncBundles` recomputes the bundles (a shared limb the wire just left drops it;
 * a bundle falling below two wires dissolves and `syncBundles` prunes its
 * sleeve/label).
 *
 * `bypassSegId` is a fresh id for the replacement segment. Returns false (no-op)
 * when the wire has no route, or `branchId` is not an interior point of it (no
 * two consecutive route segments meet there). Pure mutation on an Immer draft.
 */
export function applyDisconnectWireAtBranch(
  doc: Draft<HarnessDocument>,
  wireId: Id,
  branchId: Id,
  bypassSegId: Id
): boolean {
  const route = doc.wireRoutes.find((r) => r.wireId === wireId)
  if (!route) return false
  const hadSpanSegments = spansWithSegments(doc) // for healSpans after the GC (R3/R4)
  const bKey = routeNodeKey({ type: 'branch', branchId })
  const segById = new Map(doc.segments.map((s) => [s.id, s]))
  const touchesB = (segId: Id): boolean => {
    const s = segById.get(segId)
    return !!s && (routeNodeKey(s.from) === bKey || routeNodeKey(s.to) === bKey)
  }

  // Find the adjacent route pair that meets at this branch point.
  let idx = -1
  for (let i = 0; i + 1 < route.path.length; i++) {
    if (touchesB(route.path[i]) && touchesB(route.path[i + 1])) {
      idx = i
      break
    }
  }
  if (idx < 0) return false

  const sA = segById.get(route.path[idx])!
  const sB = segById.get(route.path[idx + 1])!
  // Far ends (the nodes that are NOT this branch point) become the bypass ends.
  const u: RouteNode = routeNodeKey(sA.from) === bKey ? sA.to : sA.from
  const v: RouteNode = routeNodeKey(sB.from) === bKey ? sB.to : sB.from
  doc.segments.push({ id: bypassSegId, from: u, to: v })
  route.path = [...route.path.slice(0, idx), bypassSegId, ...route.path.slice(idx + 2)]

  // Re-sync bundles BEFORE the segment GC: the wire just left the limb(s) at this
  // point, so an affected bundle sheds it (dissolving + dropping its sleeve/label
  // if it falls below two wires). Limbs the wire still routes are untouched.
  syncBundles(doc)

  // GC: drop segments no longer referenced by any route / bundle (the wire's old
  // stubs here; a shared limb survives while another wire routes it).
  // R4: treatments are deliberately NOT roots. A segment is a layout edge of the
  // loom — its existence follows the wire routes/bundles that run through it, not
  // a sleeve or twist that merely names it. Rooting the GC on spans kept dead
  // stubs alive as wire-less "ghost" lines on the formboard and in the SVG;
  // `healSpans` below trims the treatments onto the surviving geometry instead.
  const referenced = new Set<Id>()
  for (const r of doc.wireRoutes) for (const s of r.path) referenced.add(s)
  for (const b of doc.bundles) for (const s of b.segmentIds) referenced.add(s)
  doc.segments = doc.segments.filter((seg) => referenced.has(seg.id))

  // Heal sleeving/twist spans against the surviving segments (R3/R4).
  healSpans(doc, hadSpanSegments)

  // GC: drop branch points no surviving segment touches.
  const liveBranch = new Set<Id>()
  for (const seg of doc.segments) {
    if (seg.from.type === 'branch') liveBranch.add(seg.from.branchId)
    if (seg.to.type === 'branch') liveBranch.add(seg.to.branchId)
  }
  doc.branchPoints = doc.branchPoints.filter((b) => liveBranch.has(b.id))

  // Drop labels whose branch/branch-point target was just GC'd — they can't be
  // healed (the target itself is gone, not just the anchor).
  pruneDanglingBranchLabels(doc)

  // A label anchored to one of the GC'd stubs is re-anchored onto the wire's
  // surviving route (or dropped to a free label) — never deleted.
  reconcileLabelAnchors(doc)

  return true
}
