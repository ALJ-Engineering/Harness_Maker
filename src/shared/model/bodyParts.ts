/**
 * Which PartRefs a placed body owns. ONE definition, used by the formboard body
 * label (`C2 [14, 15]` = the BOM items of these parts) and by the picture
 * planner (`primaryPartNumber` names the photo). Model layer: imports schema
 * and anchors only.
 */
import type { HarnessDocument, Id } from './schema'
import { sortedCavities } from './anchors'

export type BodyKind = 'connector' | 'terminal' | 'splice'

export function bodyKindOf(doc: HarnessDocument, id: Id): BodyKind | null {
  if (doc.connectors.some((c) => c.id === id)) return 'connector'
  if (doc.freeTerminals.some((f) => f.id === id)) return 'terminal'
  if (doc.splices.some((s) => s.id === id)) return 'splice'
  return null
}

/** Housing / part first, then contacts, seals and plugs; deduped; empty when unknown. */
export function bodyPartNumbers(doc: HarnessDocument, id: Id): string[] {
  const out: string[] = []
  const push = (pn?: string): void => {
    if (pn && !out.includes(pn)) out.push(pn)
  }
  const c = doc.connectors.find((x) => x.id === id)
  if (c) {
    push(c.housing?.partNumber)
    for (const cv of sortedCavities(c)) {
      push(cv.pin?.partNumber)
      push(cv.seal?.partNumber)
      push(cv.plug?.partNumber)
    }
    return out
  }
  const ft = doc.freeTerminals.find((x) => x.id === id)
  if (ft) {
    push(ft.part?.partNumber)
    push(ft.seal?.partNumber)
    return out
  }
  const sp = doc.splices.find((x) => x.id === id)
  if (sp) push(sp.part?.partNumber)
  return out
}

/** The part a picture is keyed by: connector housing, terminal part, splice part. */
export function primaryPartNumber(doc: HarnessDocument, id: Id): string | undefined {
  return bodyPartNumbers(doc, id)[0]
}
