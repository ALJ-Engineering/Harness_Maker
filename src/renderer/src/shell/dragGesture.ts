import type { HarnessDocument, Id } from '@shared/model/schema'
import { computeFormboard } from '@shared/model/formboard'
import { projectFraction } from '@shared/model/treatments'
import type { BlockMove, HarnessState, PaneView } from '../store'
import type { FlowNode } from '../flow/toFlow'

/**
 * Drop distance (mm, model space) within which dragging one branch point onto
 * another fuses them into a single bundle branch point. Branch dots render ~12 mm
 * wide, so centres this close visually overlap. Mechanical/formboard-only.
 */
export const BRANCH_MERGE_MM = 10

/** What a finished drag commits: a branch-point fuse, or one `commitGesture` payload. */
export type DragOutcome =
  | { kind: 'merge'; srcId: Id; dstId: Id }
  | { kind: 'gesture'; gesture: Parameters<HarnessState['commitGesture']>[0] }

/**
 * Pure mapping from the nodes React Flow reports at drag-stop to the document
 * edit they mean (geometry only). Formboard drags write the physical layout
 * (pos); schematic drags write schematicPos.
 */
export function dragOutcome(
  doc: HarnessDocument,
  mode: PaneView,
  dragged: FlowNode[]
): DragOutcome {
  // Bundle authoring (formboard, mechanical): dropping a SINGLE branch point
  // onto (within BRANCH_MERGE_MM of) another fuses them into one shared bundle
  // branch point. Doing this at two places coalesces the parallel limbs between
  // them into one shared segment carrying every wire — i.e. a bundle.
  if (mode === 'formboard' && dragged.length === 1 && dragged[0].type === 'branch') {
    const d = dragged[0]
    const target = doc.branchPoints.find(
      (b) =>
        b.id !== d.id &&
        Math.hypot(b.pos.x - d.position.x, b.pos.y - d.position.y) <= BRANCH_MERGE_MM
    )
    if (target) return { kind: 'merge', srcId: d.id, dstId: target.id }
  }
  // Placement/branch-point moves: every body/branch node in the drag (labels
  // and board furniture are handled below; the sheet never moves).
  const nodeMoves = dragged
    .filter(
      (n) =>
        n.type !== 'label' &&
        n.type !== 'pinoutTable' &&
        n.type !== 'bomBlock' &&
        n.type !== 'pictureBlock' &&
        n.type !== 'formboardSheet'
    )
    .map((n) => ({ refId: n.id, pos: { x: n.position.x, y: n.position.y } }))
  // Labels: an anchored label is a dot ON the wire — its node position IS the
  // bead, so project it straight onto the segment line and commit a fraction.
  // An unanchored label keeps a free `pos`. Everything else is a
  // placement/branch-point move set; all three move sets commit via one commitGesture call (one undo entry per drag).
  const labelNodes = dragged.filter((n) => n.type === 'label')
  const anchorMoves: { id: string; fraction: number }[] = []
  const freeMoves: { id: string; pos: { x: number; y: number } }[] = []
  if (labelNodes.length) {
    // Project onto the POST-move geometry: in a group drag the segment's end
    // bodies/branch points moved with the label, and projecting onto where the
    // segment WAS would slide the bead along the wire.
    const geomDoc = mode === 'formboard' ? withNodeMoves(doc, nodeMoves) : doc
    const segPos = new Map(computeFormboard(geomDoc).segments.map((s) => [s.id, s]))
    for (const n of labelNodes) {
      const lab = doc.labels.find((l) => l.id === n.id)
      const seg = lab?.anchor ? segPos.get(lab.anchor.segmentId) : undefined
      if (lab?.anchor && seg) {
        anchorMoves.push({ id: n.id, fraction: projectFraction(seg.a, seg.b, n.position) })
      } else {
        freeMoves.push({ id: n.id, pos: { x: n.position.x, y: n.position.y } })
      }
    }
  }
  // Board furniture: dragging a pinout table, a part picture or the BOM
  // block PINS it — the plan then takes that mm position verbatim. Their
  // node ids carry reserved prefixes (`tbl:` / `pic:` / `__bom`) that are
  // NOT entity ids, so they must never reach `nodeMoves` (which writes
  // placements by refId).
  const blockMoves: BlockMove[] = dragged
    .filter((n) => n.type === 'pinoutTable' || n.type === 'bomBlock' || n.type === 'pictureBlock')
    .map((n) => {
      const pos = { x: n.position.x, y: n.position.y }
      if (n.type === 'bomBlock') return { kind: 'bom', pos }
      if (n.type === 'pictureBlock') return { kind: 'picture', id: n.id.slice('pic:'.length), pos }
      return { kind: 'pinout', id: n.id.slice('tbl:'.length), pos }
    })
  // One gesture = one undo entry (B5): node moves, free-label moves,
  // anchored-label slides and block pins from the SAME drag-stop all fold
  // into one commit.
  return {
    kind: 'gesture',
    gesture: {
      nodeMoves,
      target: mode === 'formboard' ? 'physical' : 'schematic',
      labelMoves: freeMoves,
      anchorMoves,
      blockMoves
    }
  }
}

/**
 * A shallow copy of `doc` with the drag's formboard node moves applied to the
 * placements and branch points (the only inputs segment geometry reads). The
 * input document is left untouched.
 */
function withNodeMoves(
  doc: HarnessDocument,
  moves: { refId: Id; pos: { x: number; y: number } }[]
): HarnessDocument {
  if (!moves.length) return doc
  const to = new Map(moves.map((m) => [m.refId, m.pos]))
  return {
    ...doc,
    placements: doc.placements.map((p) => (to.has(p.refId) ? { ...p, pos: to.get(p.refId)! } : p)),
    branchPoints: doc.branchPoints.map((b) => (to.has(b.id) ? { ...b, pos: to.get(b.id)! } : b))
  }
}
