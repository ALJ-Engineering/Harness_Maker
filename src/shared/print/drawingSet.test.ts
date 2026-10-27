import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { buildDrawingSet, pictureInfoLine, warningsCentre } from './drawingSet'
import { pageSetToHtml } from './html'
import { demoDocument } from '../model/document'
import { sheetMm } from './sheet'

describe('buildDrawingSet', () => {
  const out = buildDrawingSet(demoDocument(), sheetMm({ paper: 'A3', orientation: 'landscape' }), {})

  it('part 0 = the one drawing page at the drawing sheet, part 1 = documents at A4 landscape', () => {
    expect(out.parts.length).toBe(2)
    expect(out.parts[0].sheet).toEqual({ wMm: 420, hMm: 297 })
    expect(out.parts[1].sheet).toEqual({ wMm: 297, hMm: 210 })
    for (const p of out.parts[0].pages) expect(p.section).toBe('Drawing')
    expect([...new Set(out.parts[1].pages.map((p) => p.section))]).toEqual([
      'Bill of Materials',
      'Wiring Table',
      'Cutlist'
    ])
  })

  it('Page N of M runs across both parts', () => {
    const all = out.parts.flatMap((p) => p.pages)
    expect(all.length).toBe(out.pageCount)
    all.forEach((p, i) => expect(p.svg).toContain(`Page ${i + 1} of ${out.pageCount}`))
  })

  it('exactly one Drawing page on every paper, at the sheet size, with no registration marks', () => {
    const d = demoDocument()
    // Spread the harness so that the old tiler would have needed several A4 tiles.
    d.placements = d.placements.map((p) => ({ ...p, pos: { x: p.pos.x * 3, y: p.pos.y * 2 } }))
    for (const cfg of [
      { paper: 'A4', orientation: 'landscape' },
      { paper: 'A3', orientation: 'portrait' },
      { paper: 'A0', orientation: 'landscape' },
      { paper: 'Plotter', orientation: 'landscape', lengthMm: 3000 }
    ] as const) {
      const sheet = sheetMm(cfg)
      const s = buildDrawingSet(d, sheet, {})
      const drawing = s.parts.flatMap((p) => p.pages).filter((p) => p.section === 'Drawing')
      expect(drawing.length).toBe(1)
      expect(s.parts[0].pages).toEqual(drawing)
      expect(drawing[0].svg).toContain(
        `width="${sheet.wMm}mm" height="${sheet.hMm}mm" viewBox="0 0 ${sheet.wMm} ${sheet.hMm}"`
      )
      expect(drawing[0].svg).not.toContain('r="1.5"')
      expect('tileCount' in s).toBe(false)
    }
  })

  it('the drawing page carries no scale note', () => {
    for (const p of out.parts[0].pages) expect(p.svg).not.toContain('not a build template')
  })

  it('pageCount = 1 drawing page + the A4 document pages', () => {
    expect(out.pageCount).toBe(1 + out.parts[1].pages.length)
    expect(out.pageCount).toBe(out.parts.reduce((n, p) => n + p.pages.length, 0))
  })

  it('the drawing page is the drawing sheet, every document page is A4 landscape', () => {
    for (const p of out.parts[0].pages) expect(p.svg).toContain('width="420mm" height="297mm" viewBox="0 0 420 297"')
    for (const p of out.parts[1].pages) expect(p.svg).toContain('width="297mm" height="210mm" viewBox="0 0 297 210"')
  })

  it('a 60-wire harness spills the wiring table onto ≥2 pages, numbered i of k', () => {
    const d = demoDocument()
    const c = d.connectors[0]
    for (let i = 0; i < 60; i++) {
      c.cavities.push({ id: `cav${i}`, position: `${100 + i}`, status: 'populated' })
      d.wires.push({ id: `wx${i}`, ends: [{ type: 'cavity', cavityId: `cav${i}` }, { type: 'freeTerminal', terminalId: d.freeTerminals[0].id }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } })
    }
    const s = buildDrawingSet(d, sheetMm({ paper: 'A3', orientation: 'landscape' }), {})
    const wiring = s.parts[1].pages.filter((p) => p.section === 'Wiring Table')
    expect(wiring.length).toBeGreaterThanOrEqual(2)
    expect(wiring[0].svg).toContain(`Wiring Table 1 of ${wiring.length}`)
    expect(wiring[wiring.length - 1].svg).toContain(`Wiring Table ${wiring.length} of ${wiring.length}`)
  })

  it('the document pages are always A4, so the wide tables are scaled to the A4 content width', () => {
    const s = buildDrawingSet(demoDocument(), sheetMm({ paper: 'A1', orientation: 'landscape' }), {})
    const wiring = s.parts[1].pages.find((p) => p.section === 'Wiring Table')!.svg
    const xs = [...wiring.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((m) => Number(m[1]) + Number(m[2]))
    expect(Math.max(...xs)).toBeLessThanOrEqual(297)
  })
})

describe('part pictures in the set', () => {
  it('with no images every drawn body is reported as without a picture and no page carries one', () => {
    const d = demoDocument()
    const s = buildDrawingSet(d, sheetMm({ paper: 'A3', orientation: 'landscape' }), {})
    expect(s.bodiesWithoutPicture.length).toBeGreaterThan(0)
    for (const p of s.parts[0].pages) expect(p.svg).not.toContain('data-block="picture:')
  })

  it('an image for a housing puts that picture on the drawing page and off the without list', () => {
    const d = demoDocument()
    const id = d.connectors[0].id
    d.connectors[0].housing = { partNumber: 'HSG-A' }
    const s = buildDrawingSet(d, sheetMm({ paper: 'A3', orientation: 'landscape' }), {}, {
      'HSG-A': { href: 'data:image/png;base64,AAAA', pxW: 400, pxH: 300 }
    })
    expect(s.bodiesWithoutPicture).not.toContain(id)
    expect(s.parts[0].pages.some((p) => p.svg.includes(`data-block="picture:${id}"`))).toBe(true)
  })
})

/**
 * THE PRINT PATH MUST NOT CONTAIN A CSS THEME TOKEN.
 *
 * The renderer is themed with a custom-property layer (`index.css`:
 * `--ink`, `--panel-bg`, …). The printed sheet is white paper and the PDF is a
 * manufacturing drawing, so `src/shared/print/` and `src/shared/export/` are
 * deliberately outside that layer and must emit literal colours only.
 *
 * This is a guard, not a style preference, because a leak is SILENT. The hidden
 * print window (`src/main/pdf.ts`) defines no custom properties at all, so an
 * undefined `var()` resolves to the CSS **initial** value of whatever property
 * it sits on. Both halves were measured on the real export:
 *
 *   fill="var(--ink)"    → initial is `black`  → the mark survives in the wrong
 *                          colour (grey title-block labels printed black)
 *   stroke="var(--ink)"  → initial is `none`   → THE MARK DISAPPEARS (the title
 *                          block's 0.5 mm outer frame vanished entirely)
 *
 * Nothing else notices either case: with both sabotages in place
 * `scripts/check-pdf-scale.mjs` still measured the 100 mm bar at 1181.000 px and
 * every other test in `src/shared/print/` still passed. The scale check measures
 * geometry; a colour is invisible to it. These two tests are the only thing
 * standing between a theme token and a manufacturing drawing with a missing
 * line, so they are deliberately blunt — do not weaken them, and do not write
 * `var(--` in a PRODUCTION file in these folders, not even inside a comment.
 * (`*.test.ts` is excluded from the scan below for exactly that reason: this
 * very comment would otherwise fail it.)
 */
describe('no theme token reaches the print path', () => {
  // A document and a branding chosen to light up as much of the renderer as one
  // fixture can: the drawing page AND the A4 document pages, the title block (with
  // a logo, so its `<image>` branch runs rather than the wordmark fallback),
  // pinout tables, the BOM block, and a part picture (`renderPictureBlock` is
  // its own colour-emitting path and is otherwise unexercised here).
  const doc = demoDocument()
  doc.connectors[0].housing = { partNumber: 'HSG-A' }
  // A broken typed length, so the red segment-label branch is rendered too.
  doc.segments.find((s) => s.id === 'seg-1')!.specifiedLengthMm = 370
  const out = buildDrawingSet(
    doc,
    sheetMm({ paper: 'A3', orientation: 'landscape' }),
    { logoDataUri: 'data:image/png;base64,AAAA' },
    { 'HSG-A': { href: 'data:image/png;base64,AAAA', pxW: 400, pxH: 300 } }
  )

  it('no rendered page — drawing page or document page — contains a var(--token)', () => {
    // Guard the fixture first: an empty page set would pass every assertion
    // below while proving nothing.
    const sections = out.parts.flatMap((p) => p.pages.map((x) => x.section))
    expect(sections).toContain('Drawing')
    expect(sections).toContain('Bill of Materials')
    expect(sections).toContain('Wiring Table')
    expect(sections).toContain('Cutlist')
    expect(out.parts[0].pages.some((p) => p.svg.includes('data-block="picture:'))).toBe(true)
    expect(out.parts[0].pages.some((p) => p.svg.includes('fill="#d32f2f"'))).toBe(true)

    for (const [pi, part] of out.parts.entries()) {
      for (const [i, page] of part.pages.entries()) {
        expect(page.svg, `part ${pi} page ${i + 1} (${page.section}) emits a CSS custom property`)
          .not.toContain('var(--')
        // `var( --ink )` is VALID CSS and slips straight past the literal
        // above, so the second assertion is the one that actually closes the
        // rule. It can be this blunt because the print output contains no
        // `var()` of any kind — and cannot: `var()` only ever takes a custom
        // property. If that ever changes, tighten this to a regex rather than
        // deleting it.
        expect(page.svg, `part ${pi} page ${i + 1} (${page.section}) emits a var()`)
          .not.toContain('var(')
      }
      // The pages are wrapped for Chromium by `pageSetToHtml`, which adds a
      // <style> block of its own — a second, very plausible place for a token
      // to be introduced, and the exact string the print window loads.
      const html = pageSetToHtml(part, 'guard')
      expect(html, `part ${pi} print HTML emits a CSS custom property`).not.toContain('var(--')
      expect(html, `part ${pi} print HTML emits a var()`).not.toContain('var(')
    }
  })

  it('no source file under print/ or export/ mentions a var(--token)', () => {
    // The rendered check above can only cover what this fixture draws, and the
    // demo document has no sleeving, twists, labels, branch points or bundles —
    // so several drawing-group colour sites are never reached by it. A source
    // scan covers every branch, including the ones no fixture executes.
    const printDir = dirname(fileURLToPath(import.meta.url))
    const roots = [printDir, join(printDir, '..', 'export')]
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        // Production sources only — a test may legitimately name the string it
        // is forbidding, as this one does.
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(p)
      }
    }
    for (const r of roots) walk(r)

    // Guard the scan itself: a walk that found nothing — a renamed folder, a
    // broken recursion — would pass the real assertion silently. 16 production
    // files today (12 under print/, 4 under export/); the floor is loose enough
    // to survive a deletion and tight enough to catch a walk that found one
    // folder or none. The named files are the two biggest colour emitters.
    expect(files.length).toBeGreaterThanOrEqual(14)
    expect(files.some((f) => f.endsWith('titleBlock.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('tables.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith('svg.ts'))).toBe(true)

    // `var(` rather than `var(--`, for the same whitespace reason as above —
    // and these folders contain no `var(` of any kind today, so it costs
    // nothing to be blunt.
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('var('))
    expect(offenders, 'these print/export sources reference a CSS theme token').toEqual([])
  })
})

