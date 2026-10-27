import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Draft } from 'immer'
import type {
  HarnessDocument,
  Vec2,
  Id,
  Endpoint,
  Wire,
  Cable,
  Sleeving,
  SleevingType,
  Label,
  LabelTarget,
  LabelKind,
  PartRef,
  PictureView,
  SheetConfig,
  TitleBlock
} from '@shared/model/schema'
import { demoDocument, emptyDocument } from '@shared/model/document'
import { newId } from '@shared/model/ids'
import { DESIGNATOR_PREFIX, allDesignators, nextDesignator } from '@shared/model/designators'
import { defaultAnchor, isSpanContiguous } from '@shared/model/treatments'
import {
  applyInsertBranchPoint,
  applyRemoveBranchPoint,
  applyMergeBranchPoints,
  applyDisconnectWireAtBranch,
  syncBundles,
  reconcileLabelAnchors,
  pruneDanglingBranchLabels,
  healSpans,
  spansWithSegments
} from '@shared/model/routing'
import {
  applyRescaleSegment,
  checkRescaleSegment,
  type RescaleEnd,
  type RescaleResult
} from '@shared/model/rescale'
import { incidentSegments, isSelfLoopSegment } from '@shared/model/topology'
import { isValidLengthMm, routeNodeKey } from '@shared/model/geometry'
import { bodyKey, bodyNode, endpointBodyId } from '@shared/model/endpoints'
import type { Repair } from '@shared/model/reconcile'
// One definition of "identity view" for the loader, the store and the renderer.
import { isIdentityView, normaliseView } from '@shared/print/picture'
import { framedSheetOrigin } from '@shared/print/board'
import { computeFormboard } from '@shared/model/formboard'
import { instantiateCable, instantiateConnector, instantiateFreeTerminal, instantiateSplice } from '@shared/parts/instantiate'
import type { LibraryPart } from '@shared/parts/librarySchema'
import type { PartCatalog } from '@shared/parts/catalog'

const HISTORY_LIMIT = 200

/** What one canvas pane shows. Widened with 'parts' | 'connections' in a later branch. */
export type PaneView = 'schematic' | 'formboard'

/**
 * Which drawing block a pin/clear targets — a pinout table (a connector's OR a free
 * terminal's), the BOM block, or a body's part picture.
 */
export type BlockKind = 'pinout' | 'bom' | 'picture'
/**
 * A pinned drawing-block position. For `'pinout'` and `'picture'`, `id` is
 * required. A pinout's id is the CONNECTOR OR FREE-TERMINAL id —
 * `connectorPinouts` emits a pinout table for every free terminal that carries
 * wires (a ring lug on a battery stud gets one exactly like a connector does),
 * so both kinds of table are draggable. A picture's id is any drawn BODY, which
 * adds splices: a splice is a dot on the formboard and its part can have a
 * photo, though it never has a pinout table.
 */
export interface BlockMove {
  kind: BlockKind
  id?: Id
  pos: Vec2
}

/**
 * What a load hands the store besides the document itself: the repairs
 * `reconcileDocument` made, the loader-level migrations `parseDocument` applied
 * to the file's own shape, and the document as it actually sits ON DISK.
 * Passing `onDiskDoc` is what makes a repaired load start out dirty — `dirty`
 * stays a pure reference comparison against the last-saved state.
 */
export interface LoadInfo {
  repairs: Repair[]
  /**
   * `parseDocumentWithNotes` migration notes — an older file's shape brought
   * forward (legacy `sheets[]`, free-form `titleBlock`) or an invalid value
   * reset. About the FILE's shape; `repairs` is about references between
   * entities.
   */
  migrated: string[]
  /** The parsed-but-unrepaired document. Omit when nothing was repaired. */
  onDiskDoc?: HarnessDocument
}

/** `setDocument`'s options. */
export interface SetDocumentOpts {
  /**
   * Pin a missing `drawing.sheetOrigin` (default true — every app load). The
   * headless CLI passes `false`: it never writes the origin (spec §1), so a
   * CLI-built file keeps the framed sheet until the app first opens it.
   */
  pinSheetOrigin?: boolean
}

/** Load-migration note for a document whose sheet origin the app just pinned. */
export const SHEET_ORIGIN_PINNED_NOTE = 'drawing.sheetOrigin pinned at the current drawing'

/**
 * `doc` with `drawing.sheetOrigin` set to the origin that frames its harness
 * today — the place the planner would put the sheet while the field is absent
 * — so from then on the sheet stays put whatever is dragged (spec §1). Returns
 * `doc` itself when it already has one. Never mutates `doc`.
 */
export function withPinnedSheetOrigin(doc: HarnessDocument): HarnessDocument {
  if (doc.drawing.sheetOrigin) return doc
  return { ...doc, drawing: { ...doc.drawing, sheetOrigin: framedSheetOrigin(computeFormboard(doc)) } }
}

/**
 * Centralized document store with undo/redo.
 *
 * History is snapshot-based: `past`/`future` hold whole-document references.
 * This is cheap because every edit goes through Immer, so an old document
 * shares all unchanged substructure with the new one — a snapshot is a pointer,
 * not a deep copy.
 *
 * Two ways to change the document:
 *   - `applyEdit(recipe)` — ONE atomic, undoable discrete edit. This is the
 *     canonical command (the spec's "single atomic undoable command").
 *   - `commitNodePositions()` / `commitLabelPositions()` — called ONCE on
 *     drag-stop to fold a continuous gesture into ONE undo step. React Flow owns
 *     the live drag; these commit the final positions (and push nothing at all
 *     if nothing actually moved, e.g. a click).
 *
 * Geometry edits touch ONLY placements — never the electrical model — per the
 * two-layer rule. `dirty` is derived by reference-comparing the present doc to
 * the last-saved snapshot, so undoing back to the saved state clears dirty.
 */
export interface HarnessState {
  doc: HarnessDocument
  filePath: string | null
  dirty: boolean
  past: HarnessDocument[]
  future: HarnessDocument[]
  /** Reference to the document state that matches what's on disk. */
  savedDoc: HarnessDocument
  /**
   * Repairs `reconcileDocument` made to the document that was just loaded —
   * empty for a clean file. Surfaced as `repaired-on-load` info findings in the
   * DRC panel plus a dismissible notice in the toolbar. Cleared by a save, a
   * new/loaded document, or `dismissLoadRepairs`.
   */
  loadRepairs: Repair[]
  /**
   * Migration notes from the loader for the document that was just loaded —
   * empty for a current, clean file. Surfaced next to `loadRepairs`: as
   * `migrated-on-load` info findings in the DRC panel and in the same
   * dismissible toolbar notice. Cleared by the same three things.
   */
  loadMigrations: string[]

  setDocument: (doc: HarnessDocument, path: string | null, load?: LoadInfo, opts?: SetDocumentOpts) => void
  newDocument: () => void
  markSaved: (path: string) => void
  dismissLoadRepairs: () => void

  applyEdit: (recipe: (doc: Draft<HarnessDocument>) => void) => void

  /**
   * Commit final node positions after a drag gesture, as ONE undoable edit.
   * React Flow owns the live drag; this is called once on drag-stop. A no-op
   * (positions unchanged, e.g. a click) produces no history entry.
   * `target` selects which layout layer receives the positions:
   *   - 'physical'  → writes `Placement.pos` and `BranchPoint.pos` (formboard/routing layer)
   *   - 'schematic' → writes `Placement.schematicPos` (schematic diagram layer), leaving `pos` alone
   */
  commitNodePositions: (moves: { refId: Id; pos: Vec2 }[], target: 'schematic' | 'physical') => void

