import type { Draft } from 'immer'
import type { HarnessDocument, Id, Label, Span } from './schema'
import {
  healSpans,
  pruneDanglingBranchLabels,
  reconcileLabelAnchors,
  syncBundles
} from './routing'

/**
 * What kind of dangler was repaired. One per unambiguous defect class; anything
 * that needs a human decision is deliberately NOT in this list (see the module
 * doc below).
 */
export type RepairKind =
  | 'orphaned-route'
  | 'dangling-cable-core'
  | 'dangling-cable-drain'
  | 'empty-cable'
  | 'dangling-twist-member'
  | 'twist-removed'
  | 'dangling-sleeving-target'
  | 'dangling-label-target'
  | 'dangling-label-anchor'
  | 'span-trimmed'
  | 'empty-span-treatment'
  | 'bundle-resynced'

/** One thing reconcile changed, for reporting to the user after a load. */
export interface Repair {
  kind: RepairKind
  /** The entity that was repaired or removed (wire id for an orphaned route). */
  entityId: Id
  message: string
}

export interface ReconcileResult {
  doc: HarnessDocument
  repairs: Repair[]
}

const spanSig = (s: Span): string =>
  `${s.segmentIds.join('>')}|${s.startFraction ?? ''}|${s.endFraction ?? ''}`

const anchorSig = (l: Label): string =>
  l.anchor ? `${l.anchor.segmentId}@${l.anchor.fraction}` : ''

const bundleSig = (b: { segmentIds: Id[]; memberWireIds: Id[] }): string =>
  `${b.segmentIds.join(',')}|${b.memberWireIds.join(',')}`

/**
 * Repair a freshly-loaded document's UNAMBIGUOUS danglers — run once, on load,
 * between `parseDocument` and the store. Never on an edit: the store's own ops
 * keep the document consistent, and re-running this on every edit would fight
 * legal authoring intermediates.
 *
 * Documents written before the session-11 fix batch can carry references to
 * entities their delete/GC paths failed to prune (a label pinned to a segment
 * that is gone, a cable still listing a deleted core). Those show up as
 * `dangling-label-ref` / `dangling-member` DRC errors the user cannot clear
 * without touching the topology. This composes the SAME heal helpers the
 * topology ops run afterwards, in the same order the delete cascade uses:
 *
 *   1. drop references to entities that do not exist (routes, cable cores and
 *      drain, twist members, sleeving/label targets) — plus the R1 empty-cable
 *      policy from `removeWiresFromDraft`
 *   2. `pruneDanglingBranchLabels` — branch / branch-point targets
 *   3. `reconcileLabelAnchors` — re-derive or drop a bead on a dead segment
 *   4. `healSpans`, scoped to spans that actually lost a segment
 *   5. `syncBundles` — re-derive bundles, which also prunes bundle-targeted
 *      sleeving/labels left behind by a dissolved bundle
 *
 * Deliberately NOT repaired — every one of these is a judgement call, and each
 * already has a DRC rule that says so: a wire endpoint naming a missing
 * cavity/splice/terminal/cable (`dangling-endpoint` — dropping the wire would
 * destroy electrical truth), `Wire.cableId` naming a missing cable
 * (`dangling-member`), a NON-contiguous span of live segments
 * (`non-contiguous-span` — which end the user meant to keep is unknowable), a
 * self-loop segment (`self-loop-segment`), a negative/NaN length override
 * (`invalid-specified-length`), and orphaned or under-connected branch points
 * and splices (`branchpoint-degree` / `splice-degree`). Segments that no wire
 * routes through are likewise left alone: unlike the delete cascade, a load has
 * no gesture to attribute them to.
 *
 * Pure: the input is never mutated, and a document with nothing to fix comes
 * back by REFERENCE with an empty `repairs` list (so a clean file loads
 * un-dirty and round-trips byte-identically).
 */
