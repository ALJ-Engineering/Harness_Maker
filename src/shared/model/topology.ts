/**
 * Derived topology — the ONE place that answers "how many things meet here?".
 *
 * Degree is never stored (model rule: splice/branch-point degree is derived).
 * Before this module four call sites derived it independently and two of them
 * disagreed about self-loops, so a document could be simultaneously
 *   - "degree 2" to DRC (which counted segment ENDS, so one self-loop = 2), and
 *   - "degree 1" to the remove-branch-point guard (which counted SEGMENTS).
 *
 * The settled definition, used everywhere:
 *
 *   **degree = the number of DISTINCT incident edges.** A self-loop — a segment
 *   whose two ends resolve to the same route node, or a wire whose two ends are
 *   the same splice — counts **once**, not twice.
 *
 * Rationale: every consumer asks a "how many separate limbs / conductors leave
 * this node?" question (bend vs Y-split, is-this-junction-real, can-I-merge),
 * and a self-loop leaves zero. Graph-theoretic degree (self-loop = 2) would
 * make a node that is joined to nothing look like a healthy bend.
 *
 * Self-loops are not creatable through the store — `applyMergeBranchPoints`
 * drops them the moment a merge would create one, and insert/split cannot make
 * one. They can still arrive in a hand-authored or externally-edited JSON
 * document, so every helper here is robust to them and DRC's
 * `self-loop-segment` rule flags them on load.
 *
 * Pure model layer: imports only `schema` (types) and `geometry`'s
 * `routeNodeKey`.
 */

import type { HarnessDocument, Id, Segment, Wire } from './schema'
import { routeNodeKey } from './geometry'

/** True if a segment's two ends resolve to the SAME route node (zero-length loop). */
export function isSelfLoopSegment(seg: Segment): boolean {
  return routeNodeKey(seg.from) === routeNodeKey(seg.to)
}

/**
 * The distinct segments touching a branch point, in document order.
 * A self-loop appears ONCE.
 */
export function incidentSegments(doc: HarnessDocument, branchId: Id): Segment[] {
  return doc.segments.filter(
    (s) =>
      (s.from.type === 'branch' && s.from.branchId === branchId) ||
      (s.to.type === 'branch' && s.to.branchId === branchId)
  )
}

/**
 * Derived branch-point degree: how many distinct segments meet here.
 * 2 = a bend (removable), ≥3 = a Y-split, <2 = degenerate (DRC error).
 */
export function branchDegree(doc: HarnessDocument, branchId: Id): number {
  return incidentSegments(doc, branchId).length
}

/** The distinct wires with at least one end on a splice, in document order. */
export function spliceWires(doc: HarnessDocument, spliceId: Id): Wire[] {
  return doc.wires.filter((w) =>
    w.ends.some((e) => e.type === 'splice' && e.spliceId === spliceId)
  )
}

/**
 * Derived splice degree: how many distinct wires land on this splice.
 * A wire looping from the splice back to itself counts once (and so leaves the
 * splice at degree 1 → a `splice-degree` DRC error, which is the right answer:
 * it joins nothing).
 */
export function spliceDegree(doc: HarnessDocument, spliceId: Id): number {
  return spliceWires(doc, spliceId).length
}