  /**
   * Commit label positions after a drag gesture, as ONE undoable edit (writes
   * `Label.pos`, the physical/formboard mm position). No-op (no history entry) if
   * nothing actually moved.
   */
  commitLabelPositions: (moves: { id: Id; pos: Vec2 }[]) => void

  /**
   * Commit anchored-label slides after a drag, as ONE undoable edit (writes
   * `Label.anchor.fraction` — the position ALONG the segment line). Only labels
   * that currently have an anchor are touched. No-op (no history) if nothing moved.
   */
  commitLabelAnchors: (moves: { id: Id; fraction: number }[]) => void

  /** What one canvas pane shows. Widened with 'parts' | 'connections' in a later branch. */
  panes: { split: boolean; left: PaneView; right: PaneView }
  setPaneView: (side: 'left' | 'right', view: PaneView) => void
  setSplit: (split: boolean) => void

  /**
   * Canvas dot grid — a VIEW preference, not document data: not persisted,
   * not on the undo stack, never printed. `gridMm` is the dot pitch in model
   * mm (1 flow unit = 1 mm).
   */
  gridVisible: boolean
  gridMm: number
  setGridVisible: (v: boolean) => void
  setGridMm: (mm: number) => void

  /** Create a wire between two endpoints (undoable). Returns the new wire id. */
  addWire: (a: Endpoint, b: Endpoint) => Id
  /**
   * Instantiate a library cable record as a Cable plus one core Wire per entry
   * (gauge/colour from the record, `cableId` set) and, optionally, the drain
   * wire from the cable's shield endpoint. ONE undoable edit. Returns the cable
   * id, or null (no history entry) on a refused request: not a cable record, no
   * cores, blank name, unknown or repeated core name, a core named `drain` alongside a
   * requested drain, or a drain on a record with no shield block (`shield.drain`
   * only says the record has a dedicated drain strand — it sets the drain's
   * gauge/colour defaults, nothing else).
   */
  addCableFromPart: (
    part: LibraryPart,
    name: string,
    cores: { core: string; a: Endpoint; b: Endpoint }[],
    drain?: { end: 'a' | 'b'; to: Endpoint }
  ) => Id | null
  /** Remove a wire and any route referencing it (undoable). Shorthand for `removeWires([id])`. */
  removeWire: (id: Id) => void
  /**
   * Remove any number of wires as ONE atomic undoable edit (B5: a batch delete
   * gesture — e.g. multi-select delete — is one undo entry, not N). No-op (no
   * history entry) if none of the ids reference an existing wire.
   */
  removeWires: (ids: Id[]) => void
  /**
   * The schematic Delete/Backspace gesture: remove placed bodies (connectors,
   * free terminals, splices) together with any explicitly selected wires, as
   * ONE atomic undoable edit. A body takes every wire ending on it (a wire
   * cannot have a dangling end) plus its placement and its pinned drawing
   * blocks; the wire removal runs the same cascade as `removeWires`. No-op (no
   * history entry) when none of the ids exist.
   */
  removeElements: (sel: { bodyIds: Id[]; wireIds: Id[] }) => void
  /** Insert a branch point on an existing segment (undoable). Returns the new branch id, or null if the segment doesn't exist. */
  insertBranchPoint: (segmentId: Id, pos: Vec2) => Id | null
  /**
   * Remove a degree-2 branch point by merging its two incident segments into one
   * (undoable). Returns true if the branch was removed, false if the branch is not
   * exactly degree-2 (Y-splits and degree-<2 branches are no-ops and do NOT push a
   * history entry). Shorthand for `removeBranchPoints([branchId]) === 1`.
   */
  removeBranchPoint: (branchId: Id) => boolean
  /**
   * Remove any number of degree-2 branch points as ONE atomic undoable edit
   * (B5). Each id is re-checked against the evolving draft as the batch is
   * applied, so a branch whose degree changed earlier in the same batch (e.g.
   * a neighbour's removal merged it into a Y-split) safely no-ops for that id.
   * Returns the number actually removed (duplicate input ids count once). No
   * history entry if none of the ids are feasible (degree-2) up front.
   */
  removeBranchPoints: (branchIds: Id[]) => number

  /**
   * Commit an entire drag/gesture — node moves, free-label moves,
   * anchored-label slides, and drawing-block moves — as ONE atomic undoable
   * edit (B5). Combines the bodies of `commitNodePositions` +
   * `commitLabelPositions` + `commitLabelAnchors` + `setBlockPos`: the
   * gesture is a no-op (no history entry) only if ALL parts are no-ops by
   * their own changed-detection rules. `blockMoves` lets a drag that moves a
   * connector AND its pinned pinout/BOM table commit as one history entry.
   */
  commitGesture: (g: {
    nodeMoves: { refId: Id; pos: Vec2 }[]
    target: 'physical' | 'schematic'
    labelMoves: { id: Id; pos: Vec2 }[]
    anchorMoves: { id: Id; fraction: number }[]
    blockMoves?: BlockMove[]
  }) => void

  /**
   * Merge branch point `srcId` into `dstId` (the formboard "collapse two bundle
   * branch points into one" gesture), as one atomic undoable edit. Parallel
   * limbs between fused points coalesce into a shared bundle segment and the
   * Bundle entities are re-synced. No-op (no history) when `srcId === dstId` or
   * either branch point is absent. Returns true if it merged.
   */
  mergeBranchPoints: (srcId: Id, dstId: Id) => boolean

  /**
   * Disconnect one wire from a bundle AT a specific branch point (the formboard
   * "break out here" gesture), as one atomic undoable edit: the wire bypasses
   * only that point — the two route segments meeting there are spliced into one
   * direct segment — keeping the rest of its route (and any other bundle limbs).
   * Orphaned segments/branch points are GC'd and the bundles re-synced (a bundle
   * falling below two wires dissolves and drops its sleeve/label). No-op (no
   * history) when the wire or branch point isn't an interior point of its route.
   * Returns true if it disconnected.
   */
  disconnectWireAtBranch: (wireId: Id, branchId: Id) => boolean

  /**
   * Create a new electrical entity AND its placement in one atomic undoable
   * edit, at (near) `pos`. Each returns the new entity's id so the caller can
   * select it. A small cascade offset keeps repeated adds from stacking exactly.
   */
  addConnector: (pos: Vec2) => Id
  addFreeTerminal: (pos: Vec2) => Id
  addSplice: (pos: Vec2) => Id

  /**
   * Same contract as `addConnector`/`addFreeTerminal`/`addSplice` — one new
   * electrical entity plus its placement, in ONE atomic undoable edit — but
   * seeded from a library `LibraryPart` (`instantiate.ts`) instead of a bare
   * default. `resolve` looks up a cavity's default pin/seal part number in the
   * library so its `PartRef` carries a real description/manufacturer.
   */
  addConnectorFromPart: (pos: Vec2, part: LibraryPart, resolve: (pn: string) => LibraryPart | undefined) => Id
  addFreeTerminalFromPart: (pos: Vec2, part: LibraryPart) => Id
  addSpliceFromPart: (pos: Vec2, part: LibraryPart) => Id

  /**
   * Replace an existing connector's housing/gender/cavities with the template
   * from `part` (re-running `instantiateConnector` against its current
   * designator). Refused — returns false, no history entry — when any cavity
   * currently on the connector is referenced by a wire end, since swapping the
   * cavity set out from under live connectivity would orphan those wire ends.
   * Also refused (false, no-op) for an unknown `connectorId`.
   */
  applyCavityTemplate: (connectorId: Id, part: LibraryPart, resolve: (pn: string) => LibraryPart | undefined) => boolean

