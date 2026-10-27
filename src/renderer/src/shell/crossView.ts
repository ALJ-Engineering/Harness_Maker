import type { HarnessDocument } from '@shared/model/schema'
import type { PaneView } from '../store'

/**
 * The flow ids in `view` that show the same physical thing as the selected ids,
 * where the two projections name it differently. Bodies need nothing here — a
 * body is the same node id in both views, so the shared selection already
 * reaches it. Wires do: the schematic draws a WIRE edge, the formboard draws the
 * SEGMENTS it is routed over. So a selected wire lights its route's segments on
 * the formboard, and a selected segment lights every wire routed through it in
 * the schematic. These are highlights, never selection: the inspector keeps
 * showing what was actually clicked.
 */
export function crossViewIds(
  doc: HarnessDocument,
  selected: ReadonlySet<string>,
  view: PaneView
): Set<string> {
  const out = new Set<string>()
  if (selected.size === 0) return out
  for (const r of doc.wireRoutes) {
    if (view === 'formboard') {
      if (selected.has(r.wireId)) for (const sid of r.path) out.add(sid)
    } else if (r.path.some((sid) => selected.has(sid))) out.add(r.wireId)
  }
  return out
}
