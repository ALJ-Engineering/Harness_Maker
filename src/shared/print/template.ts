/**
 * Renders a `BoardPlan` as ONE 1:1 drawing page: the harness drawn at exactly
 * true mm scale (no fit-to-page, no shrinking — the project's locked print
 * rule) on the single sheet the
 * document chose (`drawing.sheet`, A4–A0 or a plotter roll), so the print can
 * be laid on the formboard as a full-size build template.
 *
 * The page is 1:1 BY CONSTRUCTION, not by convention: the nested `<svg>`'s
 * `width`/`height` (mm on the printed page) and its `viewBox` width/height
 * (mm of harness content shown) are the identical `printable.w`/`printable.h`
 * numbers — one printed mm is always one model mm, so a printed segment
 * measures out to its true modelled length.
 *
 * Model space vs sheet space:
 *   MODEL mm     where the harness and every block live. `plan.sheetRect` is
 *                the printable area in model mm, its top-left is
 *                `plan.contentOrigin`.
 *   SHEET mm     the printed page. The nested `<svg>` sits at
 *                `(TEMPLATE_MARGIN, TEMPLATE_MARGIN)` inside the page and its
 *                `viewBox` starts at `contentOrigin` — that offset (not a
 *                `translate`/`scale`) is what selects the part of the model
 *                that prints. Anything outside it is clipped; the planner has
 *                already flagged it as `outside-sheet:`.
 *
 * Everything the drawing *is* — harness, pinout tables, BOM block, title
 * block — is drawn once, in MODEL mm, into that nested `<svg>`. Only the page
 * furniture (the 100 mm scale bar and the info strip) is drawn in sheet space,
 * outside the nested `<svg>`.
 */
import type { HarnessDocument, TitleBlock } from '../model/schema'
import type { FbLayout } from '../model/formboard'
import { renderDrawingGroup } from '../export/svg'
import { wrapPage } from './frame'
import type { Page } from './pageModel'
import { TEMPLATE_MARGIN } from './sheet'
import { TABLE_PAD, TILE_STRIP_H, type BoardPlan } from './board'
import { renderTable, TABLE_STYLE_SHEET } from './tables'
import { pictureBlockSize, renderPictureBlock } from './picture'
import { renderTitleBlock, type PrintBranding } from './titleBlock'
import { escapeXml, fmt, svgText, PT } from './text'

/**
 * The content gutter and the info-strip height are DEFINED in `./board` (the
 * plan owns the geometry; this module only draws it) and re-exported here
 * because the page renderer and its test have always imported them from here.
 * One definition, two import paths — never two constants.
 */
export { TEMPLATE_GUTTER, TILE_STRIP_H } from './board'
/**
 * Horizontal inset (mm) of the left/right info-strip text (and the scale bar)
 * from the printable area's edges, so the strip does not run flush into the
 * printer margin. Centre text is unaffected.
 */
export const STRIP_TEXT_INSET = 8

/** Length of the page-space check bar (mm) — the number the builder measures. */
const SCALE_BAR_MM = 100
/** Info-strip row offsets from `stripY` (mm): bar centreline, its caption baseline, caption row baseline. */
const SCALE_BAR_ROW_Y = 4
const SCALE_BAR_CAPTION_Y = 5.2
const STRIP_TEXT_ROW_Y = 10.5
/** Half-height of the scale bar's end ticks (mm). */
const SCALE_BAR_TICK = 1.5

/**
 * The plan's blocks and the title block, in MODEL mm, ready to go inside the
 * nested drawing `<svg>`. Each block is a `translate` to its planned rect with the
 * table drawn at the local origin, so the plan's rect is the single source of
 * truth for where a block prints — the same rect the canvas overlay drags.
 *
 * A pinout rect is `tableWidth + TABLE_PAD` wide (the planner's slack), so the
 * table is drawn at `TABLE_PAD / 2` to sit centred in its own rect. A picture
 * block fills its rect exactly and is drawn by `picture.ts` — the same call the
 * canvas node makes, so screen and page are one string.
 *
 * `data-block` is what the tests key on, and what a future canvas↔page diff
 * would key on: it names the block that owns the group.
 */
function renderBlocks(plan: BoardPlan, tb: TitleBlock | undefined, branding: PrintBranding): string {
  const parts: string[] = []
  for (const t of plan.tables) {
    parts.push(
      `<g class="block" data-block="pinout:${escapeXml(t.id)}" transform="translate(${fmt(t.rect.x)} ${fmt(t.rect.y)})">` +
        renderTable(TABLE_PAD / 2, 0, t.spec!.cols, t.spec!.rows, TABLE_STYLE_SHEET).svg +
        `</g>`
    )
  }
  for (const p of plan.pictures) {
    parts.push(
      `<g class="block" data-block="picture:${escapeXml(p.id)}" transform="translate(${fmt(p.rect.x)} ${fmt(p.rect.y)})">` +
        renderPictureBlock(pictureBlockSize(p.image!, p.view), p.image!, p.caption ?? '', p.view) +
        `</g>`
    )
  }
  const b = plan.bom
  parts.push(
    `<g class="block" data-block="bom" transform="translate(${fmt(b.rect.x)} ${fmt(b.rect.y)})">` +
      renderTable(0, 0, b.spec!.cols, b.spec!.rows, TABLE_STYLE_SHEET, { title: b.title }).svg +
      `</g>`
  )
  parts.push(
    `<g class="title-block" transform="translate(${fmt(plan.titleBlockRect.x)} ${fmt(plan.titleBlockRect.y)})">` +
      renderTitleBlock(0, 0, tb, branding) +
      `</g>`
  )
  return parts.join('')
}

