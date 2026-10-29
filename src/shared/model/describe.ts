import type { Endpoint, HarnessDocument, Id, Sleeving, SleevingType } from './schema'
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

/** What each sleeving type is called on the drawing, in the BOM and in the panel. */
export const SLEEVING_TYPE_LABEL: Record<SleevingType, string> = {
  braided: 'Braided sleeve',
  convoluted: 'Convoluted tube',
  heatshrink: 'Heat shrink',
  pvc: 'PVC tube',
  tape: 'Tape'
}

/**
 * A sleeve as the BOM and the drawing name it when it has no part number:
 * type, size and colour, e.g. "PVC tube 5mm BK". Blank fields are left out.
 */
export function describeSleeving(sl: Pick<Sleeving, 'sleevingType' | 'size' | 'color'>): string {
  return [SLEEVING_TYPE_LABEL[sl.sleevingType] ?? sl.sleevingType, sl.size?.trim(), sl.color?.trim()]
    .filter(Boolean)
    .join(' ')
}

/** A sleeve's reference, `SL<n>` by its order in `doc.sleeving`: the cut list, BOM and drawing all use it. */
export function sleevingRef(doc: HarnessDocument, id: Id): string {
  const i = doc.sleeving.findIndex((s) => s.id === id)
  return i < 0 ? 'SL?' : `SL${i + 1}`
}
