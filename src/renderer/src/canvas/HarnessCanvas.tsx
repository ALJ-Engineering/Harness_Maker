import React, { useMemo } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, ConnectionMode } from '@xyflow/react'
import type { HarnessDocument } from '@shared/model/schema'
import type { PrintBranding } from '@shared/print/titleBlock'
import type { PartImages } from '@shared/print/picture'
import { documentToFlow } from '../flow/toFlow'
import { documentToFormboard } from '../flow/toFormboard'
import { HARNESS_NODE_TYPES, HARNESS_EDGE_TYPES } from '../flow/registry'

export interface HarnessCanvasProps {
  /** The harness to draw. Electrical truth + layout overlay; nothing here is mutated. */
  doc: HarnessDocument
  /** `schematic` = connectors with pin handles and bezier wires; `formboard` = 1:1 dot bodies, segments, sheet + blocks. */
  view: 'schematic' | 'formboard'
  /** Title-block logo etc. for the formboard sheet; omit for an unbranded sheet. */
  branding?: PrintBranding
  /** Part photos keyed by part number (formboard picture blocks). */
  images?: PartImages
  /** Canvas height (CSS length). Width fills the container. Default `480px`. */
  height?: string | number
  /** Dot-grid spacing in mm; `false` hides the grid. Default `10`. */
  grid?: number | false
  /** Show the zoom/fit control cluster. Default `true`. */
  controls?: boolean
  /** Show the minimap. Default `true`. */
  minimap?: boolean
  /** Allow pan/zoom/drag. Default `true`; `false` gives a static picture. */
  interactive?: boolean
}

/**
 * The editor's canvas as a self-contained component: projects a
 * `HarnessDocument` through the app's real `documentToFlow` / `documentToFormboard`
 * and renders it with the app's real node and edge components inside a
 * `ReactFlowProvider`. Read-only — the store-backed editing (drag commits,
 * wiring, context menus) lives in `shell/HarnessPane.tsx`.
 */
export function HarnessCanvas({
  doc,
  view,
  branding = {},
  images = {},
  height = 480,
  grid = 10,
  controls = true,
  minimap = true,
  interactive = true
}: HarnessCanvasProps): React.JSX.Element {
  const { nodes, edges } = useMemo(
    () => (view === 'formboard' ? documentToFormboard(doc, branding, images) : documentToFlow(doc)),
    [doc, view, branding, images]
  )
  return (
    <div className="app__canvas" style={{ height, width: '100%', position: 'relative' }}>
      <ReactFlowProvider>
        <ReactFlow
          className={view === 'formboard' ? 'rf-formboard' : undefined}
          nodes={nodes}
          edges={edges}
          nodeTypes={HARNESS_NODE_TYPES}
          edgeTypes={HARNESS_EDGE_TYPES}
          connectionMode={ConnectionMode.Loose}
          nodesConnectable={false}
          nodesDraggable={interactive}
          panOnDrag={interactive}
          zoomOnScroll={interactive}
          zoomOnPinch={interactive}
          zoomOnDoubleClick={interactive}
          elementsSelectable={interactive}
          minZoom={0.05}
          maxZoom={20}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          {grid !== false && <Background gap={grid} />}
          {controls && <Controls />}
          {minimap && <MiniMap pannable zoomable />}
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
