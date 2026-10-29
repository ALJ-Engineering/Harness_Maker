import type { Edge } from '@xyflow/react'
import type { HarnessDocument, RouteNode } from '@shared/model/schema'
import { computeFormboard, labelDisplayText, type FbLayout } from '@shared/model/formboard'
import { bodyKey } from '@shared/model/endpoints'
import { incidentSegments, isSelfLoopSegment } from '@shared/model/topology'
import { planBoard, TABLE_PAD, type PartImages, type PlacedBlock } from '@shared/print/board'
import { pictureBlockSize, renderPictureBlock } from '@shared/print/picture'
import { sheetMm } from '@shared/print/sheet'
import { renderTable, TABLE_STYLE_SHEET } from '@shared/print/tables'
import { renderTitleBlock, type PrintBranding } from '@shared/print/titleBlock'
import type { FlowNode } from './toFlow'
import type { FormboardSegmentEdgeData } from './FormboardSegmentEdge'

/**
 * A board block's node id. The prefixes / reserved ids are never entity ids, so
 * a block drag cannot be mistaken for a placement move (`dragGesture.ts`).
 */
const BLOCK_NODE_ID: Record<PlacedBlock['kind'], (id: string) => string> = {
  pinout: (id) => `tbl:${id}`,
  picture: (id) => `pic:${id}`,
  bom: () => '__bom',
  tolerance: () => '__tolerance'
}
const BLOCK_NODE_TYPE = {
  pinout: 'pinoutTable',
  picture: 'pictureBlock',
  bom: 'bomBlock',
  tolerance: 'toleranceBlock'
} as const satisfies Record<PlacedBlock['kind'], FlowNode['type']>

/** React Flow source/target + handle for a route-node. Null if it has no node. */
function nodeRef(layout: FbLayout, node: RouteNode): { id: string; handle: string } | null {
  if (node.type === 'branch') return { id: node.branchId, handle: `br:${node.branchId}` }
  // A cable (shield anchor) has a placement but no drawn body → no node → no edge.
  return layout.bodies.some((b) => b.id === node.refId) ? { id: node.refId, handle: bodyKey(node.refId) } : null
}

/**
 * Formboard projection: builds React Flow nodes/edges from `computeFormboard(doc)`.
 * - every FbBody (connector / terminal / splice) → ONE `formboardBody` dot node
 *   centred on its placement, carrying the body handle `n:<refId>`
 * - branchPoint → `branch` node (unchanged)
 * - FbSegment → `formboardSegment` edge coloured by routed wire(s)
 * - the BOARD PLAN → one `formboardSheet` node (the drawing sheet + title block) plus a
 *   `pinoutTable` / `bomBlock` / `toleranceBlock` / `pictureBlock` node per placed block, so the
 *   canvas shows exactly what the 1:1 PDF prints (spec §5).
 *
 * `branding` only reaches the title block: the logo read from the parts
 * library (`<library>/branding/logo.*`). Default empty ⇒ an empty logo cell.
 *
 * `images` is the part-photo library (keyed by part number, `parts-image://`
 * hrefs on the canvas). Default empty ⇒ no picture blocks, i.e. the projection
 * this function made before pictures existed.
 *
 * Pure & derived; nothing here is persisted.
 */