  /**
   * Re-resolve every `PartRef` in the document against `catalog` and rewrite
   * `description`/`manufacturer` where the catalog now disagrees with the
   * cached values (a stale display cache after the library file changed).
   * Refs whose part number the catalog doesn't know are left untouched. ONE
   * atomic undoable edit when anything changes; a no-op (no history entry)
   * when nothing does. Returns the count of refs rewritten.
   */
  refreshPartRefs: (catalog: PartCatalog) => number

  /**
   * Add a sleeving treatment over a span of segments (undoable). Returns the new
   * id, or NULL when `segmentIds` is not one contiguous chain in the routing
   * graph (R2) — a rejected span is a no-op that pushes NO history entry. The
   * empty span is accepted (a treatment authored before its run exists).
   */
  addSleeving: (
    target: Sleeving['target'],
    segmentIds: Id[],
    sleevingType?: SleevingType
  ) => Id | null
  /**
   * Add a twist treatment over a set of wires/segments (undoable). Returns the
   * new id, or NULL when `segmentIds` is not one contiguous chain (R2) — same
   * reject-and-push-nothing rule as `addSleeving`.
   */
  addTwist: (wireIds: Id[], segmentIds: Id[]) => Id | null
  /** Add a label anchored to a target (undoable). Returns new id. */
  addLabel: (target: LabelTarget, kind: LabelKind, text: string, pos: Vec2) => Id

  /** Remove a sleeving/twist/label (undoable). No-op (no history) if absent. */
  removeSleeving: (id: Id) => void
  removeTwist: (id: Id) => void
  removeLabel: (id: Id) => void

  /**
   * Set the SCHEMATIC pin exit side for a connector's placement
   * (`Placement.schematicExitSide`). The formboard has no exit side — a body is
   * one dot there (schema 0.4.0). Updates (or creates) the placement for the
   * connector with `refId === connectorId`. One atomic undoable edit.
   */
  setExitSide: (connectorId: Id, side: 'left' | 'right' | 'top' | 'bottom') => void

  /**
   * Mirror a connector's schematic symbol top↔bottom (`true`: last pin on top)
   * or restore natural order (`false`, which removes the key — absent IS
   * natural). Schematic view state only; one undoable edit, and a no-op with no
   * history entry when the flag already has that value.
   */
  setPinOrderReversed: (connectorId: Id, reversed: boolean) => void

  /**
   * Set (or clear, with `undefined`) the loom-tape part on a bundle — the
   * consumable wrapped over the bundle's run, which becomes one length-based
   * BOM line. One atomic undoable edit; a missing bundle id is a no-op that
   * pushes NO history entry.
   */
  setBundlePart: (bundleId: Id, part: PartRef | undefined) => void

  /**
   * Set the document's default drawing sheet (`doc.drawing.sheet`) — e.g. from
   * the export dialog's "remember" checkbox. One atomic undoable edit; a no-op
   * (no history entry) if the sheet is already equal.
   */
  setSheet: (sheet: SheetConfig) => void

  /**
   * Shallow-merge a patch into the document's title block (`doc.drawing.titleBlock`).
   * Approval fields (`drawnBy`, `engApproved`, `mfgApproved`, `qa`) are replaced
   * whole, not merged — the caller passes the full `{ ...cur, name }`-style
   * object it wants stored. One atomic undoable edit; a no-op (no history
   * entry) if the merged result deep-equals the current block.
   */
  setTitleBlock: (patch: Partial<TitleBlock>) => void

  /**
   * Pin a drawing block's top-left (`doc.drawing.blocks`) — a pinout table for
   * a connector or a free terminal (`kind: 'pinout'`, `id` required) or the BOM
   * summary block (`kind: 'bom'`). One atomic undoable edit; a no-op (no history
   * entry) if the position is already stored, or (for `'pinout'`) `id` is missing
   * or references neither a connector nor a free terminal.
   */
  setBlockPos: (move: BlockMove) => void
  /**
   * Clear a pinned drawing-block position, reverting it to auto-placed.
   * `id` is required for `'pinout'`. One atomic undoable edit; a no-op (no
   * history entry) if nothing is currently pinned there. Removes now-empty
   * containers, so a document with no pins ends up with
   * `drawing.blocks === undefined`.
   */
  clearBlockPos: (kind: BlockKind, id?: Id) => void

  /**
   * Merge a patch into how THIS document shows a body's part picture
   * (`doc.drawing.blocks.pictureView`) — rotation and mirroring, keyed by body
   * id (connector, free terminal or splice). The library photo is untouched, so
   * another document showing the same part is unaffected.
   *
   * One atomic undoable edit. A no-op (no history entry) when `bodyId` is no
   * drawn body or the merged, NORMALISED view equals the stored one — so
   * `{rotationDeg: 450}` on a picture already at 90° writes nothing. The
   * identity view is stored as ABSENT: reaching it deletes the entry, and the
   * now-empty `pictureView` map and `blocks` object with it.
   */
  setPictureView: (bodyId: Id, patch: Partial<PictureView>) => void
  /** Turn a body's picture by `deltaDeg` clockwise from wherever it is now. */
  rotatePicture: (bodyId: Id, deltaDeg: number) => void
  /** Toggle a body's picture mirroring about the vertical (`'h'`) or horizontal (`'v'`) axis. */
  flipPicture: (bodyId: Id, axis: 'h' | 'v') => void

  /**
   * Set (or clear, with `undefined`) `Wire.specifiedLengthMm` — the manual
   * cut-length override for slack / service loops.
   *
   * VALIDATING BOUNDARY: a value that is negative, NaN or non-finite is
   * REJECTED — the document is not touched and NO history entry is pushed —
   * and the action returns false. `0` is accepted: an explicit zero-length
   * override is a legal statement, distinct from `undefined` = derive from the
   * route. Also returns false (no history) for an unknown wire id. A write of
   * the value already stored succeeds but pushes no history entry.
   */
  setWireLengthOverride: (wireId: Id, mm: number | undefined) => boolean

  /**
   * Set (or clear) `Wire.addLengthMm` — the strip / termination / service-loop
   * allowance ADDED to the derived length. Same validation and same
   * return/no-op contract as `setWireLengthOverride`.
   */
  setWireAllowance: (wireId: Id, mm: number | undefined) => boolean

  /**
   * Set (or clear, with `null`) `Segment.specifiedLengthMm` — the typed cut
   * length of one limb, which wires sum instead of its drawn length.
   *
   * Returns false and pushes NO history entry for an unknown segment id, an
   * invalid value (negative, NaN, non-finite) or ZERO — unlike a wire override,
   * a zero-length limb is never a meaningful typed length — and for a write that
   * changes nothing (same value, or `null` on an untyped segment). `null`
   * DELETES the key; it is never stored as `undefined`. One history entry on success.
   */
  setSegmentLength: (segmentId: Id, mm: number | null) => boolean

  /**
   * Rescale a broken limb: move its `toward` end along the limb's own line by
   * `typed − drawn`, and everything on that side of the routing graph rigidly
   * with it (`applyRescaleSegment`). Dry-runs on the current doc first and pushes
   * ONE history entry only on `'ok'`; every refusal (`'loop'`, `'not-broken'`,
   * `'unresolved'`, `'no-segment'`) changes nothing and pushes no entry.
   */
  rescaleSegment: (segmentId: Id, toward: RescaleEnd) => RescaleResult

  undo: () => void
  redo: () => void
}

/**
 * Shared validating writer for the hand-entered mm overrides on a Wire
 * (`specifiedLengthMm`, `addLengthMm`).
 *
 * Rejects (returns false, writes nothing, pushes NO history entry) on an
 * unknown wire id or a value that is negative / NaN / non-finite. `undefined`
 * clears the field. `0` is accepted — see `isValidLengthMm`. A write of the
 * value already stored returns true but pushes no history entry, so re-committing
 * an unchanged panel field never pollutes undo.
 */
