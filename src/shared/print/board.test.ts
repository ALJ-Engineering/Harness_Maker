import { describe, it, expect } from 'vitest'
import {
  planBoard,
  bodyRect,
  bodyLabelRect,
  TABLE_GAP,
  printableSize,
  BOM_BLOCK_ID,
  TOLERANCE_BLOCK_ID,
  TEMPLATE_GUTTER,
  BOM_BLOCK_MAX_W_FRAC,
  BOM_BLOCK_MAX_H_FRAC,
  WIRE_CLEARANCE,
  framedSheetOrigin,
  type BoardPlan
} from './board'
import { pictureBlockSize, PICTURE_CAPTION_H, PICTURE_MAX_H } from './picture'
import { demoDocument, emptyDocument } from '../model/document'
import { sheetMm, type Rect } from './sheet'
import {
  computeFormboard,
  runLabel,
  MIN_FONT,
  LABEL_FONT,
  BODY_DOT_R,
  BODY_LABEL_OFFSET,
  type FbBody,
  type FbLayout,
  type FbSegment
} from '../model/formboard'
import { connectorPinouts } from './tableData'
import { TITLE_BLOCK_W, TITLE_BLOCK_H } from './titleBlock'
import { estimateTextWidthMm } from './text'
import type { HarnessDocument, Vec2 } from '../model/schema'
import { DEFAULT_TOLERANCE_TITLE, IPC_620_LENGTH_TOLERANCE } from '../model/schema'

const A3 = sheetMm({ paper: 'A3', orientation: 'landscape' })
const A4 = sheetMm({ paper: 'A4', orientation: 'landscape' })
const inter = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * The demo harness carries no `PartRef`s at all, so its BOM is empty. This adds
 * `n` distinct BOM lines by giving `n` extra connectors a distinct housing part
 * number each. They have no placement, so `connectorLayout` returns null → no
 * body, no pinout, no table: only the BOM block grows.
 */
function withBomLines(n: number): ReturnType<typeof demoDocument> {
  const d = demoDocument()
  for (let i = 0; i < n; i++) {
    d.connectors.push({
      id: `bom-filler-${i}`,
      designator: `Z${i}`,
      cavities: [],
      housing: { partNumber: `PN-${String(i).padStart(3, '0')}`, manufacturer: 'ACME' }
    })
  }
  return d
}

