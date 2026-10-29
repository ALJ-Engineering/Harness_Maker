import type { Edge, Node } from '@xyflow/react'
import type { HarnessDocument } from '@shared/model/schema'
import type { ThemeName } from '../useTheme'
import { strokeForColor } from '@shared/model/colors'
import { describeEndpoint, endpointNodeId } from '@shared/model/describe'
import { endpointHandleId, parseHandleId, sameEndpoint, type HandleSide } from '@shared/model/endpoints'
import { sortedCavities } from '@shared/model/anchors'
import { wireHandles } from './wireSides'

// Re-exported so existing renderer imports (`./toFlow`) keep working after these
// pure helpers moved to the shared layer for the SVG/BOM exporter to reuse.
export { strokeForColor, describeEndpoint, endpointHandleId, parseHandleId, sameEndpoint }

export interface ConnectorNodeData extends Record<string, unknown> {
  designator: string
  cavities: { id: string; position: string; status: string }[]
  exitSide: 'left' | 'right' | 'top' | 'bottom' | 'nearest'
}
export interface TerminalNodeData extends Record<string, unknown> {
  designator: string
  kind: string
  landsOn?: string
  /** The sides wires meet it on (`wireSides.ts`); its other handles stay hidden until hover. */
  sides?: HandleSide[]
}
export interface SpliceNodeData extends Record<string, unknown> {
  designator: string
  kind: string
  /** As `TerminalNodeData.sides`. */
  sides?: HandleSide[]
}
export interface BranchNodeData extends Record<string, unknown> {
  highlighted?: boolean
}
export interface LabelNodeData extends Record<string, unknown> {
  /** "Kind: text" — shown as the dot's tooltip (the full text lives in the panel + SVG). */
  display: string
  highlighted?: boolean
}

// ---------------------------------------------------------------------------
// Formboard node data — used by the formboard view.
// ---------------------------------------------------------------------------

/** A formboard body: ONE dot at the placement (the anchor every wire on it lands on) + its label. */
export interface FormboardBodyData extends Record<string, unknown> {
  label: string
  kind: 'connector' | 'terminal' | 'splice'
  /** Handle id = route-node key `n:<refId>`; segment edges attach here whatever cavity they serve. */
  handleId: string
  highlighted?: boolean
}

// ---------------------------------------------------------------------------
// Board furniture — formboard view only (spec §5). These nodes are the page
// itself, not the harness: the drawing sheet + title block the export will print,
// and the pinout / BOM blocks the planner placed. They carry no electrical
// identity, so their ids use reserved prefixes (`__sheet`, `__bom`,
// `tbl:<connectorId>`) that must never be resolved as entity ids.
// ---------------------------------------------------------------------------

export interface SheetNodeData extends Record<string, unknown> {
  /** The sheet's printable area (mm); its top-left is the node position (`plan.contentOrigin`). */
  printable: { w: number; h: number }
  /** Title block SVG, drawn at (x, y) relative to the node origin (contentOrigin). */
  titleBlock: { x: number; y: number; svg: string }
  /** `planBoard` warning codes, surfaced as a badge. */
  warnings: string[]
}

export interface BlockNodeData extends Record<string, unknown> {
  kind: 'pinout' | 'bom' | 'tolerance' | 'picture'
  /**
   * Connector / free-terminal id (pinout), body id (picture), `BOM_BLOCK_ID`
   * (bom) or `TOLERANCE_BLOCK_ID` (tolerance) — NOT the node id.
   */
  refId: string
  w: number
  h: number
  /** The SAME markup the PDF prints — `renderTable` or `renderPictureBlock` (WYSIWYG). */
  svg: string
  /** True when the position came from `doc.drawing.blocks` (user-dragged). */
  pinned: boolean
}

export type FlowNode =
  | (Node<ConnectorNodeData> & { type: 'connector' })
  | (Node<TerminalNodeData> & { type: 'freeTerminal' })
  | (Node<SpliceNodeData> & { type: 'splice' })
  | (Node<BranchNodeData> & { type: 'branch' })
  | (Node<LabelNodeData> & { type: 'label' })
  | (Node<FormboardBodyData> & { type: 'formboardBody' })
  | (Node<SheetNodeData> & { type: 'formboardSheet' })
  | (Node<BlockNodeData> & { type: 'pinoutTable' })
  | (Node<BlockNodeData> & { type: 'bomBlock' })
  | (Node<BlockNodeData> & { type: 'toleranceBlock' })
  | (Node<BlockNodeData> & { type: 'pictureBlock' })