function setWireMm(
  get: () => HarnessState,
  wireId: Id,
  field: 'specifiedLengthMm' | 'addLengthMm',
  mm: number | undefined
): boolean {
  const wire = get().doc.wires.find((w) => w.id === wireId)
  if (!wire) return false
  if (mm !== undefined && !isValidLengthMm(mm)) return false
  if (wire[field] === mm) return true // no change → no history entry
  get().applyEdit((d) => {
    const w = d.wires.find((x) => x.id === wireId)
    if (!w) return
    if (mm === undefined) delete w[field]
    else w[field] = mm
  })
  return true
}

/** Offset a placement slightly per existing element so adds don't stack exactly. */
function cascade(pos: Vec2, count: number): Vec2 {
  const step = (count % 8) * 16
  return { x: pos.x + step, y: pos.y + step }
}

/**
 * The id of the segment joining bodies `ba` and `bb` — the existing one if the
 * limb is already drawn, otherwise a new segment pushed with id `newSegId`.
 *
 * **One limb = one segment.** Route nodes are body-keyed, so the unordered pair
 * `{n:ba, n:bb}` names a physical limb; every code path that creates a segment
 * between two bodies must go through here (or the equivalent coalescing in the
 * 0.3 → 0.4 load migration) or the drawing grows coincident duplicates.
 */
function existingOrNewSegment(
  d: Draft<HarnessDocument>,
  ba: Id,
  bb: Id,
  newSegId: Id
): Id {
  const ka = bodyKey(ba)
  const kb = bodyKey(bb)
  const existing = d.segments.find((sg) => {
    const f = routeNodeKey(sg.from)
    const t = routeNodeKey(sg.to)
    return (f === ka && t === kb) || (f === kb && t === ka)
  })
  if (existing) return existing.id
  d.segments.push({ id: newSegId, from: bodyNode(ba), to: bodyNode(bb) })
  return newSegId
}

/**
 * addWire's draft body, shared with addCableFromPart: push the wire, then
 * auto-route body → body so it has a length the moment it exists. A jumper
 * between two cavities of ONE body has no limb to draw: no segment, no route
 * (length stays 'unknown' until specified).
 *
 * ONE LIMB = ONE SEGMENT. Route nodes are body-keyed (schema 0.4.0), so a
 * second wire between the same two bodies runs down the SAME physical limb —
 * reuse the existing segment for this unordered node pair. The limb may now
 * carry 2+ wires — that IS a bundle, hence syncBundles.
 */
function addWireToDraft(d: Draft<HarnessDocument>, wire: Wire, segId: Id, route = true): void {
  d.wires.push(wire)
  if (!route) return
  const ba = endpointBodyId(d, wire.ends[0])
  const bb = endpointBodyId(d, wire.ends[1])
  if (ba && bb && ba !== bb) {
    d.wireRoutes.push({ wireId: wire.id, path: [existingOrNewSegment(d, ba, bb, segId)] })
    syncBundles(d)
  }
}

/**
 * The removeWire(s) recipe: per-wire prunes loop over `ids`, then the shared
 * tail (bundle resync → segment GC → branch-point GC → dangling-label prune →
 * anchor reconcile) runs ONCE for the whole batch. This is what lets
 * `removeWires` collapse an N-wire delete gesture into one atomic edit instead
 * of replaying the single-wire recipe N times (B5).
 */
/**
 * Every wire with an end on one of `bodyIds` (a connector's cavities, a free
 * terminal, a splice) — what removing those bodies takes with it. Shared by
 * `removeElements` and the panel's Remove tooltip so the count shown is the
 * count removed.
 */
export function wiresOnBodies(doc: HarnessDocument, bodyIds: Iterable<Id>): Id[] {
  const bodies = new Set(bodyIds)
  return doc.wires
    .filter((w) => w.ends.some((e) => bodies.has(endpointBodyId(doc, e) ?? '')))
    .map((w) => w.id)
}

function removeWiresFromDraft(d: Draft<HarnessDocument>, ids: Id[]): void {
  const hadSpanSegments = spansWithSegments(d) // snapshot for healSpans (R3/R4)
  for (const id of ids) {
    const i = d.wires.findIndex((w) => w.id === id)
    if (i >= 0) d.wires.splice(i, 1)
    // A wire's routing is layout, not electrical — drop ALL stale routes.
    // (addWire auto-creates one; tests may push extras; remove them all.)
    for (let r = d.wireRoutes.length - 1; r >= 0; r--) {
      if (d.wireRoutes[r].wireId === id) d.wireRoutes.splice(r, 1)
    }
    // Prune annotations that reference the gone wire, else the BOM/cut-list/SVG
    // gain phantom sleeving/twist/marker lines for a wire that no longer exists.
    d.sleeving = d.sleeving.filter(
      (sl) => !(sl.target.type === 'wire' && sl.target.wireId === id)
    )
    for (let t = d.twists.length - 1; t >= 0; t--) {
      const tw = d.twists[t]
      tw.wireIds = tw.wireIds.filter((w) => w !== id)
      if (tw.wireIds.length < 2) d.twists.splice(t, 1) // a twist needs 2+ members
    }
    d.labels = d.labels.filter((l) => !(l.target.type === 'wire' && l.target.wireId === id))
  }
  // R1 — a Cable is a part made of its cores: a removed core must leave the
  // cable, and a removed drain must leave the shield, or the Cable ends up
  // pointing at wires that no longer exist (BOM/cut list then silently
  // undercount, and `dangling-member` fires on every load).
  const removed = new Set(ids)
  for (const cab of d.cables) {
    cab.coreWireIds = cab.coreWireIds.filter((wid) => !removed.has(wid))
    if (cab.shield?.drainWireId != null && removed.has(cab.shield.drainWireId)) {
      // Keep `present` — the shield is still physically there, it just lost its
      // drain, which is exactly what `shield-without-drain` should report.
      delete cab.shield.drainWireId
    }
  }
  // A cable with no cores left is no longer a cable — unless a surviving wire
  // still points at it (`cableId`, or a shield endpoint), in which case dropping
  // it would only trade one dangling reference for another.
  d.cables = d.cables.filter((cab) => {
    if (cab.coreWireIds.length > 0) return true
    return d.wires.some(
      (w) =>
        w.cableId === cab.id || w.ends.some((e) => e.type === 'shield' && e.cableId === cab.id)
    )
  })
  // Re-sync bundle entities from the post-removal routing topology BEFORE
  // the segment GC, so a shared limb that just dropped to one wire stops
  // being a bundle. syncBundles also prunes any sleeve/label that targeted
  // a now-dissolved bundle, and the GC then sees corrected references.
  syncBundles(d)
  // GC: remove any segment that is no longer referenced by any remaining
  // wireRoute path or bundle segmentIds.
  // R4: sleeving/twist spans are NOT roots — a segment is a layout edge whose
  // existence follows the wires routed through it, so a treatment must never
  // keep a wire-less "ghost" segment alive. `healSpans` (below) trims the
  // treatments onto what survives instead.
  const referencedSegIds = new Set<Id>()
  for (const r of d.wireRoutes) for (const s of r.path) referencedSegIds.add(s)
  for (const b of d.bundles) for (const s of b.segmentIds) referencedSegIds.add(s)
  d.segments = d.segments.filter((seg) => referencedSegIds.has(seg.id))
  // Trim spans onto the surviving segments; a treatment this cascade emptied is
  // removed in the same (single) undo entry (R3/R4).
  healSpans(d, hadSpanSegments)
  // GC branch points no surviving segment touches (else: floating SVG dot,
  // spurious branchpoint-degree DRC error, and a still-BOMed tie part).
  const liveBranch = new Set<Id>()
  for (const seg of d.segments) {
    if (seg.from.type === 'branch') liveBranch.add(seg.from.branchId)
    if (seg.to.type === 'branch') liveBranch.add(seg.to.branchId)
  }
  d.branchPoints = d.branchPoints.filter((b) => liveBranch.has(b.id))
  // Drop labels whose branch/branch-point target was just GC'd — they
  // can't be healed (the target itself is gone, not just the anchor).
  pruneDanglingBranchLabels(d)
  // Heal anchors whose segment was just GC'd (re-derive from target, or drop
  // the anchor) so a label never points at a removed segment.
  reconcileLabelAnchors(d)
}

