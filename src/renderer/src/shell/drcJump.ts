import type { EntityRef } from '@shared/drc'
import type { HarnessDocument } from '@shared/model/schema'
import type { PaneView } from '../store'

/**
 * A React Flow element a DRC finding can be jumped to. `kind` is what the shell
 * needs to build a `Selection` — a node id and an edge id are drawn from
 * different namespaces and inspected by different editors.
 */
export interface FlowTarget {
  kind: 'node' | 'edge'
  id: string
}

/**
 * The element that stands for `ref` in ONE view, or null if that view draws no
 * such element. This is mode-dependent and that is the whole point: the two
 * projections do not contain the same things.
 *
 * - connector/splice/freeTerminal → the node id (a body is a node in both views)
 * - branchPoint → a formboard node; **null in the schematic**, which has no
 *   branch points at all. Returning the id anyway would send a jump at a pane
 *   that cannot show it, and — single-pane — render the finding as
 *   clickable-but-dead.
 * - cavity → the owning connector's node (cavities are handles, not nodes)
 * - wire → schematic: the edge id; formboard: null (there, edges are segments)
 * - segment → formboard: the edge id; schematic: null
 * - cable/sleeving/twist → not nodes or edges in either view
 */
export function refFlowTarget(
  doc: HarnessDocument,
  ref: EntityRef,
  viewMode: PaneView
): FlowTarget | null {
  switch (ref.kind) {
    case 'connector':
    case 'splice':
    case 'freeTerminal':
      return { kind: 'node', id: ref.id }
    case 'branchPoint':
      return viewMode === 'formboard' ? { kind: 'node', id: ref.id } : null
    case 'cavity': {
      const owner = doc.connectors.find((c) => c.cavities.some((cv) => cv.id === ref.id))
      return owner ? { kind: 'node', id: owner.id } : null
    }
    case 'wire':
      return viewMode === 'schematic' ? { kind: 'edge', id: ref.id } : null
    case 'segment':
      return viewMode === 'formboard' ? { kind: 'edge', id: ref.id } : null
    default:
      return null
  }
}

/**
 * The element a DRC jump should select, given the views currently on screen in
 * preference order — **focused pane first**, then the other visible one. The
 * first view that can draw the ref wins; if none can, the jump is a no-op
 * rather than a selection nothing displays.
 *
 * Ordering matters only for which pane's mode decides; the resulting id is the
 * shell's, and both panes read it back, so the element lights up wherever it
 * can be drawn.
 */
export function resolveJumpTarget(
  doc: HarnessDocument,
  ref: EntityRef,
  views: readonly PaneView[]
): FlowTarget | null {
  for (const v of views) {
    const t = refFlowTarget(doc, ref, v)
    if (t) return t
  }
  return null
}