describe('planBoard', () => {
  it('is deterministic and places one table per drawn pinout body', () => {
    const d = demoDocument()
    const p1 = planBoard(d, A3)
    const p2 = planBoard(d, A3)
    expect(p1).toEqual(p2)
    // The plan carries its own paper: `printable` and `sheetRect` are derived
    // from it, so a renderer can never be handed a sheet that disagrees.
    expect(p1.sheet).toEqual(A3)
    expect(p1.printable).toEqual(printableSize(A3))
    // One table per PINOUT that has a body to sit beside — connectors AND free
    // terminals (the demo's B+ ring lug gets a pinout too, which is why this is
    // not `bodies.filter(kind === 'connector')`).
    const layout = computeFormboard(d)
    const drawn = connectorPinouts(d).filter((p) => layout.bodies.some((b) => b.id === p.nodeId))
    expect(drawn.length).toBe(3)
    expect(p1.tables.length).toBe(drawn.length)
    expect(p1.tables.map((t) => t.id)).toEqual(drawn.map((p) => p.nodeId))
    for (const t of p1.tables) expect(t.pinned).toBe(false)
  })

  it('a body is an obstacle as its dot rect (± BODY_DOT_R) and its label rect', () => {
    const b: FbBody = { id: 'x', kind: 'connector', pos: { x: 100, y: 50 }, label: 'X1 [1]', labelPos: { x: 103, y: 46.5 } }
    // The fixture's labelPos is exactly where computeFormboard puts it.
    expect(b.labelPos).toEqual({ x: b.pos.x + BODY_LABEL_OFFSET.x, y: b.pos.y + BODY_LABEL_OFFSET.y })
    expect(bodyRect(b)).toEqual({ x: 100 - BODY_DOT_R, y: 50 - BODY_DOT_R, w: 2 * BODY_DOT_R, h: 2 * BODY_DOT_R })
    expect(bodyLabelRect(b)).toEqual({
      x: 103,
      y: 46.5 - LABEL_FONT / 2,
      w: estimateTextWidthMm('X1 [1]', LABEL_FONT),
      h: LABEL_FONT
    })
  })

  it('an auto-placed pinout table prefers the side of its dot AWAY from the incident segment', () => {
    const d = emptyDocument()
    d.connectors.push({ id: 'c1', designator: 'X1', cavities: [{ id: 'a', position: '1', status: 'populated' }] })
    d.freeTerminals.push({ id: 'ft1', designator: 'T1', kind: 'ring' })
    d.placements.push({ refId: 'c1', pos: { x: 0, y: 0 } }, { refId: 'ft1', pos: { x: 400, y: 0 } })
    d.wires.push({ id: 'w1', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'freeTerminal', terminalId: 'ft1' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'RD' } })
    d.segments.push({ id: 's1', from: { type: 'body', refId: 'c1' }, to: { type: 'body', refId: 'ft1' } })
    d.wireRoutes.push({ wireId: 'w1', path: ['s1'] })
    // A sheet with room on both outer sides, so neither away-side spot is
    // rejected for falling off the paper.
    d.drawing.sheetOrigin = { x: -200, y: -200 }
    const p = planBoard(d, sheetMm({ paper: 'A1', orientation: 'landscape' }))
    const tX1 = p.tables.find((t) => t.id === 'c1')!
    const tFt = p.tables.find((t) => t.id === 'ft1')!
    // X1's wire goes +x, so its table sits to the LEFT of the dot; the lug's goes −x → table to the RIGHT.
    expect(tX1.rect.x + tX1.rect.w).toBeLessThanOrEqual(0)
    expect(tFt.rect.x).toBeGreaterThanOrEqual(400)
  })

  it('a pinned table is used verbatim and is an obstacle for the others', () => {
    const d = demoDocument()
    const [a, b] = d.connectors.map((c) => c.id)
    const auto = planBoard(d, A3)
    const tb = auto.tables.find((t) => t.id === b)!
    // Pin A exactly where B would have gone → B must move.
    d.drawing.blocks = { pinout: { [a]: { x: tb.rect.x, y: tb.rect.y } } }
    const p = planBoard(d, A3)
    const ta = p.tables.find((t) => t.id === a)!
    expect(ta.pinned).toBe(true)
    expect(ta.rect.x).toBe(tb.rect.x)
    expect(ta.rect.y).toBe(tb.rect.y)
    const tb2 = p.tables.find((t) => t.id === b)!
    expect(inter(ta.rect, tb2.rect)).toBe(false)
  })

  it('a stale pin is ignored', () => {
    const d = demoDocument()
    d.drawing.blocks = { pinout: { ghost: { x: 0, y: 0 } } }
    expect(planBoard(d, A3).tables.every((t) => t.id !== 'ghost')).toBe(true)
  })

  it('BOM block defaults below the harness and pins when asked', () => {
    const d = demoDocument()
    const p = planBoard(d, A3)
    const bb = computeFormboard(d).bbox
    expect(p.bom.id).toBe(BOM_BLOCK_ID)
    expect(p.bom.rect.x).toBeCloseTo(bb.minX, 6)
    expect(p.bom.rect.y).toBeGreaterThanOrEqual(bb.maxY + TABLE_GAP - 1e-9)
    expect(p.bom.pinned).toBe(false)
    d.drawing.blocks = { bom: { x: -500, y: -500 } }
    const q = planBoard(d, A3)
    expect(q.bom.pinned).toBe(true)
    expect(q.bom.rect.x).toBe(-500)
  })

  it("truncates a long BOM block to the sheet's printable area, and says so", () => {
    const pr = printableSize(A4)

    // Short BOM: fits, so nothing is dropped and nothing claims to be.
    const short = planBoard(withBomLines(3), A4).bom
    expect(short.truncated).toBe(false)
    expect(short.spec!.rows.length).toBe(3)
    expect(short.spec!.rows.some((r) => r.type === 'see BOM page')).toBe(false)
    // The demo document has no parts at all — an empty BOM is not "truncated".
    expect(planBoard(demoDocument(), A4).bom.truncated).toBe(false)

    // Long BOM: rows are dropped, the last one says where the rest went, and the
    // block is held inside its fraction of the sheet's printable area — the 1:1
    // basis, where it used to be the whole fit-to-sheet page.
    const long = planBoard(withBomLines(60), A4).bom
    expect(long.truncated).toBe(true)
    expect(long.spec!.rows.length).toBeLessThan(60)
    expect(long.spec!.rows[long.spec!.rows.length - 1].type).toBe('see BOM page')
    expect(long.rect.h).toBeLessThanOrEqual(pr.h * BOM_BLOCK_MAX_H_FRAC)
    // Width narrowing is real here: the natural sheet-BOM (129 mm) is wider than
    // 45 % of A4 landscape's 281 mm printable, so the columns were squeezed to
    // land exactly ON the cap. `narrowed = wMm * maxW / natural` is applied per
    // column and then re-summed, so the total can miss the cap by ~1e-14 of
    // float noise — hence the epsilon on the bound and toBeCloseTo for the rest.
    expect(long.rect.w).toBeLessThanOrEqual(pr.w * BOM_BLOCK_MAX_W_FRAC + 1e-9)
    expect(long.rect.w).toBeCloseTo(pr.w * BOM_BLOCK_MAX_W_FRAC, 6)
    expect(long.title).toBe('Bill of Materials')
  })

  it("title block sits at the sheet's bottom-right printable corner", () => {
    for (const sheet of [sheetMm({ paper: 'A1', orientation: 'landscape' }), A4]) {
      const p = planBoard(demoDocument(), sheet)
      const pr = printableSize(sheet)
      expect(p.sheetRect).toEqual({ ...p.contentOrigin, w: pr.w, h: pr.h })
      expect(p.titleBlockRect.w).toBe(TITLE_BLOCK_W)
      expect(p.titleBlockRect.h).toBe(TITLE_BLOCK_H)
      expect(p.titleBlockRect.x).toBeCloseTo(p.sheetRect.x + pr.w - TITLE_BLOCK_W, 6)
      expect(p.titleBlockRect.y).toBeCloseTo(p.sheetRect.y + pr.h - TITLE_BLOCK_H, 6)
    }
  })

  it('an unpinned table never lands on the title block, a pinned one warns', () => {
    const A1 = sheetMm({ paper: 'A1', orientation: 'landscape' })
    const pr = printableSize(A1)
    const d = demoDocument()
    const id = d.connectors[0].id

    // Control: an auto table takes its FIRST-CHOICE spot — TABLE_GAP clear of
    // the dot's edge on the side AWAY from its wires, vertically centred on the
    // dot. X1's two limbs both run +x (to X2 and to the B+ lug), so the away
    // side is 'left'. The two assertions below anchor that formula, which the
    // title-block check then uses to prove the table was kept off it. The
    // control sheet is moved left so that spot is on the paper.
    const p0 = planBoard({ ...d, drawing: { ...d.drawing, sheetOrigin: { x: -200, y: 0 } } }, A1)
    const t0 = p0.tables.find((t) => t.id === id)!
    const b0 = computeFormboard(d).bodies.find((b) => b.id === id)!
    expect(t0.rect.x).toBeCloseTo(b0.pos.x - BODY_DOT_R - TABLE_GAP - t0.rect.w, 6)
    expect(t0.rect.y).toBeCloseTo(b0.pos.y - t0.rect.h / 2, 6)
    const tw = t0.rect.w
    const th = t0.rect.h

    // The title block hugs the sheet's bottom-right PRINTABLE corner, and the
    // demo harness leaves that corner of an A1 sheet empty, so no arrangement
    // of it ever reaches the title block — hence a hand-built layout, solved
    // backwards from where the title block must land, with the BOM pinned out
    // of the way.
    const tbx = -TEMPLATE_GUTTER + pr.w - TITLE_BLOCK_W
    const tby = -TEMPLATE_GUTTER + pr.h - TITLE_BLOCK_H
    const tbRect: Rect = { x: tbx, y: tby, w: TITLE_BLOCK_W, h: TITLE_BLOCK_H }
    //
    // The DOT and its LABEL are deliberately kept OFF the title block (both sit
    // left of / above it) so that only the table can trigger
    // `title-block-over-content` — otherwise the body clause would satisfy the
    // assertion and the block clause would never be exercised. The one segment
    // runs −x out of the dot, which is what makes the away side 'right' and so
    // sends the first-choice table onto the title block.
    const bodyPos = { x: tbx - tw / 2 - BODY_DOT_R - TABLE_GAP, y: tby }
    const body: FbBody = {
      id,
      kind: 'connector',
      pos: bodyPos,
      label: 'X1',
      // Parked left of and well above the dot, rather than at
      // BODY_LABEL_OFFSET, so the body's footprint on the AWAY side is the
      // dot's own edge and `firstChoice` below is exactly the first candidate.
      labelPos: { x: bodyPos.x - 30, y: bodyPos.y - th - 30 }
    }
    const limb: FbSegment = {
      id: 'limb',
      a: bodyPos,
      b: { x: bodyPos.x - 100, y: bodyPos.y },
      wireIds: [],
      bundle: false,
      lengthMm: null,
      drawnLengthMm: null,
      broken: false
    }
    const layout: FbLayout = {
      bodies: [body],
      segments: [limb],
      branchPoints: [],
      treatments: [],
      labels: [],
      // Harness min corner is (0,0) — so the framed contentOrigin is
      // (−GUTTER, −GUTTER) and `tbx`/`tby` above are exactly where the title
      // block lands. The max corner makes the content exactly one A1 sheet.
      bbox: { minX: 0, minY: 0, maxX: 793, maxY: 530 }
    }
    // First choice for an away-side-'right' body — TABLE_GAP clear of the dot's
    // right edge, centred on it — which straddles the title block's top-left
    // corner by half the table in each axis.
    const firstChoice = { x: bodyPos.x + BODY_DOT_R + TABLE_GAP, y: bodyPos.y - th / 2 }
    expect(inter({ ...firstChoice, w: tw, h: th }, tbRect)).toBe(true)
    // Neither the dot nor its label may itself touch the title block, or the
    // warning below would prove nothing about the block clause.
    expect(inter(bodyRect(body), tbRect)).toBe(false)
    expect(inter(bodyLabelRect(body), tbRect)).toBe(false)

    // ── Pinned there: the plan warns rather than moving the user's block. ────
    d.drawing.blocks = { pinout: { [id]: firstChoice }, bom: { x: 0, y: 0 } }
    const pinned = planBoard(d, A1, layout)
    expect(pinned.titleBlockRect.x).toBeCloseTo(tbx, 6)
    expect(pinned.titleBlockRect.y).toBeCloseTo(tby, 6)
    const tp = pinned.tables.find((t) => t.id === id)!
    expect(tp.pinned).toBe(true)
    expect(inter(tp.rect, pinned.titleBlockRect)).toBe(true)
    expect(pinned.warnings).toContain('title-block-over-content')

    // ── Unpinned: the title block is an obstacle from the start. ─────────────
    d.drawing.blocks = { bom: { x: 0, y: 0 } }
    const p = planBoard(d, A1, layout)
    // Same sheet, same title block — the TABLE moved, not the goalposts.
    expect(p.titleBlockRect).toEqual(pinned.titleBlockRect)
    const t = p.tables.find((x) => x.id === id)!
    expect(t.pinned).toBe(false)
    // It did not take its first choice — the title block is an obstacle.
    expect(t.rect.x).not.toBeCloseTo(firstChoice.x, 6)
    expect(inter(t.rect, p.titleBlockRect)).toBe(false)
    expect(p.warnings).not.toContain('title-block-over-content')
  })

  it('re-derives overlap warnings from final geometry', () => {
    const d = demoDocument()
    const [a, b] = d.connectors.map((c) => c.id)
    const auto = planBoard(d, A3)
    const ra = auto.tables.find((t) => t.id === a)!.rect
    d.drawing.blocks = { pinout: { [a]: { x: ra.x, y: ra.y }, [b]: { x: ra.x, y: ra.y } } }
    const p = planBoard(d, A3)
    expect(p.warnings).toContain(`table-overlap:${a}`)
    expect(p.warnings).toContain(`table-overlap:${b}`)
  })
})