/**
 * Shared changed-detection + mutation bodies for node/label/anchor commits.
 * Factored out so `commitNodePositions`/`commitLabelPositions`/
 * `commitLabelAnchors` and the combined `commitGesture` (B5) apply IDENTICAL
 * no-op rules and mutations — no risk of the two drifting apart.
 */
function nodePositionsChanged(
  doc: HarnessDocument,
  moves: { refId: Id; pos: Vec2 }[],
  target: 'schematic' | 'physical'
): boolean {
  const { placements, branchPoints } = doc
  return moves.some((m) => {
    if (target === 'physical') {
      const p =
        branchPoints.find((b) => b.id === m.refId)?.pos ??
        placements.find((pp) => pp.refId === m.refId)?.pos
      return !p || p.x !== m.pos.x || p.y !== m.pos.y
    }
    // Schematic: treat an ABSENT schematicPos as always-changed so the first
    // schematic drag-stop always writes schematicPos, decoupling it from pos.
    const sp = placements.find((pp) => pp.refId === m.refId)?.schematicPos
    return !sp || sp.x !== m.pos.x || sp.y !== m.pos.y
  })
}

function applyNodePositions(
  d: Draft<HarnessDocument>,
  moves: { refId: Id; pos: Vec2 }[],
  target: 'schematic' | 'physical'
): void {
  for (const m of moves) {
    if (target === 'physical') {
      const bp = d.branchPoints.find((b) => b.id === m.refId)
      if (bp) {
        bp.pos = m.pos
        continue
      }
      const p = d.placements.find((pp) => pp.refId === m.refId)
      if (p) {
        // The schematic draws `schematicPos ?? pos`, so freeze it at the old
        // spot first or a formboard drag would move the body there too.
        if (!p.schematicPos) p.schematicPos = p.pos
        p.pos = m.pos
      } else d.placements.push({ refId: m.refId, pos: m.pos })
    } else {
      const p = d.placements.find((pp) => pp.refId === m.refId)
      if (p) p.schematicPos = m.pos
      else d.placements.push({ refId: m.refId, pos: m.pos, schematicPos: m.pos })
    }
  }
}

function labelPositionsChanged(doc: HarnessDocument, moves: { id: Id; pos: Vec2 }[]): boolean {
  const { labels } = doc
  return moves.some((m) => {
    const l = labels.find((x) => x.id === m.id)
    return l != null && (l.pos.x !== m.pos.x || l.pos.y !== m.pos.y)
  })
}

function applyLabelPositions(d: Draft<HarnessDocument>, moves: { id: Id; pos: Vec2 }[]): void {
  for (const m of moves) {
    const l = d.labels.find((x) => x.id === m.id)
    if (l) l.pos = m.pos
  }
}

function labelAnchorsChanged(doc: HarnessDocument, moves: { id: Id; fraction: number }[]): boolean {
  const { labels } = doc
  return moves.some((m) => {
    const l = labels.find((x) => x.id === m.id)
    return l != null && l.anchor != null && l.anchor.fraction !== m.fraction
  })
}

function applyLabelAnchors(d: Draft<HarnessDocument>, moves: { id: Id; fraction: number }[]): void {
  for (const m of moves) {
    const l = d.labels.find((x) => x.id === m.id)
    if (l && l.anchor) l.anchor.fraction = m.fraction
  }
}

/**
 * Moves that would actually change the stored pins: a keyed (`'pinout'` /
 * `'picture'`) move with no `id`, or an `id` no block of that kind can belong
 * to, is dropped (never written); the rest are dropped only when the position
 * already matches what's stored.
 *
 * Free terminals are in the pinout set because `connectorPinouts` gives every
 * wire-carrying free terminal its own pinout table, so the canvas emits a
 * draggable `tbl:<freeTerminalId>` node for it. Accepting connectors only made
 * that table snap silently back on drop. Pictures accept SPLICES on top of
 * that: every drawn body can own a part photo. `serialize.ts`'s load-time
 * validation uses the same two sets — they must agree, or a pin that drags
 * would not survive a save/load round trip.
 */
/** Every body that can own a part picture: connectors, free terminals, splices. */
function pictureBodyIds(doc: HarnessDocument): Set<Id> {
  return new Set([
    ...doc.connectors.map((c) => c.id),
    ...doc.freeTerminals.map((f) => f.id),
    ...doc.splices.map((sp) => sp.id)
  ])
}

/** The stored view for one body, normalised — `{}` when it draws unchanged. */
function currentPictureView(doc: HarnessDocument, bodyId: Id): PictureView {
  return normaliseView(doc.drawing.blocks?.pictureView?.[bodyId] ?? {})
}

function effectiveBlockMoves(doc: HarnessDocument, moves: BlockMove[]): BlockMove[] {
  const tableIds = new Set([...doc.connectors.map((c) => c.id), ...doc.freeTerminals.map((f) => f.id)])
  const pictureIds = pictureBodyIds(doc)
  return moves.filter((m) => {
    const blocks = doc.drawing.blocks
    if (m.kind === 'bom') return !posEq(blocks?.bom, m.pos)
    const ids = m.kind === 'picture' ? pictureIds : tableIds
    if (!m.id || !ids.has(m.id)) return false
    const cur = m.kind === 'picture' ? blocks?.picture?.[m.id] : blocks?.pinout?.[m.id]
    return !posEq(cur, m.pos)
  })
}

const posEq = (a: Vec2 | undefined, b: Vec2): boolean => !!a && a.x === b.x && a.y === b.y

function applyBlockMoves(d: Draft<HarnessDocument>, moves: BlockMove[]): void {
  for (const m of moves) {
    d.drawing.blocks ??= {}
    if (m.kind === 'bom') d.drawing.blocks.bom = { ...m.pos }
    else if (m.kind === 'picture') {
      d.drawing.blocks.picture ??= {}
      d.drawing.blocks.picture[m.id!] = { ...m.pos }
    } else {
      d.drawing.blocks.pinout ??= {}
      d.drawing.blocks.pinout[m.id!] = { ...m.pos }
    }
  }
}

// The demo gets an origin that frames it, like any new document (spec §1).
const initialDoc = withPinnedSheetOrigin(demoDocument())