/**
 * Project the electrical model + placements into React Flow nodes/edges.
 * Pure & derived: nothing here is persisted. Phase 1 renders connectors and
 * free terminals as nodes and wires as edges between cavity/terminal handles.
 *
 * `theme` rides along in each wire edge's `data` for one reason: React Flow
 * re-renders an edge when its data, selection or the viewport changes — NOT
 * when an unrelated DOM attribute flips. `WireEdge` picks its stroke with
 * `screenStroke(base, theme)`, so without this a theme toggle would leave every
 * wire showing the previous theme's colours until a pan, zoom or click forced a
 * repaint. Threading it through the projection makes a toggle a data change,
 * which React Flow already reacts to — no remount, and the viewport survives.
 * (Remounting the pane instead is forbidden: see the comment on `HarnessPane`'s
 * `flow` memo.) Optional so the pure
 * projection tests can keep calling this with one argument.
 */
export function documentToFlow(
  doc: HarnessDocument,
  theme?: ThemeName
): { nodes: FlowNode[]; edges: Edge[] } {
  const posOf = (refId: string): { x: number; y: number } => {
    const p = doc.placements.find((pp) => pp.refId === refId)
    return p?.schematicPos ?? p?.pos ?? { x: 0, y: 0 }
  }

  const pinOrderReversed = (refId: string): boolean =>
    doc.placements.find((pp) => pp.refId === refId)?.schematicPinOrderReversed === true

  const nodes: FlowNode[] = []

  for (const c of doc.connectors) {
    nodes.push({
      id: c.id,
      type: 'connector',
      position: posOf(c.id),
      // Deletable: Delete/Backspace removes the connector AND every wire on
      // its cavities as one undo step (`HarnessPane`'s onDelete → store
      // `removeElements`).
      data: {
        designator: c.designator,
        // Display order: natural / numeric-aware, matching the formboard + SVG
        // pin order (the stored array is never reordered) — bottom-up when the
        // placement mirrors the symbol top↔bottom.
        cavities: (pinOrderReversed(c.id) ? sortedCavities(c).reverse() : sortedCavities(c)).map((cv) => ({
          id: cv.id,
          position: cv.position,
          status: cv.status
        })),
        exitSide: (doc.placements.find((p) => p.refId === c.id)?.schematicExitSide ?? 'right')
      }
    })
  }

  for (const ft of doc.freeTerminals) {
    nodes.push({
      id: ft.id,
      type: 'freeTerminal',
      position: posOf(ft.id),
      data: { designator: ft.designator, kind: ft.kind, landsOn: ft.landsOn }
    })
  }

  for (const sp of doc.splices) {
    nodes.push({
      id: sp.id,
      type: 'splice',
      position: posOf(sp.id),
      data: { designator: sp.designator, kind: sp.kind }
    })
  }

  const edges: Edge[] = []
  // The side each wire meets a body on (`wireSides.ts`).
  const handlesOf = wireHandles(doc, posOf)
  for (const w of doc.wires) {
    const [a, b] = w.ends
    const src = endpointNodeId(doc, a)
    const tgt = endpointNodeId(doc, b)
    if (!src || !tgt) continue
    const [sourceHandle, targetHandle] = handlesOf(w)
    edges.push({
      id: w.id,
      source: src,
      target: tgt,
      sourceHandle,
      targetHandle,
      type: 'wire',
      data: {
        base: w.color.base,
        stripes: w.color.stripes,
        gauge: `${w.gauge.value} ${w.gauge.unit}`,
        theme
      }
    })
  }

  // Which sides of each terminal/splice carry a wire: `<prefix>:<id>|<side>`.
  const sidesOf = new Map<string, Set<HandleSide>>()
  for (const e of edges)
    for (const [node, h] of [[e.source, e.sourceHandle], [e.target, e.targetHandle]] as const) {
      const side = h?.match(/[|](left|right|top|bottom)$/)?.[1] as HandleSide | undefined
      if (side) sidesOf.set(node, (sidesOf.get(node) ?? new Set()).add(side))
    }
  for (const n of nodes)
    if (n.type === 'freeTerminal' || n.type === 'splice') n.data.sides = [...(sidesOf.get(n.id) ?? [])]

  return { nodes, edges }
}