// ── Wire runs and run labels as obstacles ────────────────────────────────────
//
// This subsystem (`runHitsRect` / `wireObstacles` / `hitsWire` / the
// `table-over-wire:<id>` warning) moved verbatim out of the deleted
// `drawingSheet.ts` and arrived here WITHOUT its tests: making `hitsWire`
// return `false` unconditionally left the whole suite green. These are its
// tests, adapted to the 1:1 planner via the injectable `FbLayout`.

const A1 = sheetMm({ paper: 'A1', orientation: 'landscape' })

/**
 * Where a single-body fixture's connector DOT sits (mm). The fixture layout
 * carries no segment incident on it, so `awaySide` falls back to 'left' → its
 * table wants the LEFT side.
 */
const BODY = { x: 300, y: 200 }

/**
 * X1 (1 cavity) wired to X2. X2 is deliberately given NO body in
 * the injected layout below: a connector that HAS wires but no placement is the
 * `sizedPinouts` no-body branch — it gets pinout rows and no table, and must
 * not crash. The BOM block is pinned at the harness origin so it can never move
 * the content bbox (hence the tile grid, hence the title block) between the
 * control run and the runs that add wire obstacles.
 */
function wireDoc(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    { id: 'c1', designator: 'X1', cavities: [{ id: 'a', position: '1', status: 'populated' }] },
    { id: 'c2', designator: 'X2', cavities: [{ id: 'b', position: '1', status: 'populated' }] }
  ]
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'a' },
        { type: 'cavity', cavityId: 'b' }
      ],
      gauge: { value: 1.5, unit: 'mm2' },
      color: { base: 'RD' }
    }
  ]
  d.drawing.blocks = { bom: { x: 0, y: 0 } }
  return d
}

/** The fixture layout: one body for c1, whatever runs the test wants, a fixed one-A1-sheet bbox. */
function wireLayout(segments: FbSegment[]): FbLayout {
  const pos = { x: BODY.x, y: BODY.y }
  const body: FbBody = {
    id: 'c1',
    kind: 'connector',
    pos,
    label: 'X1',
    labelPos: { x: pos.x + BODY_LABEL_OFFSET.x, y: pos.y + BODY_LABEL_OFFSET.y }
  }
  return {
    bodies: [body],
    segments,
    branchPoints: [],
    treatments: [],
    labels: [],
    // Sized so the whole board is exactly ONE A1 sheet and the title block lands
    // in the far bottom-right corner, nowhere near the body or its table.
    bbox: { minX: 0, minY: 0, maxX: 793, maxY: 530 }
  }
}

