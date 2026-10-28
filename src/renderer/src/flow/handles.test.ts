import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReactFlow } from '@xyflow/react'
import { demoDocument } from '@shared/model/document'
import { documentToFlow } from './toFlow'
import { HARNESS_NODE_TYPES } from './registry'

/**
 * React Flow draws an edge only when its `sourceHandle` is a `type="source"`
 * handle; Loose mode relaxes the TARGET side alone (`getEdgePosition` in
 * @xyflow/system). `documentToFlow` makes a wire's `ends[0]` the edge source,
 * and either end may be any body — so every wire end the schematic renders
 * must be a source handle, or a wire that starts there is silently not drawn
 * (error 008). A ring terminal's was a target: ring-to-ring wires, and
 * `wire from: T1` from the CLI, existed in the file but never on the canvas.
 *
 * Rendered with React Flow's server renderer, so this reads the handles the
 * node components actually emit.
 */
describe('schematic handles', () => {
  it('every wire end on every schematic body is a source handle', () => {
    const doc = demoDocument()
    doc.splices.push({ id: 'sp-1', designator: 'SP1', kind: 'butt' })
    // X2 exits "nearest": a handle on both sides of each of its rows.
    doc.placements.find((p) => p.refId === 'conn-x2')!.schematicExitSide = 'nearest'
    const { nodes } = documentToFlow(doc)
    expect(new Set(nodes.map((n) => n.type))).toEqual(new Set(['connector', 'freeTerminal', 'splice']))

    const html = renderToStaticMarkup(
      createElement(ReactFlow, {
        nodes: nodes.map((n) => ({ ...n, width: 100, height: 100 })),
        edges: [],
        nodeTypes: HARNESS_NODE_TYPES,
        width: 800,
        height: 600
      })
    )
    const handles = [...html.matchAll(/<div[^>]*data-handleid="([^"]*)"[^>]*class="([^"]*)"/g)].map(
      ([, id, cls]) => ({ id, type: cls.split(' ').find((c) => c === 'source' || c === 'target') })
    )
    // A terminal and a splice have a handle on every side (`FourSideHandles`).
    expect(handles.map((h) => h.id)).toEqual(
      expect.arrayContaining([
        'cav:cav-x1-1',
        'cav:cav-x2-a|left',
        'cav:cav-x2-a|right',
        ...['left', 'top', 'right', 'bottom'].flatMap((side) => [`ft:ft-bplus|${side}`, `sp:sp-1|${side}`])
      ])
    )
    expect(handles.filter((h) => h.type !== 'source')).toEqual([])
  })
})
