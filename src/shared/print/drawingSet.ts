/**
 * Assembles the full printable drawing set. It is TWO page sets, not one:
 *
 *   part 0  the one 1:1 drawing page, at whatever paper the document's
 *           `drawing.sheet` asks for (`template.ts` / `board.ts`);
 *   part 1  the Bill of Materials, Wiring Table and Cutlist, always at
 *           `DOCUMENT_PAGE_SHEET` (A4 landscape), framed by the shared
 *           header/footer (`frame.ts`).
 *
 * They are separate because they are different paper sizes and a `PageSet`
 * carries exactly one sheet — the drawing is printed at 1:1 on whatever size
 * that takes, while the tables are reading matter that belongs on A4 whatever
 * the drawing needs. The main process renders one PDF per part and merges
 * them, so `Page N of M` has to run CONTINUOUSLY across the parts: the drawing
 * is page 1 and the document pages count on from it.
 *
 * Two-pass build, as before: pass 1 paginates every table section against the
 * frame's `content` rect (which does not depend on the page numbers printed in
 * it) to learn how many pages each section needs; pass 2 renders every page
 * with the real `pageNo`/`pageCount` and `sectionIndex`/`sectionCount` now that
 * the total page count `M` is known.
 */
import type { HarnessDocument, Id } from '../model/schema'
import { computeFormboard } from '../model/formboard'
import { planBoard, type PartImages } from './board'
import { renderPageFrame, wrapPage } from './frame'
import type { Page, PageSet } from './pageModel'
import { DOCUMENT_PAGE_SHEET, sheetMm, type SheetMm } from './sheet'
import { renderBoardPage } from './template'
import { bomPageTable, cutlistTable, wiringTable, type TableSpec } from './tableData'
import { paginateRows, renderTable, tableWidth, TABLE_STYLE_PAGE, type Column, type Row } from './tables'
import type { PrintBranding } from './titleBlock'

/** Narrows every column's `wMm` proportionally so the table fits `maxW`. */
function scaleCols(cols: Column[], maxW: number): Column[] {
  const w = tableWidth(cols)
  if (w <= maxW) return cols
  const factor = maxW / w
  return cols.map((c) => ({ ...c, wMm: c.wMm * factor }))
}

/** One table section's per-page layout, computed once and reused across both passes. */
interface SectionPlan {
  name: string
  cols: Column[]
  chunks: Row[][]
}

/** Paginates one BOM/Wiring/Cutlist table against the content rect a real page would have. */
function planSection(
  name: string,
  spec: TableSpec,
  sheet: SheetMm,
  tb: HarnessDocument['drawing']['titleBlock'],
  branding: PrintBranding
): SectionPlan {
  // Page numbers/section counts are dummies here: `content` (the only thing we
  // need) does not depend on them — see `renderPageFrame`.
  const { content } = renderPageFrame({
    sheet,
    tb,
    branding,
    section: name,
    sectionIndex: 1,
    sectionCount: 1,
    pageNo: 1,
    pageCount: 1
  })
  const cols = scaleCols(spec.cols, content.w)
  const chunks = paginateRows(spec.rows, cols, TABLE_STYLE_PAGE, content.h)
  return { name, cols, chunks }
}

/**
 * The plan-warning message, for the canvas badge and the export UI. The two
 * per-block warnings are independent — one block can both overlap a neighbour
 * AND sit on a wire — so they are counted separately and joined into one line;
 * "block" rather than "pinout table" because the `table-*` warning ids are
 * raised for pictures and the BOM block too, not only for pinout tables;
 * a title block over content, and anything outside the drawing sheet
 * (`outside-sheet:<kind>:<id>`, every kind counted together), are further
 * unrelated faults with their own.
 *
 * Nothing PRINTS this: the drawing page's info strip is two rows of captions
 * with no room for a warning band, and a warning belongs on screen where it can
 * be fixed anyway. It rides on `DrawingSetOutput.warnings` instead.
 */