/** `labelled: false` → `runLabel` returns '' → the run contributes a LINE and no label AABB. */
const run = (a: Vec2, b: Vec2, labelled = false): FbSegment => ({
  id: `s:${a.x},${a.y}-${b.x},${b.y}`,
  a,
  b,
  wireIds: ['w1'],
  bundle: false,
  gauge: labelled ? '1.5 mm²' : undefined,
  lengthMm: labelled ? 300 : null,
  drawnLengthMm: labelled ? 300 : null,
  broken: false
})

/** The run-label AABB the planner should be building, computed here independently. */
function labelRect(s: FbSegment): Rect {
  const text = runLabel(s.gauge, s.lengthMm)
  const w = estimateTextWidthMm(text, MIN_FONT)
  const h = MIN_FONT * 1.4
  return { x: (s.a.x + s.b.x) / 2 - w / 2, y: (s.a.y + s.b.y) / 2 - h, w, h }
}

const inflate = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m })

/**
 * Liang–Barsky, written out here rather than imported, so this is a CHECK on
 * the planner's clip rather than a restatement of it.
 */
function segHitsRect(s: FbSegment, r: Rect): boolean {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  const p = [-dx, dx, -dy, dy]
  const q = [s.a.x - r.x, r.x + r.w - s.a.x, s.a.y - r.y, r.y + r.h - s.a.y]
  let t0 = 0
  let t1 = 1
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false
    } else {
      const t = q[i] / p[i]
      if (p[i] < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return true
}

/** AABB of a run — what a lazy "is the run near this rect?" test would use. */
const runAabb = (s: FbSegment): Rect => ({
  x: Math.min(s.a.x, s.b.x),
  y: Math.min(s.a.y, s.b.y),
  w: Math.abs(s.b.x - s.a.x),
  h: Math.abs(s.b.y - s.a.y)
})

const containsRect = (outer: Rect, r: Rect): boolean =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h

/** The first-choice rect for c1's table with NO wire obstacles at all. */
function firstChoice(): Rect {
  const p = planBoard(wireDoc(), A1, wireLayout([]))
  return p.tables.find((t) => t.id === 'c1')!.rect
}

describe('wire runs and run labels are obstacles', () => {
  it('the fixture is sane: one sheet, one table, on the dot\'s away side, no warnings', () => {
    const d = wireDoc()
    const p = planBoard(d, A1, wireLayout([]))
    // c2 HAS pinout rows but no body — the `sizedPinouts` no-body branch: rows,
    // no table, no crash.
    expect(connectorPinouts(d).map((x) => x.nodeId)).toEqual(['c1', 'c2'])
    expect(p.tables.map((t) => t.id)).toEqual(['c1'])
    const t = p.tables[0]
    expect(t.pinned).toBe(false)
    expect(t.rect.x).toBeCloseTo(BODY.x - BODY_DOT_R - TABLE_GAP - t.rect.w, 6)
    expect(t.rect.y).toBeCloseTo(BODY.y - t.rect.h / 2, 6)
    expect(p.warnings).toEqual([])
  })

  it('an UNPINNED table whose first choice lies on a wire run is placed elsewhere', () => {
    const first = firstChoice()
    // A vertical run straight down the middle of that first-choice rect.
    const mx = first.x + first.w / 2
    const r = run({ x: mx, y: first.y - 40 }, { x: mx, y: first.y + first.h + 40 })
    expect(segHitsRect(r, first)).toBe(true) // the fixture really does foul it

    const p = planBoard(wireDoc(), A1, wireLayout([r]))
    const t = p.tables.find((x) => x.id === 'c1')!
    expect(t.pinned).toBe(false)
    expect(t.rect).not.toEqual(first)
    // And where it landed is genuinely clear of the run, at WIRE_CLEARANCE.
    expect(segHitsRect(r, inflate(t.rect, WIRE_CLEARANCE))).toBe(false)
    expect(p.warnings).toEqual([])
  })

  it('a PINNED table sitting on a wire run is warned about, not moved', () => {
    const first = firstChoice()
    const mx = first.x + first.w / 2
    const r = run({ x: mx, y: first.y - 40 }, { x: mx, y: first.y + first.h + 40 })

    const d = wireDoc()
    d.drawing.blocks = { ...d.drawing.blocks, pinout: { c1: { x: first.x, y: first.y } } }
    const p = planBoard(d, A1, wireLayout([r]))
    const t = p.tables.find((x) => x.id === 'c1')!
    expect(t.pinned).toBe(true)
    expect(t.rect.x).toBe(first.x)
    expect(t.rect.y).toBe(first.y)
    expect(p.warnings).toContain('table-over-wire:c1')
  })

  it('a run LABEL is an obstacle in its own right, even when the run itself misses', () => {
    const first = firstChoice()
    // The label AABB hangs ABOVE the run's midpoint (baseline on the midpoint),
    // so a horizontal run just below the rect puts the LABEL over the rect while
    // the LINE stays well outside WIRE_CLEARANCE of it.
    const h = MIN_FONT * 1.4
    const midY = first.y + first.h + h - 0.5
    const midX = first.x + first.w / 2
    const r = run({ x: midX - 60, y: midY }, { x: midX + 60, y: midY }, true)
    expect(runLabel(r.gauge, r.lengthMm)).not.toBe('')
    // The line misses even the inflated rect; only the label reaches it.
    expect(segHitsRect(r, inflate(first, WIRE_CLEARANCE))).toBe(false)
    const lr = labelRect(r)
    expect(lr.x < first.x + first.w && first.x < lr.x + lr.w).toBe(true)
    expect(lr.y < first.y + first.h && first.y < lr.y + lr.h).toBe(true)

    // Pinned there → warned.
    const pinnedDoc = wireDoc()
    pinnedDoc.drawing.blocks = {
      ...pinnedDoc.drawing.blocks,
      pinout: { c1: { x: first.x, y: first.y } }
    }
    expect(planBoard(pinnedDoc, A1, wireLayout([r])).warnings).toContain('table-over-wire:c1')

    // Unpinned → moved off it.
    const p = planBoard(wireDoc(), A1, wireLayout([r]))
    const t = p.tables.find((x) => x.id === 'c1')!
    expect(t.rect).not.toEqual(first)
    const moved = inflate(t.rect, WIRE_CLEARANCE)
    expect(moved.x < lr.x + lr.w && lr.x < moved.x + moved.w && moved.y < lr.y + lr.h && lr.y < moved.y + moved.h).toBe(false)
    expect(p.warnings).toEqual([])
  })

  it('a long diagonal whose BOUNDING BOX swallows the rect is not a hit — the line is', () => {
    // This is why the clip is Liang–Barsky and not an AABB test: a long
    // diagonal's bounding box covers most of the board, so an AABB test would
    // reject every candidate the planner has.
    const first = firstChoice()
    const a = { x: first.x - 8, y: first.y - 2 }
    // Steep enough that by the time the line reaches the rect's left edge it is
    // already 18 mm below the rect's bottom.
    const slope = (first.h + 20) / 8
    const r = run(a, { x: a.x + 1200, y: a.y + 1200 * slope })
    expect(containsRect(runAabb(r), first)).toBe(true)
    expect(segHitsRect(r, inflate(first, WIRE_CLEARANCE))).toBe(false)

    const p = planBoard(wireDoc(), A1, wireLayout([r]))
    const t = p.tables.find((x) => x.id === 'c1')!
    // Stays exactly where it wanted to be. The run's far end is metres off the
    // sheet, which is the only thing the plan has to say about it.
    expect(t.rect).toEqual(first)
    expect(p.warnings).toEqual([`outside-sheet:segment:${r.id}`])
  })
})

// ── Body LABELS are obstacles, not just the dots ─────────────────────────────
//
// A dot is 3.6 mm across, so the dots alone barely obstruct anything: dropping
// the label rects from the obstacle set left the whole suite green while tables
// printed over the designators that say which body they belong to.

describe('a body label is an obstacle in its own right', () => {
  it('an unpinned table whose first choice lies on ANOTHER body label is placed elsewhere', () => {
    const first = firstChoice()
    // A splice gets a body but NO pinout table (connectorPinouts covers
    // connectors and free terminals only), so this is a pure obstacle. Its DOT
    // sits well left of c1's first-choice rect and only its LABEL reaches into
    // it — so if the table moves, the label is the only thing that moved it.
    const obstacle: FbBody = {
      id: 'sp1',
      kind: 'splice',
      pos: { x: first.x - 20, y: first.y + first.h / 2 },
      label: 'splice [7]',
      labelPos: { x: first.x + 2, y: first.y + first.h / 2 }
    }
    const layout = wireLayout([])
    layout.bodies.push(obstacle)
    expect(inter(bodyRect(obstacle), first)).toBe(false)
    expect(inter(bodyLabelRect(obstacle), first)).toBe(true)

    const p = planBoard(wireDoc(), A1, layout)
    expect(p.tables.map((t) => t.id)).toEqual(['c1'])
    const t = p.tables[0]
    expect(t.pinned).toBe(false)
    expect(t.rect).not.toEqual(first)
    // And where it landed is genuinely clear of the label.
    expect(inter(t.rect, bodyLabelRect(obstacle))).toBe(false)
  })
})

// ── One fixed sheet ──────────────────────────────────────────────────────────
//
// The sheet sits at `drawing.sheetOrigin` (or frames the harness while that is
// absent) and never moves or grows with the content. Anything outside it is
// flagged per item, not accommodated.

/** The demo document with its first connector's pinout table pinned `mm` away in both axes. */
function pinnedFarAway(mm: number): ReturnType<typeof demoDocument> {
  const d = demoDocument()
  d.drawing.blocks = { pinout: { [d.connectors[0].id]: { x: mm, y: mm } } }
  return d
}

const containedIn = (outer: Rect, r: Rect): boolean =>
  r.x >= outer.x - 1e-9 &&
  r.y >= outer.y - 1e-9 &&
  r.x + r.w <= outer.x + outer.w + 1e-9 &&
  r.y + r.h <= outer.y + outer.h + 1e-9

const outsideSheet = (p: BoardPlan): string[] => p.warnings.filter((w) => w.startsWith('outside-sheet:'))

// ── Outside-sheet tests EXTENTS, not points ──────────────────────────────────
//
// Testing only the dot centre / label anchor / segment ends let a designator,
// a free label's text or a run's length label hang off the sheet edge and be
// silently clipped off the PDF with nothing flagged.

describe('outside-sheet tests what is drawn, not just its anchor point', () => {
  /** wireDoc on A1 with the sheet pinned at the origin: its right edge in model mm. */
  const pinned = (): HarnessDocument => {
    const d = wireDoc()
    d.drawing.sheetOrigin = { x: 0, y: 0 }
    return d
  }
  const right = printableSize(A1).w

  it('a body whose dot is inside but whose designator label crosses the right edge is flagged', () => {
    const pos = { x: right - BODY_DOT_R - 0.5, y: 100 }
    const body: FbBody = {
      id: 'c1',
      kind: 'connector',
      pos,
      label: 'X1',
      labelPos: { x: pos.x + BODY_LABEL_OFFSET.x, y: pos.y + BODY_LABEL_OFFSET.y }
    }
    const layout: FbLayout = { ...wireLayout([]), bodies: [body] }
    expect(containedIn({ x: 0, y: 0, w: right, h: printableSize(A1).h }, bodyRect(body))).toBe(true)
    const w = outsideSheet(planBoard(pinned(), A1, layout))
    expect(w.filter((x) => x === 'outside-sheet:body:c1')).toEqual(['outside-sheet:body:c1'])
  })

  it('a segment whose ends are inside but whose length label crosses the edge is flagged — once', () => {
    const r = run({ x: right - 1, y: 100 }, { x: right - 1, y: 160 }, true)
    expect(labelRect(r).x + labelRect(r).w).toBeGreaterThan(right)
    const w = outsideSheet(planBoard(pinned(), A1, wireLayout([r])))
    expect(w).toEqual([`outside-sheet:segment:${r.id}`])
  })

  it('a free label whose anchor is inside but whose text crosses the edge is flagged — once', () => {
    const layout: FbLayout = {
      ...wireLayout([]),
      labels: [{ id: 'lbl-edge', kind: 'callout', text: 'A LONG NOTE THAT RUNS OFF', pos: { x: right - 5, y: 100 } }]
    }
    const w = outsideSheet(planBoard(pinned(), A1, layout))
    expect(w).toEqual(['outside-sheet:label:lbl-edge'])
  })

  it('the demo fully inside an A3 sheet still has no outside-sheet warnings', () => {
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: 0, y: 0 }
    expect(outsideSheet(planBoard(d, A3))).toEqual([])
  })
})

