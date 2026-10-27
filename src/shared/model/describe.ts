import type { Endpoint, HarnessDocument } from './schema'
import { endpointBodyId } from './endpoints'

/** Human-readable label for an endpoint, e.g. "X1.3" or "T1 ring → B+ stud". */
export function describeEndpoint(doc: HarnessDocument, ep: Endpoint): string {
  switch (ep.type) {
    case 'cavity': {
      const c = doc.connectors.find((c) => c.cavities.some((cv) => cv.id === ep.cavityId))
      const cv = c?.cavities.find((cv) => cv.id === ep.cavityId)
      return c && cv ? `${c.designator}.${cv.position}` : 'cavity ?'
    }
    case 'freeTerminal': {
      const ft = doc.freeTerminals.find((f) => f.id === ep.terminalId)
      if (!ft) return 'terminal ?'
      return ft.landsOn
        ? `${ft.designator} ${ft.kind} → ${ft.landsOn}`
        : `${ft.designator} ${ft.kind}`
    }
    case 'splice': {
      const sp = doc.splices.find((s) => s.id === ep.spliceId)
      return sp ? `${sp.designator} (${sp.kind})` : 'splice ?'
    }
    case 'shield': {
      const cab = doc.cables.find((c) => c.id === ep.cableId)
      return `${cab?.name ?? 'cable'} shield ${ep.end}`
    }
  }
}

/** @see endpointBodyId — kept under its old name for existing callers. */
export function endpointNodeId(doc: HarnessDocument, ep: Endpoint): string | null {
  return endpointBodyId(doc, ep)
}