describe('pictureInfoLine', () => {
  it('says nothing when every body has a picture', () => {
    expect(pictureInfoLine(0)).toBeUndefined()
  })

  it('counts the bodies without one, singular and plural', () => {
    expect(pictureInfoLine(1)).toBe('1 body has no picture')
    expect(pictureInfoLine(4)).toBe('4 bodies have no picture')
  })
})

describe('warningsCentre', () => {
  it('says nothing when the plan is clean', () => {
    expect(warningsCentre([])).toBeUndefined()
  })

  it('reports blocks sitting on a wire on their own footer line', () => {
    expect(warningsCentre(['table-over-wire:c1', 'table-over-wire:c2'])).toBe(
      '⚠ 2 block(s) over a wire'
    )
  })

  it('reports both kinds at once — one block can overlap AND cover a wire', () => {
    expect(warningsCentre(['table-overlap:c1', 'table-over-wire:c1'])).toBe(
      '⚠ 1 block(s) overlapping or too close · ⚠ 1 block(s) over a wire'
    )
  })

  it('names a title block over content', () => {
    expect(warningsCentre(['title-block-over-content'])).toBe('⚠ title block covers drawing content')
  })

  it('counts every item outside the drawing sheet, whatever its kind', () => {
    expect(warningsCentre(['outside-sheet:body:x'])).toBe(
      '⚠ 1 item(s) outside the drawing sheet — choose a larger sheet or move them'
    )
    expect(warningsCentre(['outside-sheet:segment:s1', 'outside-sheet:block:bom:bom', 'outside-sheet:label:l'])).toBe(
      '⚠ 3 item(s) outside the drawing sheet — choose a larger sheet or move them'
    )
  })

  it('joins an outside-sheet warning onto the other lines', () => {
    expect(warningsCentre(['table-overlap:c1', 'outside-sheet:block:pinout:c2'])).toBe(
      '⚠ 1 block(s) overlapping or too close · ⚠ 1 item(s) outside the drawing sheet — choose a larger sheet or move them'
    )
  })
})