describe('one fixed sheet', () => {
  it('sheet stays put when a body moves', () => {
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: 0, y: 0 }
    const before = planBoard(d, A3)
    expect(before.contentOrigin).toEqual({ x: 0, y: 0 })
    d.placements[0].pos = { x: d.placements[0].pos.x + 300, y: d.placements[0].pos.y + 300 }
    const after = planBoard(d, A3)
    expect(after.contentOrigin).toEqual(before.contentOrigin)
    expect(after.sheetRect).toEqual(before.sheetRect)
    expect(after.titleBlockRect).toEqual(before.titleBlockRect)
  })

  it('sheet top-left is independent of paper size', () => {
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: -20, y: 10 }
    const a4 = planBoard(d, A4)
    const a1 = planBoard(d, sheetMm({ paper: 'A1', orientation: 'landscape' }))
    expect(a1.contentOrigin).toEqual(a4.contentOrigin)
    expect(a1.sheetRect.x).toBe(a4.sheetRect.x)
    expect(a1.sheetRect.y).toBe(a4.sheetRect.y)
    expect(a1.sheetRect.w).toBeGreaterThan(a4.sheetRect.w)
    expect(a1.sheetRect.h).toBeGreaterThan(a4.sheetRect.h)
  })

  it('absent sheetOrigin frames the harness (not the blocks)', () => {
    const d = demoDocument()
    expect(d.drawing.sheetOrigin).toBeUndefined()
    const layout = computeFormboard(d)
    const o = framedSheetOrigin(layout)
    expect(o).toEqual({ x: layout.bbox.minX - TEMPLATE_GUTTER, y: layout.bbox.minY - TEMPLATE_GUTTER })
    expect(planBoard(d, A3, layout).contentOrigin).toEqual(o)
    // A block dragged far away does not drag the framing with it.
    expect(planBoard(pinnedFarAway(-3000), A3).contentOrigin).toEqual(o)
  })

  it('outside-sheet warnings list every kind', () => {
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: 0, y: 0 }
    // Inside first: the demo on an A3 sheet at the origin flags nothing.
    expect(outsideSheet(planBoard(d, A3))).toEqual([])

    const far = 5000
    // A body: move the B+ lug off the sheet — its limb goes with it.
    const lug = d.freeTerminals[0].id
    d.placements.find((p) => p.refId === lug)!.pos = { x: far, y: 100 }
    const lugSegs = d.segments
      .filter((s) => [s.from, s.to].some((n) => n.type === 'body' && n.refId === lug))
      .map((s) => s.id)
    expect(lugSegs.length).toBeGreaterThan(0)
    // A branch point, with a limb to it from X1.
    d.branchPoints.push({ id: 'bp-far', pos: { x: far, y: 200 } })
    d.segments.push({ id: 'seg-far', from: { type: 'body', refId: d.connectors[0].id }, to: { type: 'branch', branchId: 'bp-far' } })
    // A free label on that branch point.
    d.labels.push({ id: 'lbl-far', target: { type: 'branchPoint', branchId: 'bp-far' }, kind: 'flag', text: 'F', pos: { x: far, y: 260 } })
    // A pinned pinout table.
    const x2 = d.connectors[1].id
    d.drawing.blocks = { pinout: { [x2]: { x: far, y: 300 } } }

    const w = outsideSheet(planBoard(d, A3))
    expect(w).toContain(`outside-sheet:body:${lug}`)
    expect(w).toContain('outside-sheet:branch:bp-far')
    expect(w).toContain('outside-sheet:segment:seg-far')
    for (const id of lugSegs) expect(w).toContain(`outside-sheet:segment:${id}`)
    expect(w).toContain('outside-sheet:label:lbl-far')
    expect(w).toContain(`outside-sheet:block:pinout:${x2}`)
    // X1 itself is still on the sheet and is not flagged.
    expect(w).not.toContain(`outside-sheet:body:${d.connectors[0].id}`)
  })

  it('unpinned blocks are placed inside the sheet (4:3 photo)', () => {
    const d = demoDocument()
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    const p = planBoard(d, A3, computeFormboard(d), IMG)
    expect(p.pictures.length).toBe(1)
    const blocks = [...p.tables, ...p.pictures, p.bom]
    for (const b of blocks) {
      expect(b.pinned).toBe(false)
      expect(containedIn(p.sheetRect, b.rect), `${b.kind}:${b.id}`).toBe(true)
    }
    expect(outsideSheet(p)).toEqual([])
  })

  it('a square photo on X1 finds a clear spot on the A3 demo', () => {
    // Was a KNOWN LIMITATION (flagged off-sheet) until pinout From / To columns
    // grew to fit their text (2026-10-27): the wider X1 table now lands on a
    // different candidate, leaving a clear spot for the 30 × 35.6 mm square-photo
    // block within the slide limit. Placement-sensitive: if it flips back, that
    // is the old limitation returning, not a new bug.
    const d = demoDocument()
    d.connectors[0].housing = { partNumber: 'SQ' }
    const p = planBoard(d, A3, computeFormboard(d), { SQ: { href: 'i/sq', pxW: 2, pxH: 2 } })
    const pic = p.pictures.find((x) => x.id === d.connectors[0].id)!
    expect(containedIn(p.sheetRect, pic.rect)).toBe(true)
    expect(outsideSheet(p)).toEqual([])
  })

  it('the BOM block leaves its below-the-harness default when that is off the sheet', () => {
    const d = demoDocument()
    const bb = computeFormboard(d).bbox
    // Sheet bottom 5 mm under the harness: no below-the-harness spot fits.
    d.drawing.sheetOrigin = { x: 0, y: bb.maxY + 5 - printableSize(A3).h }
    const p = planBoard(d, A3)
    expect(p.bom.pinned).toBe(false)
    expect(p.bom.rect.y).toBeLessThan(bb.maxY)
    expect(containedIn(p.sheetRect, p.bom.rect)).toBe(true)
    expect(p.warnings).not.toContain('outside-sheet:block:bom:bom')
  })

  it('a body far off the sheet keeps its blocks beside it — never slid metres onto the sheet', () => {
    // Reviewer repro: sliding a candidate onto the sheet had no reach limit, so
    // the B+ lug's table landed on the sheet edge ~4.6 m from its dot and
    // nothing was flagged.
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: 0, y: 0 }
    const lug = d.freeTerminals[0]
    lug.part = { partNumber: 'RING-A' }
    d.placements.find((p) => p.refId === lug.id)!.pos = { x: 5000, y: 100 }
    const p = planBoard(d, A3, computeFormboard(d), { 'RING-A': { href: 'i/ring', pxW: 100, pxH: 100 } })
    const t = p.tables.find((x) => x.id === lug.id)!
    const pic = p.pictures.find((x) => x.id === lug.id)!
    for (const b of [t, pic]) {
      expect(b.pinned).toBe(false)
      expect(inter(b.rect, p.sheetRect)).toBe(false)
      expect(Math.abs(b.rect.x - 5000)).toBeLessThan(200)
    }
    expect(p.warnings).toContain(`outside-sheet:block:pinout:${lug.id}`)
    expect(p.warnings).toContain(`outside-sheet:block:picture:${lug.id}`)
    // The BOM does not belong to a body; its sheet-corner fallback is unaffected.
    expect(containedIn(p.sheetRect, p.bom.rect)).toBe(true)
  })

  it('a block near the sheet edge is still slid on, by no more than 50 mm', () => {
    // X1 is 17 mm inside the framed sheet's left edge: its centred spots spill
    // over the edge and are slid back on.
    const d = demoDocument()
    const layout = computeFormboard(d)
    const p = planBoard(d, A3, layout)
    const x1 = layout.bodies.find((b) => b.id === d.connectors[0].id)!
    const t = p.tables.find((x) => x.id === x1.id)!
    expect(containedIn(p.sheetRect, t.rect)).toBe(true)
    expect(t.rect.x).toBe(p.sheetRect.x)
  })

  it('a block pinned 74 m away plans quickly and is flagged, never moved', () => {
    // Under the old growing tile grid this was ~125 000 tiles and a stack
    // overflow on the canvas path. One sheet makes the distance irrelevant.
    const d = pinnedFarAway(74000)
    const id = d.connectors[0].id
    const p = planBoard(d, A4)
    expect(p.warnings).toContain(`outside-sheet:block:pinout:${id}`)
    const t = p.tables.find((x) => x.id === id)!
    expect(t.pinned).toBe(true)
    expect(t.rect.x).toBe(74000)
  })
})

