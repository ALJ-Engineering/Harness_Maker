import { describe, it, expect } from 'vitest'
import { documentToFormboard } from './toFormboard'
import { documentToFlow } from './toFlow'
import type { BlockNodeData, SheetNodeData } from './toFlow'
import { planBoard, TABLE_PAD } from '@shared/print/board'
import { sheetMm } from '@shared/print/sheet'
import { renderTable, TABLE_STYLE_SHEET } from '@shared/print/tables'
import { renderBoardPage } from '@shared/print/template'
import { computeFormboard } from '@shared/model/formboard'
import { demoDocument, emptyDocument } from '@shared/model/document'
import type { HarnessDocument } from '@shared/model/schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal two-connector doc with one routed wire, wired for formboard tests. */
function doc2(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    {
      id: 'c1',
      designator: 'X1',
      cavities: [
        { id: 'a', position: '1', status: 'populated' },
        { id: 'b', position: '2', status: 'populated' }
      ]
    },
    { id: 'c2', designator: 'X2', cavities: [{ id: 'z', position: 'A', status: 'populated' }] }
  ]
  d.placements = [
    { refId: 'c1', pos: { x: 0, y: 0 } },
    { refId: 'c2', pos: { x: 200, y: 0 } }
  ]
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'a' },
        { type: 'cavity', cavityId: 'z' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' }
    }
  ]
  d.segments = [
    {
      id: 's1',
      from: { type: 'body', refId: 'c1' },
      to: { type: 'body', refId: 'c2' }
    }
  ]
  d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }]
  return d
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('documentToFormboard', () => {
  it('every body is a formboardBody node centred on its dot with handle n:<refId>', () => {
    const d = demoDocument()
    const { nodes } = documentToFormboard(d)
    // Only connectors, free terminals and splices are DRAWN bodies. A cable is
    // also placeable (it anchors a shield) but has no glyph — see the cable test
    // below — so state that here rather than leaning on the demo having none.
    const bodyIds = new Set<string>([
      ...d.connectors.map((c) => c.id),
      ...d.freeTerminals.map((f) => f.id),
      ...d.splices.map((x) => x.id)
    ])
    const placed = d.placements.filter((p) => bodyIds.has(p.refId))
    expect(placed.length).toBeGreaterThan(0)
    for (const p of placed) {
      const n = nodes.find((x) => x.id === p.refId)!
      expect(n.type).toBe('formboardBody')
      expect(n.position).toEqual(p.pos)
      expect(n.origin).toEqual([0.5, 0.5])
      expect((n.data as { handleId: string }).handleId).toBe(`n:${p.refId}`)
      expect(n.deletable).toBe(false)
    }
    // The old per-cavity connector node is gone (cast: the union no longer names it).
    expect(nodes.some((n) => (n.type as string) === 'formboardConnector')).toBe(false)
  })

  it('a segment edge connects body nodes by their body handles', () => {
    const d = demoDocument()
    const seg = d.segments.find((s) => s.from.type === 'body' && s.to.type === 'body')!
    const { edges } = documentToFormboard(d)
    const e = edges.find((x) => x.id === seg.id)!
    expect(e.source).toBe((seg.from as { refId: string }).refId)
    expect(e.sourceHandle).toBe(`n:${(seg.from as { refId: string }).refId}`)
    expect(e.targetHandle).toBe(`n:${(seg.to as { refId: string }).refId}`)
  })

  it('a PLACED CABLE gets no node and its segment gets no edge (no drawn body)', () => {
    // A cable is placeable — it anchors a shield endpoint — but `computeFormboard`
    // draws no body for it, so `nodeRef` must refuse it rather than emit an edge
    // pointing at a node that does not exist.
    const d = doc2()
    d.cables = [{ id: 'cab', name: 'CAN', coreWireIds: [], shield: { present: true } }]
    d.placements.push({ refId: 'cab', pos: { x: 100, y: 80 } })
    d.segments.push({
      id: 's-cab',
      from: { type: 'body', refId: 'cab' },
      to: { type: 'body', refId: 'c1' }
    })
    const { nodes, edges } = documentToFormboard(d)
    expect(nodes.find((n) => n.id === 'cab')).toBeUndefined()
    expect(edges.find((e) => e.id === 's-cab')).toBeUndefined()
    // The connector's own limb is unaffected.
    expect(edges.find((e) => e.id === 's1')).toBeDefined()
  })

  it('single-wire segment edge has type formboardSegment with colour set and bundle false', () => {
    const { edges } = documentToFormboard(doc2())
    const e = edges.find((x) => x.id === 's1')!
    expect(e).toBeDefined()
    expect(e.type).toBe('formboardSegment')
    expect(e.data!.bundle).toBe(false)
    expect(e.data!.colour).toBe('RD')
  })

  it('segment edge id equals the segment id (branch insert still resolves)', () => {
    const { edges } = documentToFormboard(doc2())
    // The formboard click-to-insert handler uses edge.id === segment id
    expect(edges.find((e) => e.id === 's1')).toBeDefined()
  })

  it('shared segment (two wires) has bundle true and no colour', () => {
    const d = doc2()
    d.wires.push({
      id: 'w2',
      ends: [
        { type: 'cavity', cavityId: 'b' },
        { type: 'cavity', cavityId: 'z' }
      ],
      gauge: { value: 1, unit: 'mm2' },
      color: { base: 'BK' }
    })
    d.wireRoutes.push({ wireId: 'w2', path: ['s1'] }) // both wires share s1
    const { edges } = documentToFormboard(d)
    const e = edges.find((x) => x.id === 's1')!
    expect(e.data!.bundle).toBe(true)
    expect(e.data!.colour).toBeUndefined()
  })

  it('places a branch node at its branch-point position', () => {
    const d = demoDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 50, y: 60 } }]
    const n = documentToFormboard(d).nodes.find((x) => x.id === 'bp1')!
    expect(n.position).toEqual({ x: 50, y: 60 })
  })

  it('renders a branch node for a branch point, and a segment edge connecting it', () => {
    const d = demoDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 180, y: 120 } }]
    d.segments.push({
      id: 'segx',
      from: { type: 'branch', branchId: 'bp1' },
      to: { type: 'body', refId: 'conn-x2' }
    })
    const { nodes, edges } = documentToFormboard(d)
    expect(nodes.some((n) => n.type === 'branch' && n.id === 'bp1')).toBe(true)
    // a segment edge connects bp1 to X2's body dot
    const e = edges.find((x) => x.id === 'segx')!
    expect(e.source).toBe('bp1')
    expect(e.target).toBe('conn-x2')
    expect(e.targetHandle).toBe('n:conn-x2')
  })

  it('unplaced connector is excluded from nodes', () => {
    const d = doc2()
    // Remove placement for c2
    d.placements = d.placements.filter((p) => p.refId !== 'c2')
    const { nodes } = documentToFormboard(d)
    expect(nodes.find((n) => n.id === 'c2')).toBeUndefined()
  })

  it('segment with unplaced endpoint is excluded from edges', () => {
    const d = doc2()
    d.placements = d.placements.filter((p) => p.refId !== 'c2')
    const { edges } = documentToFormboard(d)
    // s1 goes c1→c2, c2 is unplaced so c2 has no node → no FbSegment for s1 → edge excluded
    expect(edges.find((e) => e.id === 's1')).toBeUndefined()
  })

  it('segment edge data.lengthMm is the dot-to-dot distance', () => {
    // doc2: c1 at (0,0), c2 at (200,0). A body's anchor IS its placement dot,
    // so the drawn line and the measured length are both a flat 200 mm.
    const { edges } = documentToFormboard(doc2())
    const e = edges.find((x) => x.id === 's1')!
    expect(e.data!.lengthMm).not.toBeNull()
    expect(e.data!.lengthMm as number).toBeCloseTo(200, 9)
  })

  it('a typed, broken segment edge carries broken, specifiedLengthMm, segmentId, and lengthMm = typed', () => {
    const d = doc2()
    d.segments[0].specifiedLengthMm = 250 // drawn 200
    const e = documentToFormboard(d).edges.find((x) => x.id === 's1')!
    expect(e.data!.broken).toBe(true)
    expect(e.data!.specifiedLengthMm).toBe(250)
    expect(e.data!.lengthMm).toBe(250)
    expect(e.data!.segmentId).toBe('s1')
    // React Flow source is the segment's FROM node, target its TO node — the
    // rescale arrows map 'to' ↔ target on this.
    expect(e.source).toBe('c1')
    expect(e.target).toBe('c2')
  })

  it('a broken segment edge says whether the typed length is shorter than the drawn one', () => {
    const longer = doc2()
    longer.segments[0].specifiedLengthMm = 250 // drawn 200 → arrows point outward
    expect(documentToFormboard(longer).edges.find((x) => x.id === 's1')!.data!.shrink).toBe(false)
    const shorter = doc2()
    shorter.segments[0].specifiedLengthMm = 150 // drawn 200 → arrows point inward
    expect(documentToFormboard(shorter).edges.find((x) => x.id === 's1')!.data!.shrink).toBe(true)
    expect(documentToFormboard(doc2()).edges.find((x) => x.id === 's1')!.data!.shrink).toBe(false)
  })

  it('an untyped segment edge has broken false, no specifiedLengthMm, lengthMm = drawn', () => {
    const e = documentToFormboard(doc2()).edges.find((x) => x.id === 's1')!
    expect(e.data!.broken).toBe(false)
    expect(e.data!.specifiedLengthMm).toBeUndefined()
    expect(e.data!.lengthMm as number).toBeCloseTo(200, 9)
  })

  it('a typed segment within tolerance is not broken, and shows the typed value', () => {
    const d = doc2()
    d.segments[0].specifiedLengthMm = 200.3
    const e = documentToFormboard(d).edges.find((x) => x.id === 's1')!
    expect(e.data!.broken).toBe(false)
    expect(e.data!.lengthMm).toBe(200.3)
  })

  it('degree-2 branch node has deletable === true', () => {
    // Build a doc with a branch point referenced by exactly 2 segments.
    const d = demoDocument()
    d.branchPoints = [{ id: 'bp-deg2', pos: { x: 100, y: 100 } }]
    // Two segments: both reference bp-deg2 (one from, one to).
    d.segments = [
      {
        id: 'seg-deg2-a',
        from: { type: 'branch', branchId: 'bp-deg2' },
        to: { type: 'body', refId: 'conn-x1' }
      },
      {
        id: 'seg-deg2-b',
        from: { type: 'body', refId: 'conn-x2' },
        to: { type: 'branch', branchId: 'bp-deg2' }
      }
    ]
    const { nodes } = documentToFormboard(d)
    const n = nodes.find((x) => x.id === 'bp-deg2')!
    expect(n).toBeDefined()
    expect(n.deletable).toBe(true)
  })

  it('a bend with a SELF-LOOP limb is NOT deletable (session-10 nit)', () => {
    const d = demoDocument()
    d.branchPoints = [{ id: 'bp-loop', pos: { x: 100, y: 100 } }]
    d.segments = [
      {
        id: 'seg-loop',
        from: { type: 'branch', branchId: 'bp-loop' },
        to: { type: 'branch', branchId: 'bp-loop' }
      },
      {
        id: 'seg-real',
        from: { type: 'branch', branchId: 'bp-loop' },
        to: { type: 'body', refId: 'conn-x1' }
      }
    ]
    const { nodes } = documentToFormboard(d)
    const n = nodes.find((x) => x.id === 'bp-loop')!
    expect(n).toBeDefined()
    expect(n.deletable).toBe(false)
  })

  it('degree-3 branch node has deletable === false', () => {
    // Build a doc with a branch point referenced by 3 segments (Y-split).
    const d = demoDocument()
    d.branchPoints = [{ id: 'bp-deg3', pos: { x: 100, y: 100 } }]
    d.segments = [
      {
        id: 'seg-deg3-a',
        from: { type: 'branch', branchId: 'bp-deg3' },
        to: { type: 'body', refId: 'conn-x1' }
      },
      {
        id: 'seg-deg3-b',
        from: { type: 'branch', branchId: 'bp-deg3' },
        to: { type: 'body', refId: 'conn-x2' }
      },
      {
        id: 'seg-deg3-c',
        from: { type: 'body', refId: 'conn-x2' },
        to: { type: 'branch', branchId: 'bp-deg3' }
      }
    ]
    const { nodes } = documentToFormboard(d)
    const n = nodes.find((x) => x.id === 'bp-deg3')!
    expect(n).toBeDefined()
    expect(n.deletable).toBe(false)
  })

  it('projects a label to a draggable label node at its pos', () => {
    const d = doc2()
    d.labels = [
      {
        id: 'lb1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'wireMarker',
        text: 'CAN-H',
        pos: { x: 12, y: 34 }
      }
    ]
    const { nodes } = documentToFormboard(d)
    const ln = nodes.find((n) => n.id === 'lb1')
    expect(ln?.type).toBe('label')
    expect(ln?.position).toEqual({ x: 12, y: 34 })
    expect(ln?.deletable).toBe(false)
    expect((ln?.data as { display: string }).display).toBe('Wire marker: CAN-H')
  })
})

