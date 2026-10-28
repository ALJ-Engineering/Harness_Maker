import type { Connection, Edge } from '@xyflow/react'
import type { Endpoint } from '@shared/model/schema'
import { parseHandleId, sameEndpoint } from '../flow/toFlow'

/**
 * What dropping a dragged wire end means: which end of the wire moved, and to
 * which endpoint. React Flow keeps an edge's orientation through a reconnect —
 * the new connection's source is still the wire's end 0 and its target end 1,
 * whichever end was dragged — so the end whose handle changed is the one that
 * moved. Null when neither changed, or a handle is not a wire end.
 */
export function reconnectOutcome(edge: Edge, conn: Connection): { end: 0 | 1; to: Endpoint } | null {
  const was = [parseHandleId(edge.sourceHandle ?? ''), parseHandleId(edge.targetHandle ?? '')]
  const now = [parseHandleId(conn.sourceHandle ?? ''), parseHandleId(conn.targetHandle ?? '')]
  if (!was[0] || !was[1] || !now[0] || !now[1]) return null
  if (!sameEndpoint(was[0], now[0])) return sameEndpoint(was[1], now[1]) ? { end: 0, to: now[0] } : null
  if (!sameEndpoint(was[1], now[1])) return { end: 1, to: now[1] }
  return null
}
