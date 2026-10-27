import type { Node } from '@xyflow/react'

/**
 * A React Flow node's visual centre in flow coordinates. `position` is the
 * point the node's `origin` names — `[0,0]` (the default) is the top-left
 * corner, `[0.5,0.5]` the centre, which is how formboard dots and branch points
 * sit on their model `pos`. Size comes from `data.w`/`data.h` (board blocks)
 * when present, else React Flow's measurement.
 */
export function nodeCentre(node: Node): { x: number; y: number } {
  const [ox, oy] = node.origin ?? [0, 0]
  const w = typeof node.data.w === 'number' ? node.data.w : (node.measured?.width ?? 0)
  const h = typeof node.data.h === 'number' ? node.data.h : (node.measured?.height ?? 0)
  return { x: node.position.x + (0.5 - ox) * w, y: node.position.y + (0.5 - oy) * h }
}