const IMG = { 'HSG-A': { href: 'parts-image://img/HSG-A', pxW: 400, pxH: 300 } }

describe('picture blocks', () => {
  /** The demo harness carries no part numbers; give connector 0 a housing so it has a picture. */
  function withHousing(): ReturnType<typeof demoDocument> {
    const d = demoDocument()
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    return d
  }

  it('no images map ⇒ no picture blocks and every body is listed as without picture', () => {
    const d = withHousing()
    const p = planBoard(d, A3)
    expect(p.pictures).toEqual([])
    expect(p.bodiesWithoutPicture.sort()).toEqual(
      computeFormboard(d)
        .bodies.map((b) => b.id)
        .sort()
    )
  })

  it('a body whose primary part has an image gets one picture block, sized by the image, not overlapping anything', () => {
    const d = withHousing()
    const p = planBoard(d, A3, computeFormboard(d), IMG)
    expect(p.pictures.length).toBe(1)
    const pic = p.pictures[0]
    expect(pic.kind).toBe('picture')
    expect(pic.id).toBe(d.connectors[0].id)
    const size = pictureBlockSize(IMG['HSG-A'])
    expect(pic.rect.w).toBe(size.w)
    expect(pic.rect.h).toBe(size.h)
    expect(pic.pinned).toBe(false)
    expect(pic.caption).toBe(d.connectors[0].designator)
    for (const t of p.tables) expect(inter(pic.rect, t.rect)).toBe(false)
    expect(p.bodiesWithoutPicture).not.toContain(pic.id)
    expect(p.warnings.filter((w) => w.endsWith(`:${pic.id}`) && w.startsWith('table-'))).toEqual([])
  })

  it('captions a terminal picture with its designator and a splice picture with its designator', () => {
    const d = demoDocument()
    const ft = d.freeTerminals[0]
    ft.part = { partNumber: 'RING-A' }
    d.splices.push({ id: 'sp1', designator: 'SP1', kind: 'butt', part: { partNumber: 'SPL-A' } })
    d.placements.push({ refId: 'sp1', pos: { x: 80, y: 120 } })
    const images = {
      'RING-A': { href: 'i/ring', pxW: 100, pxH: 100 },
      'SPL-A': { href: 'i/spl', pxW: 100, pxH: 100 }
    }
    const p = planBoard(d, A3, computeFormboard(d), images)
    const cap = (id: string): string | undefined => p.pictures.find((x) => x.id === id)?.caption
    expect(cap(ft.id)).toBe('T1')
    expect(cap('sp1')).toBe('SP1')
  })

  it('a pinned picture is used verbatim and can fall outside the sheet', () => {
    const d = withHousing()
    d.drawing.blocks = { picture: { [d.connectors[0].id]: { x: 5000, y: 5000 } } }
    const p = planBoard(d, A3, computeFormboard(d), IMG)
    expect(p.pictures[0].rect.x).toBe(5000)
    expect(p.pictures[0].pinned).toBe(true)
    expect(p.warnings).toContain(`outside-sheet:block:picture:${d.connectors[0].id}`)
  })

  it('sizes a rotated picture from the stored view — the 4:3 photo on its side fills the cap', () => {
    const d = withHousing()
    const id = d.connectors[0].id
    const upright = planBoard(d, A3, computeFormboard(d), IMG).pictures[0]
    d.drawing.blocks = { pictureView: { [id]: { rotationDeg: 90 } } }
    const p = planBoard(d, A3, computeFormboard(d), IMG)
    const pic = p.pictures[0]
    expect(pic.rect.h).toBe(pictureBlockSize(IMG['HSG-A'], { rotationDeg: 90 }).h)
    // 400 × 300 upright is 30 × 22.5; turned it is 22.5 × 30, i.e. the cap.
    expect(upright.rect.h).toBe(22.5 + PICTURE_CAPTION_H)
    expect(pic.rect.h).toBe(PICTURE_MAX_H + PICTURE_CAPTION_H)
    expect(pic.rect.w).toBe(upright.rect.w)
    expect(pic.view).toEqual({ rotationDeg: 90 })
  })

  it('normalises the stored view and carries none at all when it is the identity', () => {
    const d = withHousing()
    const id = d.connectors[0].id
    d.drawing.blocks = { pictureView: { [id]: { rotationDeg: 450, flipH: true } } }
    expect(planBoard(d, A3, computeFormboard(d), IMG).pictures[0].view).toEqual({
      rotationDeg: 90,
      flipH: true
    })
    d.drawing.blocks = { pictureView: { [id]: { rotationDeg: 360, flipV: false } } }
    const identity = planBoard(d, A3, computeFormboard(d), IMG).pictures[0]
    expect(identity.view).toBeUndefined()
    expect(identity.rect.h).toBe(22.5 + PICTURE_CAPTION_H)
  })

  it('a flip alone leaves the planned rect exactly where an upright one was', () => {
    const d = withHousing()
    const id = d.connectors[0].id
    const before = planBoard(d, A3, computeFormboard(d), IMG).pictures[0]
    d.drawing.blocks = { pictureView: { [id]: { flipH: true } } }
    const after = planBoard(d, A3, computeFormboard(d), IMG).pictures[0]
    expect(after.rect).toEqual(before.rect)
    expect(after.view).toEqual({ flipH: true })
  })

  it('a pinned picture is an obstacle the auto-placed tables dodge', () => {
    const d = withHousing()
    const id = d.connectors[0].id
    // Pin the picture exactly where connector 0's table auto-places, so a
    // planner that ignored pinned pictures would put the table on top of it.
    const before = planBoard(d, A3, computeFormboard(d), IMG)
    const t0 = before.tables.find((t) => t.id === id)!
    d.drawing.blocks = { picture: { [id]: { x: t0.rect.x, y: t0.rect.y } } }
    const after = planBoard(d, A3, computeFormboard(d), IMG)
    expect(after.pictures[0].pinned).toBe(true)
    for (const t of after.tables) expect(inter(t.rect, after.pictures[0].rect)).toBe(false)
  })
})