/** Where the drawing page sits in the running page numbering of the whole export. */
export interface TileOpts {
  /** `N` in the drawing page's `Page N of M`. */
  pageNoStart: number
  /** `M` — the whole drawing set's page count, the drawing page plus document pages. */
  pageCount: number
}

/**
 * Renders `plan` as the one drawing page: the harness and the plan's blocks at
 * true mm scale on a `plan.sheet`-sized page, with an info strip and a 100 mm
 * scale bar. The paper comes from the PLAN, never as a second argument —
 * `plan.printable` and `plan.sheetRect` are derived from it, so a separate
 * `sheet` parameter could only ever disagree with the plan and silently render
 * the wrong area.
 *
 * The scale bar is drawn in PAGE space (in the info strip), not in content
 * space: `renderDrawingGroup`'s bar sits under the harness bbox, which can be
 * clipped off the sheet. A page-space bar always prints and is just as valid a
 * 1:1 check: the page `<svg>` is `wMm × hMm` over a `0 0 wMm hMm` viewBox, so
 * one page unit is one printed mm.
 *
 * `layout` is passed in rather than recomputed so a caller that already ran
 * `computeFormboard` for `planBoard` does not pay for it twice — and so the
 * page is guaranteed to be drawn from the very layout the plan was made from.
 */
export function renderBoardPage(
  doc: HarnessDocument,
  plan: BoardPlan,
  branding: PrintBranding,
  layout: FbLayout,
  opts: TileOpts
): Page {
  // scaleBar: false — the content-space bar sits under the harness and can be
  // clipped; the strip draws a page-space bar instead.
  const content =
    renderDrawingGroup(layout, { textScale: 1, scaleBar: false }) +
    renderBlocks(plan, doc.drawing.titleBlock, branding)

  const { sheet, printable, contentOrigin } = plan

  const tb = doc.drawing.titleBlock
  const centreLabel = `${tb?.partNumber ?? tb?.title ?? 'Harness'} ${tb?.revision ?? ''}`.trim()

  const nested =
    `<svg x="${fmt(TEMPLATE_MARGIN)}" y="${fmt(TEMPLATE_MARGIN)}" width="${fmt(printable.w)}" height="${fmt(printable.h)}" ` +
    `viewBox="${fmt(contentOrigin.x)} ${fmt(contentOrigin.y)} ${fmt(printable.w)} ${fmt(printable.h)}" overflow="hidden">` +
    content +
    `</svg>`

  const stripY = sheet.hMm - TEMPLATE_MARGIN - TILE_STRIP_H
  const stripFont = 7 * PT
  // Row 1: the page-space scale bar. Page units ARE printed mm (see the
  // function header), so a 100-unit line measures 100 mm on the paper.
  const barY = stripY + SCALE_BAR_ROW_Y
  const barX0 = TEMPLATE_MARGIN + STRIP_TEXT_INSET
  const barX1 = barX0 + SCALE_BAR_MM
  const st = 'stroke="#000" stroke-width="0.5"'
  const tick = (x: number): string =>
    `<line x1="${fmt(x)}" y1="${fmt(barY - SCALE_BAR_TICK)}" x2="${fmt(x)}" y2="${fmt(barY + SCALE_BAR_TICK)}" ${st}/>`
  const scaleBar =
    `<g class="scale-bar-page">` +
    `<line x1="${fmt(barX0)}" y1="${fmt(barY)}" x2="${fmt(barX1)}" y2="${fmt(barY)}" ${st}/>` +
    tick(barX0) +
    tick(barX1) +
    svgText(barX1 + 4, stripY + SCALE_BAR_CAPTION_Y, `${SCALE_BAR_MM} mm — verify at 1:1`, { size: stripFont }) +
    `</g>`

  // Row 2: the captions — the section on the left, the harness in the middle,
  // the running page number of the whole set on the right.
  const textY = stripY + STRIP_TEXT_ROW_Y
  const strip =
    `<g class="page-info">` +
    svgText(TEMPLATE_MARGIN + STRIP_TEXT_INSET, textY, 'Drawing', { size: stripFont }) +
    svgText(sheet.wMm / 2, textY, centreLabel, { size: stripFont, anchor: 'middle' }) +
    svgText(sheet.wMm - TEMPLATE_MARGIN - STRIP_TEXT_INSET, textY, `1:1 — verify scale bar = 100 mm · Page ${opts.pageNoStart} of ${opts.pageCount}`, { size: stripFont, anchor: 'end' }) +
    `</g>`

  return { id: 'drawing', section: 'Drawing', svg: wrapPage(sheet, nested + scaleBar + strip) }
}