export function documentToFormboard(
  doc: HarnessDocument,
  branding: PrintBranding = {},
  images: PartImages = {}
): { nodes: FlowNode[]; edges: Edge[] } {
  const layout = computeFormboard(doc)

  const nodes: FlowNode[] = []

  // The page comes first so it is drawn underneath everything else (zIndex
  // pins it there too — array order alone is not enough once nodes are
  // re-ordered by selection).
  const plan = planBoard(
    doc,
    sheetMm(doc.drawing.sheet),
    layout,
    images
  )
  nodes.push({
    id: '__sheet',
    type: 'formboardSheet',
    position: plan.contentOrigin,
    // Furniture, not harness: it must never be dragged, selected, focused or
    // deleted, and it must never sit above the drawing.
    draggable: false,
    selectable: false,
    deletable: false,
    focusable: false,
    zIndex: -10,
    data: {
      printable: plan.printable,
      titleBlock: {
        x: plan.titleBlockRect.x - plan.contentOrigin.x,
        y: plan.titleBlockRect.y - plan.contentOrigin.y,
        svg: renderTitleBlock(0, 0, doc.drawing.titleBlock, branding)
      },
      warnings: plan.warnings
    }
  })

  // Blocks render the SAME markup as print — `renderTable` for the table
  // kinds, `renderPictureBlock` for a picture. The pinout's inner x-offset is
  // `TABLE_PAD / 2` because `planBoard` sizes a pinout rect as
  // `tableWidth + TABLE_PAD`, i.e. the table is centred in its rect; the BOM,
  // tolerance and picture rects are the drawn width exactly, so they draw at 0.
  const blockNode = (b: PlacedBlock): FlowNode => ({
    id: BLOCK_NODE_ID[b.kind](b.id),
    type: BLOCK_NODE_TYPE[b.kind],
    position: { x: b.rect.x, y: b.rect.y },
    deletable: false,
    zIndex: 5,
    data: {
      kind: b.kind,
      refId: b.id,
      w: b.rect.w,
      h: b.rect.h,
      pinned: b.pinned,
      svg:
        b.kind === 'picture'
          ? renderPictureBlock(pictureBlockSize(b.image!, b.view), b.image!, b.caption ?? '', b.view)
          : renderTable(
              b.kind === 'pinout' ? TABLE_PAD / 2 : 0,
              0,
              b.spec!.cols,
              b.spec!.rows,
              TABLE_STYLE_SHEET,
              { title: b.title }
            ).svg
    }
  })
  for (const t of plan.tables) nodes.push(blockNode(t))
  for (const p of plan.pictures) nodes.push(blockNode(p))
  nodes.push(blockNode(plan.bom))
  if (plan.tolerance) nodes.push(blockNode(plan.tolerance))

  // One dot per body — connector, free terminal and splice all render the same
  // glyph. origin [0.5,0.5] centres the dot AND its handle on `body.pos` (the
  // model coord), so segment edges run along the true model line and a drag
  // commits `node.position` straight back as the placement.
  for (const body of layout.bodies) {
    nodes.push({
      id: body.id,
      type: 'formboardBody',
      position: body.pos,
      origin: [0.5, 0.5],
      deletable: false,
      data: { label: body.label, kind: body.kind, handleId: bodyKey(body.id) }
    })
  }

  for (const bp of layout.branchPoints) {
    // Derived degree (shared helper — a self-loop counts once; see model/topology.ts).
    // Degree-2 == bend: removable (deletable:true). Degree->=3 == Y-split: non-deletable.
    const incident = incidentSegments(doc, bp.id)
    const removable = incident.length === 2 && !incident.some(isSelfLoopSegment)
    // origin [0.5,0.5] centers the 12×12 dot AND its connection handle on bp.pos
    // (the model coord), so rendered segment edges run along the true model line —
    // which is what lets an anchored label dot sit exactly ON the wire.
    nodes.push({ id: bp.id, type: 'branch', position: bp.pos, origin: [0.5, 0.5], deletable: removable, data: {} })
  }

  // Labels render as a white dot ON the wire (anchored → at the bead; free → at
  // its `pos`); the kind+text show in the panel + 1:1 SVG, not on the canvas.
  // Positions come from `layout` so the dot lands on the same wire the SVG draws.
  for (const lbl of layout.labels) {
    nodes.push({
      id: lbl.id,
      type: 'label',
      position: lbl.bead ?? lbl.pos,
      // origin [0.5,0.5] → the dot is CENTERED on its coordinate (the bead, ON the
      // wire) rather than top-left-anchored; keeps the drag hit-area centred too.
      origin: [0.5, 0.5],
      deletable: false,
      data: { display: labelDisplayText(lbl.kind, lbl.text) }
    })
  }

  const edges: Edge[] = []
  for (const seg of doc.segments) {
    const a = nodeRef(layout, seg.from)
    const b = nodeRef(layout, seg.to)
    if (!a || !b) continue

    // Find corresponding FbSegment for colour/bundle/length data.
    // If the segment isn't in the layout (e.g. an endpoint is unplaced),
    // skip it — no node exists for its endpoint in this view.
    const fbSeg = layout.segments.find((s) => s.id === seg.id)
    if (!fbSeg) continue

    edges.push({
      id: seg.id,
      source: a.id,
      target: b.id,
      sourceHandle: a.handle,
      targetHandle: b.handle,
      type: 'formboardSegment',
      deletable: false,
      data: {
        colour: fbSeg.colour,
        stripes: fbSeg.stripes,
        bundle: fbSeg.bundle,
        lengthMm: fbSeg.lengthMm,
        ...(fbSeg.specifiedLengthMm !== undefined ? { specifiedLengthMm: fbSeg.specifiedLengthMm } : {}),
        broken: fbSeg.broken,
        shrink: fbSeg.broken && (fbSeg.specifiedLengthMm ?? 0) < (fbSeg.drawnLengthMm ?? 0),
        segmentId: seg.id
      } satisfies FormboardSegmentEdgeData
    })
  }

  return { nodes, edges }
}