export function reconcileDocument(doc: HarnessDocument): ReconcileResult {
  const repairs: Repair[] = []
  const add = (kind: RepairKind, entityId: Id, message: string): void => {
    repairs.push({ kind, entityId, message })
  }
  // Work on a private copy; hand back the original if nothing needed fixing.
  const d = structuredClone(doc) as HarnessDocument
  const draft = d as Draft<HarnessDocument>

  // ── 1. References to entities that do not exist ───────────────────────────
  const wireIds = new Set(d.wires.map((w) => w.id))

  d.wireRoutes = d.wireRoutes.filter((r) => {
    if (wireIds.has(r.wireId)) return true
    add('orphaned-route', r.wireId, `Dropped a route for wire ${r.wireId}, which does not exist`)
    return false
  })

  // R1 — a Cable is made of its cores: a core/drain that is gone must leave the
  // cable, and a cable with no cores left is no longer a cable unless a
  // surviving wire still points at it (dropping it would only trade one
  // dangling reference for another).
  for (const cab of d.cables) {
    const kept = cab.coreWireIds.filter((id) => wireIds.has(id))
    for (const id of cab.coreWireIds)
      if (!wireIds.has(id))
        add('dangling-cable-core', cab.id, `Cable ${cab.name}: removed core wire ${id}, which does not exist`)
    cab.coreWireIds = kept
    const drain = cab.shield?.drainWireId
    if (drain != null && !wireIds.has(drain)) {
      // Keep `present` — the shield is still physically there, it just lost its
      // drain, which is what `shield-without-drain` should report.
      delete cab.shield!.drainWireId
      add('dangling-cable-drain', cab.id, `Cable ${cab.name}: cleared shield drain ${drain}, which does not exist`)
    }
  }
  d.cables = d.cables.filter((cab) => {
    if (cab.coreWireIds.length > 0) return true
    if (
      d.wires.some(
        (w) => w.cableId === cab.id || w.ends.some((e) => e.type === 'shield' && e.cableId === cab.id)
      )
    )
      return true
    add('empty-cable', cab.id, `Removed cable ${cab.name}: it has no cores and nothing references it`)
    return false
  })
  const cableIds = new Set(d.cables.map((c) => c.id))

  d.twists = d.twists.filter((tw) => {
    const kept = tw.wireIds.filter((id) => wireIds.has(id))
    for (const id of tw.wireIds)
      if (!wireIds.has(id))
        add('dangling-twist-member', tw.id, `Twist ${tw.id}: removed member wire ${id}, which does not exist`)
    tw.wireIds = kept
    if (kept.length >= 2) return true
    add('twist-removed', tw.id, `Removed twist ${tw.id}: fewer than two members are left`)
    return false
  })

  d.sleeving = d.sleeving.filter((sl) => {
    const t = sl.target
    let missing: string | null = null
    if (t.type === 'wire' && !wireIds.has(t.wireId)) missing = `wire ${t.wireId}`
    else if (t.type === 'cable' && !cableIds.has(t.cableId)) missing = `cable ${t.cableId}`
    if (!missing) return true
    add('dangling-sleeving-target', sl.id, `Removed sleeving ${sl.id}: its target ${missing} does not exist`)
    return false
  })

  // ── 2. Labels: targets, then anchors (anchors re-derive FROM the target) ───
  d.labels = d.labels.filter((l) => {
    if (l.target.type !== 'wire' || wireIds.has(l.target.wireId)) return true
    add('dangling-label-target', l.id, `Removed label "${l.text}": its target wire ${l.target.wireId} does not exist`)
    return false
  })
  const labelsBefore = new Map(d.labels.map((l) => [l.id, l]))
  pruneDanglingBranchLabels(draft)
  const keptAfterBranchPrune = new Set(d.labels.map((l) => l.id))
  for (const [id, l] of labelsBefore) {
    if (keptAfterBranchPrune.has(id)) continue
    const what =
      l.target.type === 'branch'
        ? `segment ${l.target.segmentId}`
        : l.target.type === 'branchPoint'
          ? `branch point ${l.target.branchId}`
          : 'target'
    add('dangling-label-target', id, `Removed label "${l.text}": its target ${what} does not exist`)
  }

  const anchorsBefore = new Map(d.labels.map((l) => [l.id, anchorSig(l)]))
  reconcileLabelAnchors(draft)
  for (const l of d.labels) {
    if (anchorsBefore.get(l.id) === anchorSig(l)) continue
    add(
      'dangling-label-anchor',
      l.id,
      l.anchor
        ? `Label "${l.text}": moved its anchor onto segment ${l.anchor.segmentId} (the old one is gone)`
        : `Label "${l.text}": dropped its anchor (that segment is gone); it now uses its free position`
    )
  }

  // ── 3. Spans — ONLY those that actually lost a segment ────────────────────
  // healSpans trims to the largest contiguous run, which would also silently
  // "fix" a non-contiguous span of LIVE segments. That is a judgement call the
  // `non-contiguous-span` DRC rule owns, so scope the heal to damaged spans.
  const liveSegIds = new Set(d.segments.map((s) => s.id))
  const lostSegment = (sp: Span): boolean => sp.segmentIds.some((id) => !liveSegIds.has(id))
  const slDamaged = d.sleeving.filter((sl) => lostSegment(sl.span))
  const twDamaged = d.twists.filter((tw) => lostSegment(tw.span))
  if (slDamaged.length > 0 || twDamaged.length > 0) {
    const sigBefore = new Map<string, string>()
    for (const sl of slDamaged) sigBefore.set(`sl:${sl.id}`, spanSig(sl.span))
    for (const tw of twDamaged) sigBefore.set(`tw:${tw.id}`, spanSig(tw.span))
    // healSpans mutates the span objects in place and returns the survivors in
    // the collections it is handed — give it a view holding only the damaged
    // treatments, then splice its verdict back into the document.
    const view = { ...d, sleeving: slDamaged, twists: twDamaged } as Draft<HarnessDocument>
    healSpans(view)
    const survived = new Set<string>([
      ...view.sleeving.map((sl) => `sl:${sl.id}`),
      ...view.twists.map((tw) => `tw:${tw.id}`)
    ])
    const verdict = (key: string, id: Id, kind: string, span: Span): boolean => {
      if (!survived.has(key)) {
        add('empty-span-treatment', id, `Removed ${kind} ${id}: every segment its span covered is gone`)
        return false
      }
      if (spanSig(span) !== sigBefore.get(key))
        add('span-trimmed', id, `${kind} ${id}: trimmed its span onto the segments that still exist`)
      return true
    }
    const damagedSl = new Set(slDamaged.map((sl) => sl.id))
    const damagedTw = new Set(twDamaged.map((tw) => tw.id))
    d.sleeving = d.sleeving.filter(
      (sl) => !damagedSl.has(sl.id) || verdict(`sl:${sl.id}`, sl.id, 'Sleeving', sl.span)
    )
    d.twists = d.twists.filter(
      (tw) => !damagedTw.has(tw.id) || verdict(`tw:${tw.id}`, tw.id, 'Twist', tw.span)
    )
  }

  // ── 4. Bundles are derived — re-derive them, and report what moved ────────
  const bundlesBefore = new Map(d.bundles.map((b) => [b.id, bundleSig(b)]))
  const sleevingBeforeSync = new Map(d.sleeving.map((sl) => [sl.id, sl]))
  const labelsBeforeSync = new Map(d.labels.map((l) => [l.id, l]))
  syncBundles(draft)
  const bundlesAfter = new Map(d.bundles.map((b) => [b.id, bundleSig(b)]))
  for (const [id] of bundlesBefore)
    if (!bundlesAfter.has(id))
      add('bundle-resynced', id, `Removed bundle ${id}: no shared run of segments carries it any more`)
  for (const [id, sig] of bundlesAfter) {
    if (!bundlesBefore.has(id)) add('bundle-resynced', id, `Added bundle ${id}: its segments are shared by 2+ wires`)
    else if (bundlesBefore.get(id) !== sig)
      add('bundle-resynced', id, `Bundle ${id}: re-derived its segments/members from the routing`)
  }
  const liveSleeving = new Set(d.sleeving.map((sl) => sl.id))
  for (const [id, sl] of sleevingBeforeSync)
    if (!liveSleeving.has(id))
      add(
        'dangling-sleeving-target',
        id,
        `Removed sleeving ${id}: the bundle it covered (${sl.target.type === 'bundle' ? sl.target.bundleId : '?'}) no longer exists`
      )
  const liveLabels = new Set(d.labels.map((l) => l.id))
  for (const [id, l] of labelsBeforeSync)
    if (!liveLabels.has(id))
      add(
        'dangling-label-target',
        id,
        `Removed label "${l.text}": the bundle it named (${l.target.type === 'bundle' ? l.target.bundleId : '?'}) no longer exists`
      )

  return repairs.length === 0 ? { doc, repairs: [] } : { doc: d, repairs }
}