export function warningsCentre(warnings: string[]): string | undefined {
  const count = (prefix: string): number => warnings.filter((w) => w.startsWith(prefix)).length
  const parts: string[] = []
  const overlaps = count('table-overlap:')
  if (overlaps > 0) parts.push(`⚠ ${overlaps} block(s) overlapping or too close`)
  const overWire = count('table-over-wire:')
  if (overWire > 0) parts.push(`⚠ ${overWire} block(s) over a wire`)
  if (warnings.includes('title-block-over-content')) parts.push('⚠ title block covers drawing content')
  const outside = count('outside-sheet:')
  if (outside > 0) parts.push(`⚠ ${outside} item(s) outside the drawing sheet — choose a larger sheet or move them`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * The "n bodies have no part picture" note for the export UI. Not a warning —
 * a picture is optional and most harnesses will never have one for every part —
 * so it is a plain count, and `undefined` (nothing to say) when there are none.
 */
export function pictureInfoLine(n: number): string | undefined {
  return n ? `${n} bod${n === 1 ? 'y has' : 'ies have'} no picture` : undefined
}

/** The drawing set as the export path needs it: one `PageSet` per paper size. */
export interface DrawingSetOutput {
  /** `[ the 1:1 drawing page @ drawingSheet, document pages @ A4 landscape ]`. */
  parts: PageSet[]
  /** Total pages across all parts — the `M` in every page's `Page N of M`. */
  pageCount: number
  /** `BoardPlan.warnings`, for the UI to show — never printed. */
  warnings: string[]
  /** `BoardPlan.bodiesWithoutPicture` — drawn bodies with no part photo. */
  bodiesWithoutPicture: Id[]
}

/**
 * Builds the complete drawing set: Drawing (one 1:1 page) → Bill of Materials →
 * Wiring Table → Cutlist, with consistent `Page N of M` / `<section> i of k`
 * numbering running across both parts.
 */
export function buildDrawingSet(
  doc: HarnessDocument,
  drawingSheet: SheetMm,
  branding: PrintBranding,
  images: PartImages = {}
): DrawingSetOutput {
  const tb = doc.drawing.titleBlock
  const docSheet = sheetMm(DOCUMENT_PAGE_SHEET)

  // The formboard layout is computed ONCE and handed to both the planner and
  // the renderer, so the drawing cannot be drawn from a different layout than the
  // one the block placement was solved against.
  const layout = computeFormboard(doc)
  const plan = planBoard(doc, drawingSheet, layout, images)

  const sectionPlans: SectionPlan[] = [
    planSection('Bill of Materials', bomPageTable(doc), docSheet, tb, branding),
    planSection('Wiring Table', wiringTable(doc), docSheet, tb, branding),
    planSection('Cutlist', cutlistTable(doc), docSheet, tb, branding)
  ]

  const pageCount = 1 + sectionPlans.reduce((sum, s) => sum + s.chunks.length, 0)

  // ── Part 0: the one 1:1 drawing page. ──
  const drawing = renderBoardPage(doc, plan, branding, layout, { pageNoStart: 1, pageCount })

  // ── Part 1: the table sections, in order, counting on from the drawing. ──
  const docs: Page[] = []
  let pageNo = 2
  for (const { name, cols, chunks } of sectionPlans) {
    const sectionCount = chunks.length
    chunks.forEach((rows, i) => {
      const frame = renderPageFrame({
        sheet: docSheet,
        tb,
        branding,
        section: name,
        sectionIndex: i + 1,
        sectionCount,
        pageNo,
        pageCount
      })
      const table = renderTable(frame.content.x, frame.content.y, cols, rows, TABLE_STYLE_PAGE).svg
      docs.push({ id: `${name}-${i + 1}`, section: name, svg: wrapPage(docSheet, frame.svg + table) })
      pageNo++
    })
  }

  return {
    parts: [
      { sheet: drawingSheet, pages: [drawing] },
      { sheet: docSheet, pages: docs }
    ],
    pageCount,
    warnings: plan.warnings,
    bodiesWithoutPicture: plan.bodiesWithoutPicture
  }
}
