import { describe, it, expect } from 'vitest'
import { demoDocument } from '@shared/model/document'
import { computeFormboard } from '@shared/model/formboard'
import type { HarnessDocument } from '@shared/model/schema'
import { planBoard } from './board'
import { sheetMm } from './sheet'
import { outsideSheetFindings } from './sheetFindings'

/** The demo plus a splice, a cable placement, a branch point and a label to name. */
function fixture(): HarnessDocument {
  const doc = demoDocument()
  doc.splices.push({ id: 'sp-1', designator: 'SP1', kind: 'butt' })
  doc.cables.push({ id: 'cab-1', name: 'CAN-1', coreWireIds: [] })
  doc.branchPoints.push({ id: 'bp-1', pos: { x: 200, y: 100 } })
  doc.labels.push({
    id: 'lbl-1',
    target: { type: 'branchPoint', branchId: 'bp-1' },
    kind: 'flag',
    text: 'PUMP',
    pos: { x: 200, y: 120 }
  })
  return doc
}

describe('outsideSheetFindings', () => {
  it('maps each outside-sheet kind to one warning finding with a named message and refs', () => {
    const doc = fixture()
    const f = outsideSheetFindings(
      [
        'outside-sheet:body:conn-x1',
        'outside-sheet:body:ft-bplus',
        'outside-sheet:body:sp-1',
        'outside-sheet:body:cab-1',
        'outside-sheet:branch:bp-1',
        'outside-sheet:segment:seg-1',
        'outside-sheet:label:lbl-1',
        'outside-sheet:block:pinout:conn-x1',
        'outside-sheet:block:picture:conn-x2',
        'outside-sheet:block:bom:bom'
      ],
      doc
    )
    expect(f.every((x) => x.ruleId === 'outside-sheet' && x.severity === 'warning')).toBe(true)
    expect(f.map((x) => [x.message, x.refs])).toEqual([
      ['X1 is outside the drawing sheet', [{ kind: 'connector', id: 'conn-x1' }]],
      ['T1 is outside the drawing sheet', [{ kind: 'freeTerminal', id: 'ft-bplus' }]],
      ['SP1 is outside the drawing sheet', [{ kind: 'splice', id: 'sp-1' }]],
      ['CAN-1 is outside the drawing sheet', [{ kind: 'cable', id: 'cab-1' }]],
      ['A branch point is outside the drawing sheet', [{ kind: 'branchPoint', id: 'bp-1' }]],
      ['Segment X1–X2 is outside the drawing sheet', [{ kind: 'segment', id: 'seg-1' }]],
      ['Label "PUMP" is outside the drawing sheet', []],
      ['Pinout table for X1 is outside the drawing sheet', []],
      ['Picture of X2 is outside the drawing sheet', []],
      ['BOM block is outside the drawing sheet', []]
    ])
  })

  it('gives an unknown block kind a generic message, not a pinout one', () => {
    const f = outsideSheetFindings(['outside-sheet:block:legend:conn-x1'], fixture())
    expect(f).toHaveLength(1)
    expect(f[0].message).toBe('Block conn-x1 is outside the drawing sheet')
    expect(f[0].refs).toEqual([])
  })

  it('ignores every other plan warning', () => {
    expect(
      outsideSheetFindings(['table-overlap:conn-x1', 'title-block-over-content', 'table-over-wire:x'], fixture())
    ).toEqual([])
  })

  it('names a dangling id by the id itself rather than dropping the finding', () => {
    const f = outsideSheetFindings(['outside-sheet:body:gone', 'outside-sheet:segment:gone-seg'], fixture())
    expect(f.map((x) => x.message)).toEqual([
      'gone is outside the drawing sheet',
      'Segment gone-seg is outside the drawing sheet'
    ])
  })

  it('end to end: a body dragged 1 m off a pinned sheet is reported by the real planner', () => {
    const doc = demoDocument()
    doc.drawing.sheetOrigin = { x: 0, y: 0 }
    doc.placements.find((p) => p.refId === 'conn-x2')!.pos.x += 1000
    const plan = planBoard(doc, sheetMm(doc.drawing.sheet), computeFormboard(doc))
    const msgs = outsideSheetFindings(plan.warnings, doc).map((x) => x.message)
    expect(msgs).toContain('X2 is outside the drawing sheet')
    expect(msgs).toContain('Segment X1–X2 is outside the drawing sheet')
  })
})
