import type { FbBody } from '@shared/model/formboard'
import type { Vec2 } from '@shared/model/schema'

/**
 * The drawn body closest to a point, or null if the nearest one is further than
 * `maxMm`. Used by the canvas' image drop handler: a photo dropped on the board
 * belongs to the dot under the cursor, and dropping on empty board is a no-op
 * rather than a surprise import onto whatever happened to be nearest.
 *
 * Model space, millimetres — `at` is already through `screenToFlowPosition`.
 */
export function nearestBody(bodies: readonly FbBody[], at: Vec2, maxMm: number): FbBody | null {
  let best: FbBody | null = null
  let bestD = Infinity
  for (const b of bodies) {
    const d = Math.hypot(b.pos.x - at.x, b.pos.y - at.y)
    if (d < bestD) {
      bestD = d
      best = b
    }
  }
  return best && bestD <= maxMm ? best : null
}
