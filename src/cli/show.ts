import type { HarnessDocument } from '@shared/model/schema'
import { natCompare } from '@shared/model/anchors'

export interface ShowResult {
  bodies: { designator: string; kind: 'connector' | 'terminal' | 'splice'; partNumber: string }[]
  wireCount: number
  cables: { name: string; partNumber: string; cores: number }[]
}

/** `harness show`: bodies by designator (natural order) with part numbers, the wire count, cables. Fs-free. */
export function showDocument(doc: HarnessDocument): ShowResult {
  const bodies: ShowResult['bodies'] = [
    ...doc.connectors.map((c) => ({ designator: c.designator, kind: 'connector' as const, partNumber: c.housing?.partNumber ?? '' })),
    ...doc.freeTerminals.map((t) => ({ designator: t.designator, kind: 'terminal' as const, partNumber: t.part?.partNumber ?? '' })),
    ...doc.splices.map((s) => ({ designator: s.designator, kind: 'splice' as const, partNumber: s.part?.partNumber ?? '' }))
  ].sort((a, b) => natCompare(a.designator, b.designator))
  const cables = doc.cables.map((c) => ({ name: c.name, partNumber: c.part?.partNumber ?? '', cores: c.coreWireIds.length }))
  return { bodies, wireCount: doc.wires.length, cables }
}