// ---------------------------------------------------------------------------
// Board furniture: the drawing sheet, the pinout tables and the BOM block.
// The canvas draws the SAME plan the PDF prints (spec §5), so these assertions
// compare the projection against `planBoard` directly rather than restating it.
// ---------------------------------------------------------------------------

describe('board furniture', () => {
  it('emits one non-draggable sheet node at the plan origin, one table per connector body, one BOM block', () => {
    const d = demoDocument()
    const plan = planBoard(d, sheetMm(d.drawing.sheet))
    const { nodes } = documentToFormboard(d)
    const sheet = nodes.find((n) => n.type === 'formboardSheet')!
    expect(sheet.id).toBe('__sheet')
    expect(sheet.draggable).toBe(false)
    expect(sheet.selectable).toBe(false)
    expect(sheet.position).toEqual(plan.contentOrigin)
    const tables = nodes.filter((n) => n.type === 'pinoutTable')
    expect(tables.map((n) => n.id).sort()).toEqual(plan.tables.map((t) => `tbl:${t.id}`).sort())
    for (const t of plan.tables)
      expect(nodes.find((n) => n.id === `tbl:${t.id}`)!.position).toEqual({ x: t.rect.x, y: t.rect.y })
    const bom = nodes.find((n) => n.type === 'bomBlock')!
    expect(bom.id).toBe('__bom')
    expect(bom.position).toEqual({ x: plan.bom.rect.x, y: plan.bom.rect.y })
    expect(nodes.indexOf(sheet)).toBe(0) // drawn first → underneath
  })

  it('with drawing.sheetOrigin set, the sheet node sits there and does not move when a body is dragged', () => {
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: -40, y: -25 }
    const at = (doc: HarnessDocument) =>
      documentToFormboard(doc).nodes.find((n) => n.type === 'formboardSheet')!
    expect(at(d).position).toEqual({ x: -40, y: -25 })
    const titleBefore = (at(d).data as SheetNodeData).titleBlock
    // Drag X1 well up and left — before the fixed sheet this re-framed the page.
    d.placements.find((p) => p.refId === 'conn-x1')!.pos = { x: -900, y: -600 }
    expect(at(d).position).toEqual({ x: -40, y: -25 })
    const titleAfter = (at(d).data as SheetNodeData).titleBlock
    expect([titleAfter.x, titleAfter.y]).toEqual([titleBefore.x, titleBefore.y])
    expect((at(d).data as SheetNodeData).warnings).toContain('outside-sheet:body:conn-x1')
  })

  it('changing the paper grows the sheet right and down from the pinned top-left', () => {
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: 10, y: 20 }
    const sheetOf = (doc: HarnessDocument) =>
      documentToFormboard(doc).nodes.find((n) => n.type === 'formboardSheet')!
    const a4 = sheetOf(d)
    d.drawing.sheet = { paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 }
    const plot = sheetOf(d)
    expect(plot.position).toEqual(a4.position)
    expect((plot.data as SheetNodeData).printable.w).toBeGreaterThan((a4.data as SheetNodeData).printable.w)
  })

  it('a pinned table reports pinned:true and sits at its pin', () => {
    const d = demoDocument()
    const id = d.connectors[0].id
    d.drawing.blocks = { pinout: { [id]: { x: 7, y: 9 } } }
    const n = documentToFormboard(d).nodes.find((x) => x.id === `tbl:${id}`)!
    expect(n.position).toEqual({ x: 7, y: 9 })
    expect((n.data as { pinned: boolean }).pinned).toBe(true)
  })

  it('a pinned FREE-TERMINAL table pins too — connectorPinouts emits one per terminal', () => {
    const d = demoDocument()
    const id = d.freeTerminals[0].id
    // Sanity: the demo really does have a free-terminal pinout to pin.
    expect(documentToFormboard(d).nodes.some((n) => n.id === `tbl:${id}`)).toBe(true)
    d.drawing.blocks = { pinout: { [id]: { x: 21, y: 22 } } }
    const n = documentToFormboard(d).nodes.find((x) => x.id === `tbl:${id}`)!
    expect(n.position).toEqual({ x: 21, y: 22 })
    expect((n.data as { pinned: boolean }).pinned).toBe(true)
  })

  it('schematic projection has none of it', () => {
    const { nodes } = documentToFlow(demoDocument())
    expect(nodes.some((n) => ['formboardSheet', 'pinoutTable', 'bomBlock'].includes(n.type!))).toBe(false)
  })

  it('carries the one sheet at contentOrigin, the title block relative to it, and the plan warnings', () => {
    const d = demoDocument()
    const plan = planBoard(d, sheetMm(d.drawing.sheet))
    const sheet = documentToFormboard(d).nodes.find((n) => n.type === 'formboardSheet')!
    const data = sheet.data as SheetNodeData
    expect(sheet.position).toEqual(plan.contentOrigin)
    expect(data.printable).toEqual(plan.printable)
    expect(Object.keys(data).sort()).toEqual(['printable', 'titleBlock', 'warnings'])
    // Title block position is NODE-LOCAL: the node sits at contentOrigin.
    expect(data.titleBlock.x).toBeCloseTo(plan.titleBlockRect.x - plan.contentOrigin.x, 9)
    expect(data.titleBlock.y).toBeCloseTo(plan.titleBlockRect.y - plan.contentOrigin.y, 9)
    expect(data.titleBlock.svg).toContain('<g class="title-block">')
    expect(data.warnings).toEqual(plan.warnings)
  })

  it('renders block SVG at the same offsets print uses, and never lets furniture be deleted', () => {
    const d = demoDocument()
    const plan = planBoard(d, sheetMm(d.drawing.sheet))
    const { nodes } = documentToFormboard(d)
    const t0 = plan.tables[0]
    const tn = nodes.find((n) => n.id === `tbl:${t0.id}`)!
    const td = tn.data as BlockNodeData
    expect(td.kind).toBe('pinout')
    expect(td.refId).toBe(t0.id)
    expect(td.w).toBe(t0.rect.w)
    expect(td.h).toBe(t0.rect.h)
    expect(td.pinned).toBe(false)
    // WYSIWYG: identical markup to print, at the pinout inner offset TABLE_PAD / 2.
    expect(td.svg).toBe(
      renderTable(TABLE_PAD / 2, 0, t0.spec!.cols, t0.spec!.rows, TABLE_STYLE_SHEET, { title: t0.title }).svg
    )
    const bn = nodes.find((n) => n.id === '__bom')!
    const bd = bn.data as BlockNodeData
    expect(bd.kind).toBe('bom')
    expect(bd.svg).toBe(
      renderTable(0, 0, plan.bom.spec!.cols, plan.bom.spec!.rows, TABLE_STYLE_SHEET, { title: plan.bom.title }).svg
    )
    for (const id of ['__sheet', '__bom', `tbl:${t0.id}`])
      expect(nodes.find((n) => n.id === id)!.deletable).toBe(false)
  })

  it('a body with a part image gets a pictureBlock node whose SVG IS the printed one', () => {
    const d = demoDocument()
    const id = d.connectors[0].id
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    const images = { 'HSG-A': { href: 'parts-image://img/HSG-A', pxW: 400, pxH: 300 } }
    const sheet = sheetMm(d.drawing.sheet)
    const layout = computeFormboard(d)
    const plan = planBoard(d, sheet, layout, images)
    const pic = plan.pictures[0]
    expect(pic).toBeDefined()

    const { nodes } = documentToFormboard(d, {}, images)
    const n = nodes.find((x) => x.id === `pic:${id}`)!
    expect(n).toBeDefined()
    expect(n.type).toBe('pictureBlock')
    expect(n.position).toEqual({ x: pic.rect.x, y: pic.rect.y })
    expect(n.deletable).toBe(false)
    const data = n.data as BlockNodeData
    expect(data.kind).toBe('picture')
    expect(data.refId).toBe(id)
    expect(data.w).toBe(pic.rect.w)
    expect(data.h).toBe(pic.rect.h)
    expect(data.pinned).toBe(false)

    // WYSIWYG: the canvas string is byte-for-byte the group the page prints.
    const page = renderBoardPage(d, plan, {}, layout, { pageNoStart: 1, pageCount: 1 }).svg
    const open = `data-block="picture:${id}"`
    const bodyStart = page.indexOf('>', page.indexOf(open)) + 1
    const bodyEnd = page.indexOf('</g></g>', bodyStart) + '</g>'.length
    expect(bodyStart).toBeGreaterThan(0)
    expect(data.svg).toBe(page.slice(bodyStart, bodyEnd))
  })

  it('a ROTATED + FLIPPED picture node is still byte-for-byte the printed group', () => {
    const d = demoDocument()
    const id = d.connectors[0].id
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    d.drawing.blocks = { pictureView: { [id]: { rotationDeg: 90, flipH: true } } }
    const images = { 'HSG-A': { href: 'parts-image://img/HSG-A', pxW: 400, pxH: 300 } }
    const sheet = sheetMm(d.drawing.sheet)
    const layout = computeFormboard(d)
    const plan = planBoard(d, sheet, layout, images)

    const data = documentToFormboard(d, {}, images).nodes.find((x) => x.id === `pic:${id}`)!
      .data as BlockNodeData
    expect(data.svg).toContain('rotate(90) scale(-1 1)')

    const page = renderBoardPage(d, plan, {}, layout, { pageNoStart: 1, pageCount: 1 }).svg
    const open = `data-block="picture:${id}"`
    const bodyStart = page.indexOf('>', page.indexOf(open)) + 1
    const bodyEnd = page.indexOf('</g></g>', bodyStart) + '</g>'.length
    expect(bodyStart).toBeGreaterThan(0)
    expect(data.svg).toBe(page.slice(bodyStart, bodyEnd))
  })

  it('no images ⇒ no picture nodes (the default projection is unchanged)', () => {
    const d = demoDocument()
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    const { nodes } = documentToFormboard(d)
    expect(nodes.some((n) => n.type === 'pictureBlock')).toBe(false)
  })

  it('a pinned picture reports pinned:true and sits at its pin', () => {
    const d = demoDocument()
    const id = d.connectors[0].id
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    d.drawing.blocks = { picture: { [id]: { x: 41, y: 42 } } }
    const images = { 'HSG-A': { href: 'parts-image://img/HSG-A', pxW: 400, pxH: 300 } }
    const n = documentToFormboard(d, {}, images).nodes.find((x) => x.id === `pic:${id}`)!
    expect(n.position).toEqual({ x: 41, y: 42 })
    expect((n.data as BlockNodeData).pinned).toBe(true)
  })
})