describe('planBoard — length-tolerance block', () => {
  const withTable = (): HarnessDocument => {
    const d = demoDocument()
    d.drawing.toleranceTable = { bands: IPC_620_LENGTH_TOLERANCE.map((b) => ({ ...b })) }
    return d
  }

  it('is absent while the drawing has no tolerance table', () => {
    expect(planBoard(demoDocument(), A3).tolerance).toBeUndefined()
  })

  it('defaults to right above the title block, flush with its right edge, clear of every other block', () => {
    // On A1 the title block's corner is far from the demo harness, so nothing is in the way.
    const A1 = sheetMm({ paper: 'A1', orientation: 'landscape' })
    const p = planBoard(withTable(), A1)
    const t = p.tolerance!
    expect(t).toMatchObject({ kind: 'tolerance', id: TOLERANCE_BLOCK_ID, pinned: false, title: DEFAULT_TOLERANCE_TITLE })
    expect(t.spec!.rows.length).toBe(5)
    expect(t.rect.x + t.rect.w).toBeCloseTo(p.titleBlockRect.x + p.titleBlockRect.w, 6)
    expect(t.rect.y + t.rect.h + TABLE_GAP).toBeCloseTo(p.titleBlockRect.y, 6)
    for (const b of [...p.tables, ...p.pictures, p.bom]) expect(inter(t.rect, b.rect)).toBe(false)
    expect(p.warnings).toEqual(planBoard(demoDocument(), A1).warnings)
  })

  it('moves on to beside the BOM block when the spot above the title block is taken', () => {
    // On A3 the B+ lug's pinout table sits right above the title block.
    const p = planBoard(withTable(), A3)
    const t = p.tolerance!
    expect(t.rect.x).toBeCloseTo(p.bom.rect.x + p.bom.rect.w + TABLE_GAP, 6)
    expect(t.rect.y).toBeCloseTo(p.bom.rect.y, 6)
    for (const b of [...p.tables, ...p.pictures, p.bom]) expect(inter(t.rect, b.rect)).toBe(false)
    expect(p.warnings).toEqual(planBoard(demoDocument(), A3).warnings)
  })

  it('a pinned block is taken verbatim, and is flagged once it is off the sheet', () => {
    const d = withTable()
    d.drawing.blocks = { tolerance: { x: -5000, y: -5000 } }
    const p = planBoard(d, A3)
    expect(p.tolerance!.pinned).toBe(true)
    expect(p.tolerance!.rect).toMatchObject({ x: -5000, y: -5000 })
    expect(p.warnings).toContain('outside-sheet:block:tolerance:tolerance')
    expect(p.warnings.filter((w) => w.startsWith('table-'))).toEqual([])
  })
})

