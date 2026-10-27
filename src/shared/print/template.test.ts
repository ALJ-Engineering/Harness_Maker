import { describe, it, expect } from 'vitest'
import { renderBoardPage, STRIP_TEXT_INSET, TILE_STRIP_H } from './template'
import { demoDocument, emptyDocument } from '../model/document'
import { sheetMm, TEMPLATE_MARGIN, type SheetMm } from './sheet'
import { computeFormboard } from '../model/formboard'
import { planBoard, type BoardPlan } from './board'
import { fmt } from './text'
import type { HarnessDocument } from '../model/schema'
import type { Page } from './pageModel'

/** Plan + render one document at one sheet, the way `buildDrawingSet` does. */
const board = (doc: HarnessDocument, sheet: SheetMm): { plan: BoardPlan; page: Page } => {
  const layout = computeFormboard(doc)
  const plan = planBoard(doc, sheet, layout)
  return { plan, page: renderBoardPage(doc, plan, {}, layout, { pageNoStart: 1, pageCount: 1 }) }
}

describe('renderBoardPage', () => {
  it('the page is 1:1 by construction: nested viewBox == nested size in mm, at the sheet origin', () => {
    const d = demoDocument()
    d.drawing.sheetOrigin = { x: -12.5, y: 30 }
    const { plan, page } = board(d, sheetMm({ paper: 'A4', orientation: 'landscape' }))
    expect(page.id).toBe('drawing')
    expect(page.section).toBe('Drawing')
    const m = page.svg.match(/<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/)!
    expect(m).not.toBeNull()
    expect(Number(m[3])).toBe(Number(m[7])); expect(Number(m[4])).toBe(Number(m[8]))
    expect(Number(m[3])).toBe(plan.printable.w); expect(Number(m[4])).toBe(plan.printable.h)
    expect(Number(m[1])).toBe(TEMPLATE_MARGIN)
    expect(Number(m[5])).toBe(-12.5); expect(Number(m[6])).toBe(30)
    expect(page.svg).toContain('width="297mm" height="210mm"')
    expect(page.svg).toContain('verify scale bar = 100 mm')
  })

  it('a plotter sheet is one page of the roll size', () => {
    const sheet = sheetMm({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 })
    const { page } = board(demoDocument(), sheet)
    expect(page.svg).toContain('width="2600mm" height="914mm" viewBox="0 0 2600 914"')
  })

  it('carries no registration marks and no overlap guides', () => {
    const d = demoDocument()
    d.placements = d.placements.map((p) => ({ ...p, pos: { x: p.pos.x * 3, y: p.pos.y } }))
    const { page } = board(d, sheetMm({ paper: 'A4', orientation: 'landscape' }))
    expect(page.svg).not.toContain('r="1.5"')
    expect(page.svg).not.toContain('stroke-dasharray="2 2"')
  })
  it('drawn segment endpoints equal the model anchors (lengths are true), scale bar is 100 units', () => {
    const doc = demoDocument()
    const layout = computeFormboard(doc)
    const svg = board(doc, sheetMm({ paper: 'A1', orientation: 'landscape' })).page.svg
    for (const seg of layout.segments) {
      expect(svg).toContain(`d="M ${Number(seg.a.x.toFixed(2))} ${Number(seg.a.y.toFixed(2))} L ${Number(seg.b.x.toFixed(2))} ${Number(seg.b.y.toFixed(2))}"`)
      if (seg.lengthMm != null) expect(Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y)).toBeCloseTo(seg.lengthMm, 2)
    }
    const bar = svg.match(/<g class="scale-bar-page">.*?<line x1="(-?[\d.]+)" y1="[^"]+" x2="(-?[\d.]+)"/s)!
    expect(Number(bar[2]) - Number(bar[1])).toBe(100)
  })
  it('the page carries exactly one PAGE-SPACE 100 mm scale bar, outside the clipped drawing svg', () => {
    // The bar lives in the info strip, in sheet mm, so it prints even when the
    // harness content itself is clipped by the sheet edge.
    const d = demoDocument()
    d.placements = d.placements.map((p) => ({ ...p, pos: { x: p.pos.x * 3, y: p.pos.y } }))
    const sheet = sheetMm({ paper: 'A4', orientation: 'landscape' })
    const pages = [board(d, sheet).page]
    for (const page of pages) {
      const groups = [...page.svg.matchAll(/<g class="scale-bar-page">([\s\S]*?)<\/g>/g)]
      expect({ id: page.id, bars: groups.length }).toEqual({ id: page.id, bars: 1 })

      // Page space, not content space: the group must come AFTER the nested
      // </svg> that clips the harness content.
      const drawingClose = page.svg.indexOf('</svg>')
      expect(drawingClose).toBeGreaterThan(0)
      expect(page.svg.indexOf('<g class="scale-bar-page">')).toBeGreaterThan(drawingClose)

      // The two end ticks are the vertical lines (x1 === x2); they are exactly
      // 100 mm apart and both land on the paper.
      const lines = [...groups[0][1].matchAll(
        /<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g
      )].map((m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }))
      const ticks = lines.filter((l) => l.x1 === l.x2)
      expect({ id: page.id, ticks: ticks.length }).toEqual({ id: page.id, ticks: 2 })
      const xs = ticks.map((t) => t.x1).sort((a, b) => a - b)
      expect(xs[1] - xs[0]).toBe(100)
      for (const l of lines) {
        for (const x of [l.x1, l.x2]) {
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(sheet.wMm)
        }
        for (const y of [l.y1, l.y2]) {
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(sheet.hMm)
        }
      }
    }
  })

  it('the info strip is two rows tall: scale bar above, caption/label/verify text below', () => {
    const sheet = sheetMm({ paper: 'A4', orientation: 'landscape' })
    const svg = board(demoDocument(), sheet).page.svg
    const stripY = sheet.hMm - TEMPLATE_MARGIN - TILE_STRIP_H
    const barY = [...svg.matchAll(/<g class="scale-bar-page">([\s\S]*?)<\/g>/g)][0][1]
    expect(barY).toContain(`y1="${stripY + 4}"`)
    const strip = svg.match(/<g class="page-info">([\s\S]*?)<\/g>/)![1]
    for (const m of strip.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"/g)) {
      expect(Number(m[2])).toBe(stripY + 10.5)
    }
  })

  it('an empty document still yields a drawing page', () => {
    expect(board(emptyDocument(), sheetMm({ paper: 'A4', orientation: 'portrait' })).page.section).toBe('Drawing')
  })
  it('info-strip text is inset from the sheet edges', () => {
    const sheet = sheetMm({ paper: 'A4', orientation: 'landscape' })
    const svg = board(demoDocument(), sheet).page.svg
    const strip = svg.match(/<g class="page-info">([\s\S]*?)<\/g>/)!
    const xs = [...strip[1].matchAll(/<text x="(-?[\d.]+)"/g)].map((m) => Number(m[1]))
    expect(xs[0]).toBe(TEMPLATE_MARGIN + STRIP_TEXT_INSET)
    expect(xs[xs.length - 1]).toBe(sheet.wMm - TEMPLATE_MARGIN - STRIP_TEXT_INSET)
  })

  it('a block is drawn in content space, inside the nested drawing svg', () => {
    const d = demoDocument()
    const id = d.connectors[0].id
    const { page } = board(d, sheetMm({ paper: 'A3', orientation: 'landscape' }))
    const marker = `data-block="pinout:${id}"`
    expect(page.svg).toContain(marker)
    expect(page.svg.indexOf(marker)).toBeLessThan(page.svg.indexOf('</svg>'))
  })

  it('a part picture prints as its own block group, image and caption included', () => {
    const d = demoDocument()
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    const images = { 'HSG-A': { href: 'parts-image://img/HSG-A', pxW: 400, pxH: 300 } }
    const sheet = sheetMm({ paper: 'A3', orientation: 'landscape' })
    const layout = computeFormboard(d)
    const plan = planBoard(d, sheet, layout, images)
    const pic = plan.pictures[0]
    expect(pic).toBeDefined()
    const svg = renderBoardPage(d, plan, {}, layout, { pageNoStart: 1, pageCount: 1 }).svg
    expect(svg).toContain(
      `<g class="block" data-block="picture:${pic.id}" transform="translate(${fmt(pic.rect.x)} ${fmt(pic.rect.y)})">`
    )
    expect(svg).toContain('<image href="parts-image://img/HSG-A"')
    expect(svg).toContain(`>${d.connectors[0].designator}</text>`)
    // Content space: the block markup is inside the nested drawing svg.
    const marker = `data-block="picture:${pic.id}"`
    expect(svg.indexOf(marker)).toBeLessThan(svg.indexOf('</svg>'))
  })

  it('no images ⇒ no picture group at all', () => {
    const { page } = board(demoDocument(), sheetMm({ paper: 'A3', orientation: 'landscape' }))
    expect(page.svg).not.toContain('data-block="picture:')
  })

  it('the title block is emitted once, in content space, at the plan rect', () => {
    const d = demoDocument()
    const { plan, page } = board(d, sheetMm({ paper: 'A1', orientation: 'landscape' }))
    expect(page.svg.split('<g class="title-block" transform=').length - 1).toBe(1)
    expect(page.svg).toContain(
      `<g class="title-block" transform="translate(${fmt(plan.titleBlockRect.x)} ${fmt(plan.titleBlockRect.y)})">`
    )
  })

  it('strip shows Drawing and Page N of M with the offsets passed in', () => {
    const d = demoDocument()
    const layout = computeFormboard(d)
    const plan = planBoard(d, sheetMm({ paper: 'A4', orientation: 'landscape' }), layout)
    const page = renderBoardPage(d, plan, {}, layout, { pageNoStart: 3, pageCount: 9 })
    const strip = page.svg.match(/<g class="page-info">([\s\S]*?)<\/g>/)![1]
    expect(strip).toContain('>Drawing</text>')
    expect(strip).not.toContain('Tile')
    expect(page.svg).toContain('Page 3 of 9')
  })
})
