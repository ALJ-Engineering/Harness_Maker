import type { NodeTypes, EdgeTypes } from '@xyflow/react'
import { ConnectorNode } from './ConnectorNode'
import { FreeTerminalNode } from './FreeTerminalNode'
import { SpliceNode } from './SpliceNode'
import { BranchNode } from './BranchNode'
import { LabelNode } from './LabelNode'
import { WireEdge } from './WireEdge'
import { FormboardBodyNode } from './FormboardBodyNode'
import { FormboardSegmentEdge } from './FormboardSegmentEdge'
import { SheetNode } from './SheetNode'
import { BlockNode } from './BlockNode'

/**
 * The React Flow node/edge type registries the canvas renders with — one
 * place, shared by `shell/HarnessPane.tsx` and the `HarnessCanvas` design-system
 * wrapper so the two can never disagree about which component draws which node
 * type.
 */
export const HARNESS_NODE_TYPES: NodeTypes = {
  // Schematic view types
  connector: ConnectorNode,
  freeTerminal: FreeTerminalNode,
  splice: SpliceNode,
  branch: BranchNode,
  label: LabelNode,
  // Formboard view types (React Flow only renders types present in current nodes)
  formboardBody: FormboardBodyNode,
  // Board furniture: the printed page and its blocks (spec §5).
  formboardSheet: SheetNode,
  pinoutTable: BlockNode,
  bomBlock: BlockNode,
  toleranceBlock: BlockNode,
  pictureBlock: BlockNode
}

export const HARNESS_EDGE_TYPES: EdgeTypes = {
  wire: WireEdge,
  formboardSegment: FormboardSegmentEdge
}
