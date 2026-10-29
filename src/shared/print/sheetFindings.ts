import type { EntityRef, Finding } from '../drc/types'
import type { HarnessDocument, Id, RouteNode } from '../model/schema'

/** `ruleId` of every finding below. */
export const OUTSIDE_SHEET_RULE = 'outside-sheet'

const PREFIX = 'outside-sheet:'

/** A placed body's display name and DRC ref kind, or null when no body has that id. */
function bodyOf(doc: HarnessDocument, id: Id): { name: string; ref: EntityRef } | null {
  const c = doc.connectors.find((x) => x.id === id)
  if (c) return { name: c.designator, ref: { kind: 'connector', id } }
  const t = doc.freeTerminals.find((x) => x.id === id)
  if (t) return { name: t.designator, ref: { kind: 'freeTerminal', id } }
  const s = doc.splices.find((x) => x.id === id)
  if (s) return { name: s.designator, ref: { kind: 'splice', id } }
  const cab = doc.cables.find((x) => x.id === id)
  if (cab) return { name: cab.name, ref: { kind: 'cable', id } }
  return null
}

const nameOf = (doc: HarnessDocument, id: Id): string => bodyOf(doc, id)?.name ?? id

const nodeName = (doc: HarnessDocument, n: RouteNode): string =>
  n.type === 'body' ? nameOf(doc, n.refId) : 'branch point'

/**
 * `planBoard`'s `outside-sheet:` warnings as DRC findings — one `warning` per
 * item that would be cut off the one printed sheet (spec §1: flagged, not
 * accommodated). Every other plan warning is ignored here; an id that no
 * longer resolves is named by the id itself rather than dropped, so a finding
 * never silently disappears.
 *
 * Codes (see `BoardPlan.warnings`): `body` / `branch` / `segment` / `label`
 * `:<id>`, and `block:<pinout|picture|bom|tolerance>:<id>`. Bodies, branch points and
 * segments carry a ref so the DRC panel can jump to them; labels and blocks
 * are not DRC entities and carry none.
 */
export function outsideSheetFindings(warnings: string[], doc: HarnessDocument): Finding[] {
  const out: Finding[] = []
  const add = (subject: string, refs: EntityRef[]): void => {
    out.push({
      ruleId: OUTSIDE_SHEET_RULE,
      severity: 'warning',
      message: `${subject} is outside the drawing sheet`,
      refs
    })
  }
  for (const w of warnings) {
    if (!w.startsWith(PREFIX)) continue
    const rest = w.slice(PREFIX.length)
    const colon = rest.indexOf(':')
    const kind = rest.slice(0, colon)
    const id = rest.slice(colon + 1)
    switch (kind) {
      case 'body': {
        const b = bodyOf(doc, id)
        add(b?.name ?? id, b ? [b.ref] : [])
        break
      }
      case 'branch':
        add('A branch point', [{ kind: 'branchPoint', id }])
        break
      case 'segment': {
        const seg = doc.segments.find((s) => s.id === id)
        add(
          seg ? `Segment ${nodeName(doc, seg.from)}–${nodeName(doc, seg.to)}` : `Segment ${id}`,
          [{ kind: 'segment', id }]
        )
        break
      }
      case 'label': {
        const l = doc.labels.find((x) => x.id === id)
        add(l ? `Label "${l.text}"` : `Label ${id}`, [])
        break
      }
      case 'block': {
        const c2 = id.indexOf(':')
        const blockKind = id.slice(0, c2)
        const refId = id.slice(c2 + 1)
        if (blockKind === 'bom') add('BOM block', [])
        else if (blockKind === 'tolerance') add('Length tolerance table', [])
        else if (blockKind === 'picture') add(`Picture of ${nameOf(doc, refId)}`, [])
        else if (blockKind === 'pinout') add(`Pinout table for ${nameOf(doc, refId)}`, [])
        else add(`Block ${refId}`, [])
        break
      }
    }
  }
  return out
}