describe('planBoard — sleeve callouts', () => {
  it('a table pinned over a sleeve callout is flagged, as over a run label', () => {
    const d = demoDocument()
    d.drawing.sheet = { paper: 'A1', orientation: 'landscape' }
    const seg = d.segments[0]
    const wire = d.wireRoutes.find((r) => r.path.includes(seg.id))!.wireId
    const c1 = d.connectors[0].id
    const bare = planBoard(d, sheetMm(d.drawing.sheet))
    d.sleeving = [{ id: 'sl', target: { type: 'wire', wireId: wire }, span: { segmentIds: [seg.id] }, sleevingType: 'heatshrink' }]
    const rect = computeFormboard(d).treatments[0].callouts![0].rect
    d.drawing.blocks = { pinout: { [c1]: { x: rect.x, y: rect.y } } }
    expect(planBoard(d, sheetMm(d.drawing.sheet)).warnings).toContain(`table-over-wire:${c1}`)
    // Without the sleeve that same spot is only flagged if it was already on a run.
    const noSleeve = { ...d, sleeving: [] }
    const pinnedBare = planBoard(noSleeve, sheetMm(d.drawing.sheet)).warnings.includes(`table-over-wire:${c1}`)
    expect(pinnedBare).toBe(false)
    expect(bare.warnings).not.toContain(`table-over-wire:${c1}`)
  })
})