export const useHarnessStore = create<HarnessState>()(
  immer((set, get) => ({
    doc: initialDoc,
    filePath: null,
    dirty: false,
    loadRepairs: [],
    loadMigrations: [],
    past: [],
    future: [],
    // The initial demo document is the "saved" baseline so the app starts
    // un-dirty and undoing back to it clears the dirty flag.
    savedDoc: initialDoc,
    panes: { split: false, left: 'schematic' as PaneView, right: 'formboard' as PaneView },
    setPaneView: (side, view) => set((st) => { st.panes[side] = view }),
    setSplit: (split) => set((st) => { st.panes.split = split }),
    gridVisible: true,
    gridMm: 20,
    setGridVisible: (v) => set((st) => { st.gridVisible = v }),
    // Clamp: a sub-mm pitch at 20x zoom is a solid wall of dots; 0 would hang
    // React Flow's pattern.
    setGridMm: (mm) => set((st) => { st.gridMm = Math.min(1000, Math.max(1, mm)) }),

    setDocument: (doc, path, load, opts) => {
      // A document with no sheet origin (pre-0.6, or CLI-built) gets the one
      // that frames it now, pinned so the sheet never chases the harness again.
      // Reported like any load migration; NOT an undoable edit.
      const pinned = opts?.pinSheetOrigin === false ? doc : withPinnedSheetOrigin(doc)
      set((state) => {
        // The baseline is what the FILE holds: the unrepaired document when a
        // load-time reconcile changed something, otherwise the document itself.
        // `dirty` then falls out of the usual reference compare, so a repaired
        // (or freshly pinned) file opens with the • marker and saving is known
        // to rewrite it.
        const baseline = load?.onDiskDoc ?? doc
        state.doc = pinned
        state.filePath = path
        state.past = []
        state.future = []
        state.savedDoc = baseline
        state.dirty = pinned !== baseline
        state.loadRepairs = load?.repairs ?? []
        state.loadMigrations = [...(load?.migrated ?? []), ...(pinned !== doc ? [SHEET_ORIGIN_PINNED_NOTE] : [])]
      })
    },

    newDocument: () => {
      const fresh = withPinnedSheetOrigin(emptyDocument())
      set((state) => {
        state.doc = fresh
        state.filePath = null
        state.dirty = false
        state.past = []
        state.future = []
        state.savedDoc = fresh
        state.loadRepairs = []
        state.loadMigrations = []
      })
    },

    markSaved: (path) =>
      set((state) => {
        state.filePath = path
        state.dirty = false
        state.savedDoc = state.doc
        state.loadRepairs = [] // the file now holds the repaired document
        state.loadMigrations = []
      }),

    dismissLoadRepairs: () =>
      set((state) => {
        state.loadRepairs = []
        state.loadMigrations = []
      }),

    applyEdit: (recipe) => {
      const prev = get().doc // frozen reference, safe to keep as a snapshot
      set((state) => {
        state.past.push(prev as HarnessDocument)
        if (state.past.length > HISTORY_LIMIT) state.past.shift()
        state.future = []
        recipe(state.doc)
        state.dirty = state.doc !== state.savedDoc
      })
    },

    commitNodePositions: (moves, target) => {
      if (!nodePositionsChanged(get().doc, moves, target)) return // no real movement (e.g. a click) → no history entry
      get().applyEdit((d) => applyNodePositions(d, moves, target))
    },

    commitLabelPositions: (moves) => {
      if (!labelPositionsChanged(get().doc, moves)) return
      get().applyEdit((d) => applyLabelPositions(d, moves))
    },

    commitLabelAnchors: (moves) => {
      if (!labelAnchorsChanged(get().doc, moves)) return
      get().applyEdit((d) => applyLabelAnchors(d, moves))
    },

    commitGesture: ({ nodeMoves, target, labelMoves, anchorMoves, blockMoves = [] }) => {
      const doc = get().doc
      const blocks = effectiveBlockMoves(doc, blockMoves)
      const changed =
        nodePositionsChanged(doc, nodeMoves, target) ||
        labelPositionsChanged(doc, labelMoves) ||
        labelAnchorsChanged(doc, anchorMoves) ||
        blocks.length > 0
      if (!changed) return // whole gesture was a no-op (e.g. a click) → no history entry
      get().applyEdit((d) => {
        applyNodePositions(d, nodeMoves, target)
        applyLabelPositions(d, labelMoves)
        applyLabelAnchors(d, anchorMoves)
        applyBlockMoves(d, blocks)
      })
    },

    addWire: (a, b) => {
      const id = newId()
      const segId = newId()
      get().applyEdit((d) => {
        // New wires get sensible defaults (0.5 mm², grey); the electrical model
        // is a multigraph, so duplicate/parallel wires between pins are allowed.
        addWireToDraft(
          d,
          { id, ends: [a, b], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } },
          segId
        )
      })
      return id
    },

    addCableFromPart: (part, name, cores, drain) => {
      const spec = part.kind === 'cable' ? part.cable : undefined
      if (!spec || !name.trim() || cores.length === 0) return null
      const used = new Set<string>()
      for (const c of cores) {
        if (used.has(c.core) || !spec.cores.some((k) => k.name === c.core)) return null
        used.add(c.core)
      }
      if (drain && !spec.shield) return null
      if (drain && used.has('drain')) return null
      const coreIds = cores.map(() => newId())
      const drainId = drain ? newId() : undefined
      const cable: Cable = {
        id: newId(),
        ...instantiateCable(part, name.trim()),
        coreWireIds: coreIds
      }
      const pairs = cores.map((c) => spec.cores.find((k) => k.name === c.core)!.pair).filter(Boolean)
      if (new Set(pairs).size < pairs.length) cable.twistedPair = true
      if (drainId) cable.shield = { present: true, drainWireId: drainId }
      get().applyEdit((d) => {
        d.cables.push(cable)
        cores.forEach((c, i) => {
          const k = spec.cores.find((x) => x.name === c.core)!
          addWireToDraft(
            d,
            {
              id: coreIds[i],
              ends: [c.a, c.b],
              gauge: { ...k.gauge },
              color: k.stripes?.length ? { base: k.color, stripes: [...k.stripes] } : { base: k.color },
              cableId: cable.id,
              coreName: k.name,
              ...(k.pair ? { corePair: k.pair } : {})
            },
            newId()
          )
        })
        if (drain && drainId) {
          const dk = spec.cores.find((x) => x.name === 'drain')
          const shield: Endpoint = { type: 'shield', cableId: cable.id, end: drain.end }
          // No store/UI path places a cable today (a Placement may reference
          // one), so its shield end lands on no placed body: no limb, no route.
          // The unrouted-wire DRC rule exempts this wire; its length comes
          // with the cable.
          addWireToDraft(
            d,
            {
              id: drainId,
              ends: drain.end === 'a' ? [shield, drain.to] : [drain.to, shield],
              gauge: dk ? { ...dk.gauge } : { value: 0.5, unit: 'mm2' },
              color: dk ? { base: dk.color } : { base: 'BK' },
              cableId: cable.id
            },
            newId(),
            false
          )
        }
      })
      return cable.id
    },

    removeWire: (id) => get().removeWires([id]),

    removeWires: (ids) => {
      const existing = new Set(get().doc.wires.map((w) => w.id))
      if (!ids.some((id) => existing.has(id))) return // no-op → no history entry
      get().applyEdit((d) => removeWiresFromDraft(d, ids))
    },

    removeElements: ({ bodyIds, wireIds }) => {
      const { doc } = get()
      const bodies = new Set(
        [...doc.connectors, ...doc.freeTerminals, ...doc.splices]
          .map((b) => b.id)
          .filter((id) => bodyIds.includes(id))
      )
      const wires = new Set(wireIds.filter((id) => doc.wires.some((w) => w.id === id)))
      for (const id of wiresOnBodies(doc, bodies)) wires.add(id)
      if (bodies.size === 0 && wires.size === 0) return // no-op → no history entry
      get().applyEdit((d) => {
        if (wires.size) removeWiresFromDraft(d, [...wires])
        d.connectors = d.connectors.filter((c) => !bodies.has(c.id))
        d.freeTerminals = d.freeTerminals.filter((f) => !bodies.has(f.id))
        d.splices = d.splices.filter((x) => !bodies.has(x.id))
        d.placements = d.placements.filter((p) => !bodies.has(p.refId))
        const blocks = d.drawing.blocks
        if (blocks) {
          for (const id of bodies) {
            if (blocks.pinout) delete blocks.pinout[id]
            if (blocks.picture) delete blocks.picture[id]
            if (blocks.pictureView) delete blocks.pictureView[id]
          }
        }
      })
    },

    addConnector: (pos) => {
      const id = newId()
      get().applyEdit((d) => {
        d.connectors.push({
          id,
          designator: nextDesignator(DESIGNATOR_PREFIX.connector, allDesignators(d)),
          cavities: [{ id: newId(), position: '1', status: 'populated' }]
        })
        d.placements.push({ refId: id, pos: cascade(pos, d.placements.length) })
      })
      return id
    },

    addFreeTerminal: (pos) => {
      const id = newId()
      get().applyEdit((d) => {
        d.freeTerminals.push({
          id,
          designator: nextDesignator(DESIGNATOR_PREFIX.terminal, allDesignators(d)),
          kind: 'ring'
        })
        d.placements.push({ refId: id, pos: cascade(pos, d.placements.length) })
      })
      return id
    },

    addSplice: (pos) => {
      const id = newId()
      get().applyEdit((d) => {
        d.splices.push({
          id,
          designator: nextDesignator(DESIGNATOR_PREFIX.splice, allDesignators(d)),
          kind: 'butt'
        })
        d.placements.push({ refId: id, pos: cascade(pos, d.placements.length) })
      })
      return id
    },

    addConnectorFromPart: (pos, part, resolve) => {
      const id = newId()
      get().applyEdit((d) => {
        const designator = nextDesignator(DESIGNATOR_PREFIX.connector, allDesignators(d))
        d.connectors.push({ id, ...instantiateConnector(part, designator, resolve, newId) })
        d.placements.push({ refId: id, pos: cascade(pos, d.placements.length) })
      })
      return id
    },

    addFreeTerminalFromPart: (pos, part) => {
      const id = newId()
      get().applyEdit((d) => {
        d.freeTerminals.push({
          id,
          designator: nextDesignator(DESIGNATOR_PREFIX.terminal, allDesignators(d)),
          ...instantiateFreeTerminal(part)
        })
        d.placements.push({ refId: id, pos: cascade(pos, d.placements.length) })
      })
      return id
    },

    addSpliceFromPart: (pos, part) => {
      const id = newId()
      get().applyEdit((d) => {
        d.splices.push({
          id,
          designator: nextDesignator(DESIGNATOR_PREFIX.splice, allDesignators(d)),
          ...instantiateSplice(part)
        })
        d.placements.push({ refId: id, pos: cascade(pos, d.placements.length) })
      })
      return id
    },

    // Cavities carry wires (Endpoint.cavityId), so a template is applied only
    // when NO cavity of this connector is referenced by any wire. Refusal is a
    // clean no-op: no history entry.
    applyCavityTemplate: (connectorId, part, resolve) => {
      const doc = get().doc
      const conn = doc.connectors.find((c) => c.id === connectorId)
      if (!conn) return false
      const cavIds = new Set(conn.cavities.map((c) => c.id))
      if (doc.wires.some((w) => w.ends.some((e) => e.type === 'cavity' && cavIds.has(e.cavityId)))) return false
      const inst = instantiateConnector(part, conn.designator, resolve, newId)
      get().applyEdit((d) => {
        const c = d.connectors.find((x) => x.id === connectorId)
        if (!c) return
        c.housing = inst.housing
        c.cavities = inst.cavities
        if (inst.gender) c.gender = inst.gender
        else delete c.gender
      })
      return true
    },

    refreshPartRefs: (catalog) => {
      let n = 0
      const fix = (ref: PartRef | undefined): void => {
        if (!ref) return
        const e = catalog.resolve(ref.partNumber)
        if (!e) return
        const want: PartRef = { partNumber: ref.partNumber, description: e.description }
        if (e.manufacturer) want.manufacturer = e.manufacturer
        if (ref.description === want.description && ref.manufacturer === want.manufacturer) return
        ref.description = want.description
        if (want.manufacturer) ref.manufacturer = want.manufacturer
        else delete ref.manufacturer
        n++
      }
      const visit = (d: HarnessDocument): void => {
        for (const c of d.connectors) { fix(c.housing); for (const cv of c.cavities) { fix(cv.pin); fix(cv.seal); fix(cv.plug) } }
        for (const t of d.freeTerminals) { fix(t.part); fix(t.seal) }
        for (const sp of d.splices) fix(sp.part)
        for (const w of d.wires) fix(w.spec)
        for (const cb of d.cables) fix(cb.part)
        for (const b of d.bundles) fix(b.part)
        for (const sl of d.sleeving) fix(sl.part)
        for (const bp of d.branchPoints) fix(bp.tie)
      }
      // Dry run on a structural clone to know whether anything changes BEFORE
      // touching history (a no-op edit must not push an entry).
      visit(structuredClone(get().doc))
      if (n === 0) return 0
      n = 0
      get().applyEdit((d) => visit(d as HarnessDocument))
      return n
    },

    addSleeving: (target, segmentIds, sleevingType = 'braided') => {
      // R2: a Span must be ONE contiguous run — spanLengthMm's head/tail
      // trimming and applyInsertBranchPoint's fraction remap both assume it.
      // Reject before touching history so a bad selection is a clean no-op.
      if (!isSpanContiguous(get().doc, segmentIds)) return null
      const id = newId()
      get().applyEdit((d) => {
        d.sleeving.push({
          id,
          target,
          span: { segmentIds },
          sleevingType
        })
      })
      return id
    },

    addTwist: (wireIds, segmentIds) => {
      if (!isSpanContiguous(get().doc, segmentIds)) return null // R2, as addSleeving
      const id = newId()
      get().applyEdit((d) => {
        d.twists.push({
          id,
          wireIds,
          span: { segmentIds }
        })
      })
      return id
    },

    addLabel: (target, kind, text, pos) => {
      const id = newId()
      get().applyEdit((d) => {
        // Anchor the label to a segment of its target so it rides the loom; a
        // branchPoint target (or an unrouted one) yields no anchor → free `pos`.
        const anchor = defaultAnchor(d, target) ?? undefined
        d.labels.push({ id, target, kind, text, pos, ...(anchor ? { anchor } : {}) })
      })
      return id
    },

    removeSleeving: (id) => {
      if (!get().doc.sleeving.some((x) => x.id === id)) return
      get().applyEdit((d) => {
        d.sleeving = d.sleeving.filter((x) => x.id !== id)
      })
    },

    removeTwist: (id) => {
      if (!get().doc.twists.some((x) => x.id === id)) return
      get().applyEdit((d) => {
        d.twists = d.twists.filter((x) => x.id !== id)
      })
    },

    removeLabel: (id) => {
      if (!get().doc.labels.some((x) => x.id === id)) return
      get().applyEdit((d) => {
        d.labels = d.labels.filter((x) => x.id !== id)
      })
    },

    insertBranchPoint: (segmentId, pos) => {
      // Pre-check so a stale/bogus segment id pushes no empty undo entry.
      if (!get().doc.segments.some((s) => s.id === segmentId)) return null
      const branchId = newId()
      get().applyEdit((d) => {
        applyInsertBranchPoint(d, segmentId, pos, {
          branchId,
          segAId: newId(),
          segBId: newId()
        })
      })
      return branchId
    },

    removeBranchPoint: (branchId) => get().removeBranchPoints([branchId]) === 1,

    removeBranchPoints: (branchIds) => {
      // Peek incident-segment counts before touching history — same counting
      // as the single-id action. Only push an undo entry if at least one id
      // will actually do something.
      const peek = get().doc
      const feasible = branchIds.filter((bid) => {
        const inc = incidentSegments(peek, bid)
        // Same self-loop-safe degree the apply-op uses (see model/topology.ts).
        return inc.length === 2 && !inc.some(isSelfLoopSegment)
      })
      if (feasible.length === 0) return 0
      let removed = 0
      get().applyEdit((d) => {
        // applyRemoveBranchPoint re-checks degree against the evolving draft
        // internally, so a bend whose neighbourhood changed earlier in this
        // same batch (e.g. merged into a Y-split by a prior removal) safely
        // no-ops for its own id instead of corrupting the topology.
        for (const bid of feasible) {
          if (applyRemoveBranchPoint(d, bid, { mergedSegId: newId() })) removed++
        }
      })
      return removed
    },

    mergeBranchPoints: (srcId, dstId) => {
      if (srcId === dstId) return false
      const { branchPoints } = get().doc
      if (!branchPoints.some((b) => b.id === srcId)) return false
      if (!branchPoints.some((b) => b.id === dstId)) return false
      get().applyEdit((d) => {
        applyMergeBranchPoints(d, srcId, dstId)
      })
      return true
    },

    disconnectWireAtBranch: (wireId, branchId) => {
      const route = get().doc.wireRoutes.find((r) => r.wireId === wireId)
      if (!route) return false
      // Feasible only if two consecutive route segments meet at this branch point.
      const segById = new Map(get().doc.segments.map((s) => [s.id, s]))
      const touchesB = (segId: Id): boolean => {
        const s = segById.get(segId)
        return (
          !!s &&
          ((s.from.type === 'branch' && s.from.branchId === branchId) ||
            (s.to.type === 'branch' && s.to.branchId === branchId))
        )
      }
      let feasible = false
      for (let i = 0; i + 1 < route.path.length; i++) {
        if (touchesB(route.path[i]) && touchesB(route.path[i + 1])) {
          feasible = true
          break
        }
      }
      if (!feasible) return false
      get().applyEdit((d) => {
        applyDisconnectWireAtBranch(d, wireId, branchId, newId())
      })
      return true
    },

    setExitSide: (connectorId, side) =>
      get().applyEdit((d) => {
        const p = d.placements.find((pp) => pp.refId === connectorId)
        if (p) p.schematicExitSide = side
        else d.placements.push({ refId: connectorId, pos: { x: 0, y: 0 }, schematicExitSide: side })
      }),

    setPinOrderReversed: (connectorId, reversed) => {
      const p = get().doc.placements.find((pp) => pp.refId === connectorId)
      if ((p?.schematicPinOrderReversed ?? false) === reversed) return
      get().applyEdit((d) => {
        const q = d.placements.find((pp) => pp.refId === connectorId)
        if (!q) d.placements.push({ refId: connectorId, pos: { x: 0, y: 0 }, schematicPinOrderReversed: true })
        else if (reversed) q.schematicPinOrderReversed = true
        else delete q.schematicPinOrderReversed
      })
    },

    setBundlePart: (bundleId, part) => {
      if (!get().doc.bundles.some((b) => b.id === bundleId)) return
      get().applyEdit((d) => {
        const b = d.bundles.find((x) => x.id === bundleId)
        if (b) b.part = part
      })
    },

    setSheet: (sheet) => {
      const current = get().doc.drawing.sheet
      if (
        current.paper === sheet.paper &&
        current.orientation === sheet.orientation &&
        current.lengthMm === sheet.lengthMm
      )
        return
      get().applyEdit((d) => {
        d.drawing.sheet = { ...sheet }
      })
    },

    setTitleBlock: (patch) => {
      const current = get().doc.drawing.titleBlock ?? {}
      const next = { ...current, ...patch }
      if (JSON.stringify(next) === JSON.stringify(current)) return
      get().applyEdit((d) => {
        d.drawing.titleBlock = next
      })
    },

    setBlockPos: (move) => {
      const eff = effectiveBlockMoves(get().doc, [move])
      if (!eff.length) return
      get().applyEdit((d) => applyBlockMoves(d, eff))
    },

    clearBlockPos: (kind, id) => {
      const b = get().doc.drawing.blocks
      const keyed = kind === 'picture' ? b?.picture : b?.pinout
      const present = kind === 'bom' ? b?.bom !== undefined : id !== undefined && keyed?.[id] !== undefined
      if (!present) return
      get().applyEdit((d) => {
        const blk = d.drawing.blocks!
        if (kind === 'bom') delete blk.bom
        else if (kind === 'picture') {
          delete blk.picture![id!]
          if (!Object.keys(blk.picture!).length) delete blk.picture
        } else {
          delete blk.pinout![id!]
          if (!Object.keys(blk.pinout!).length) delete blk.pinout
        }
        if (!blk.bom && !blk.pinout && !blk.picture && !blk.pictureView) delete d.drawing.blocks
      })
    },

    setPictureView: (bodyId, patch) => {
      const doc = get().doc
      if (!pictureBodyIds(doc).has(bodyId)) return
      const current = currentPictureView(doc, bodyId)
      const next = normaliseView({ ...current, ...patch })
      // Both sides are normalised and their keys are written in one fixed
      // order, so JSON equality IS view equality here.
      if (JSON.stringify(next) === JSON.stringify(current)) return
      get().applyEdit((d) => {
        if (isIdentityView(next)) {
          const blk = d.drawing.blocks!
          delete blk.pictureView![bodyId]
          if (!Object.keys(blk.pictureView!).length) delete blk.pictureView
          if (!blk.bom && !blk.pinout && !blk.picture && !blk.pictureView) delete d.drawing.blocks
          return
        }
        d.drawing.blocks ??= {}
        d.drawing.blocks.pictureView ??= {}
        d.drawing.blocks.pictureView[bodyId] = next
      })
    },

    rotatePicture: (bodyId, deltaDeg) => {
      const from = currentPictureView(get().doc, bodyId).rotationDeg ?? 0
      get().setPictureView(bodyId, { rotationDeg: from + deltaDeg })
    },

    flipPicture: (bodyId, axis) => {
      const key = axis === 'h' ? 'flipH' : 'flipV'
      get().setPictureView(bodyId, { [key]: !currentPictureView(get().doc, bodyId)[key] })
    },

    setWireLengthOverride: (wireId, mm) => setWireMm(get, wireId, 'specifiedLengthMm', mm),
    setWireAllowance: (wireId, mm) => setWireMm(get, wireId, 'addLengthMm', mm),

    setSegmentLength: (segmentId, mm) => {
      const seg = get().doc.segments.find((x) => x.id === segmentId)
      if (!seg) return false
      if (mm !== null && (!isValidLengthMm(mm) || mm <= 0)) return false
      if ((seg.specifiedLengthMm ?? null) === mm) return false // no change → no history
      get().applyEdit((d) => {
        const sg = d.segments.find((x) => x.id === segmentId)
        if (!sg) return
        if (mm === null) delete sg.specifiedLengthMm
        else sg.specifiedLengthMm = mm
      })
      return true
    },

    rescaleSegment: (segmentId, toward) => {
      const check = checkRescaleSegment(get().doc, segmentId, toward)
      if (check !== 'ok') return check // refused → no history entry
      get().applyEdit((d) => void applyRescaleSegment(d, segmentId, toward))
      return 'ok'
    },

    undo: () => {
      const { past, doc, savedDoc } = get()
      if (past.length === 0) return
      const previous = past[past.length - 1]
      set((state) => {
        state.past.pop()
        state.future.push(doc as HarnessDocument)
        state.doc = previous
        state.dirty = previous !== savedDoc
      })
    },

    redo: () => {
      const { future, doc, savedDoc } = get()
      if (future.length === 0) return
      const next = future[future.length - 1]
      set((state) => {
        state.future.pop()
        state.past.push(doc as HarnessDocument)
        state.doc = next
        state.dirty = next !== savedDoc
      })
    }
  }))
)
