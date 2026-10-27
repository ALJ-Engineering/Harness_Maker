import type { TitleBlock } from '@shared/model/schema'
import { fmt, fitText, svgText } from './text'
import { PAGE_MARGIN, type Rect, type SheetMm } from './sheet'
import type { PrintBranding } from './titleBlock'

/** Options shared by the page header and footer. */
export interface FrameOpts {
  sheet: SheetMm
  tb: TitleBlock | undefined
  branding: PrintBranding
  section: string
  sectionIndex: number
  sectionCount: number
  pageNo: number
  pageCount: number
  /** Optional centred footer message (e.g. plan warnings on the drawing page). */
  centre?: string
}

/** Header block height on table pages (mm). */
export const HEADER_H = 20
/** Footer band height (mm). */
export const FOOTER_H = 6

const HEADER_LABEL_W = 30
/** Preferred width (mm) of the header's value column — narrowed on a small sheet. */
const HEADER_VALUE_W = 150
const LOGO_W = 36
const LOGO_H = 12
const GAP_BELOW_HEADER = 5
/** Clearance (mm) kept between the header box and the logo. */
const HEADER_LOGO_GAP = 4

/**
 * Width (mm) of the header's value column on this sheet. The preferred 150 mm
 * plus the 30 mm label column runs to x = 190 on A4 portrait, where the logo
 * starts at x = 164 — the box printed through the logo. Deriving the
 * column from the sheet keeps the header clear of the logo on every paper.
 */
function headerValueW(sheet: SheetMm): number {
  return Math.min(
    HEADER_VALUE_W,
    sheet.wMm - 2 * PAGE_MARGIN - LOGO_W - HEADER_LOGO_GAP - HEADER_LABEL_W
  )
}

/** Renders the 3-row Title/Part Number/Description header, with the logo top-right. */
function renderHeader(o: FrameOpts): string {
  const { sheet, tb, branding } = o
  const x = PAGE_MARGIN
  const y = PAGE_MARGIN
  const rowH = HEADER_H / 3
  const rows: Array<[string, string]> = [
    ['Title:', tb?.title ?? '----'],
    ['Part Number:', tb?.partNumber ?? '----'],
    ['Description:', tb?.description ?? '----']
  ]

  const valueW = headerValueW(sheet)

  const parts: string[] = []
  parts.push(
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(HEADER_LABEL_W + valueW)}" height="${fmt(HEADER_H)}" fill="none" stroke="#000" stroke-width="0.4"/>`
  )
  parts.push(
    `<line x1="${fmt(x + HEADER_LABEL_W)}" y1="${fmt(y)}" x2="${fmt(x + HEADER_LABEL_W)}" y2="${fmt(y + HEADER_H)}" stroke="#888" stroke-width="0.2"/>`
  )
  rows.forEach(([label, value], i) => {
    const ry = y + i * rowH
    if (i > 0) {
      parts.push(
        `<line x1="${fmt(x)}" y1="${fmt(ry)}" x2="${fmt(x + HEADER_LABEL_W + valueW)}" y2="${fmt(ry)}" stroke="#888" stroke-width="0.2"/>`
      )
    }
    parts.push(svgText(x + HEADER_LABEL_W - 2, ry + rowH / 2 + 1.2, label, { size: 3.2, anchor: 'end', weight: 'bold' }))
    parts.push(svgText(x + HEADER_LABEL_W + 2, ry + rowH / 2 + 1.2, fitText(value, 3.2, valueW - 4), { size: 3.2 }))
  })

  // Logo, top-right of the header band.
  const logoX = x + (sheet.wMm - 2 * PAGE_MARGIN) - LOGO_W
  const logoY = y
  if (branding.logoDataUri?.startsWith('data:image/')) {
    parts.push(`<image x="${fmt(logoX)}" y="${fmt(logoY)}" width="${LOGO_W}" height="${LOGO_H}" preserveAspectRatio="xMidYMid meet" href="${branding.logoDataUri}"/>`)
  }

  return `<g class="page-header">${parts.join('')}</g>`
}

/** Renders the `<section> i of k` / `Page N of M` footer. Standalone-usable for the drawing sheet page. */
export function renderFooter(o: FrameOpts): string {
  const { sheet, section, sectionIndex, sectionCount, pageNo, pageCount, centre } = o
  const y = sheet.hMm - PAGE_MARGIN + 2
  const parts: string[] = []
  parts.push(svgText(PAGE_MARGIN, y, `${section} ${sectionIndex} of ${sectionCount}`, { size: 3 }))
  if (centre) {
    parts.push(svgText(sheet.wMm / 2, y, centre, { size: 3, anchor: 'middle' }))
  }
  parts.push(svgText(sheet.wMm - PAGE_MARGIN, y, `Page ${pageNo} of ${pageCount}`, { size: 3, anchor: 'end' }))
  return `<g class="page-footer">${parts.join('')}</g>`
}

/**
 * Renders the common table-page frame: header (Title/Part Number/Description + logo)
 * and footer (section + page numbers). Returns the free content rect between them.
 */
export function renderPageFrame(o: FrameOpts): { svg: string; content: Rect } {
  const header = renderHeader(o)
  const footer = renderFooter(o)
  const content: Rect = {
    x: PAGE_MARGIN,
    y: PAGE_MARGIN + HEADER_H + GAP_BELOW_HEADER,
    w: o.sheet.wMm - 2 * PAGE_MARGIN,
    h: o.sheet.hMm - 2 * PAGE_MARGIN - HEADER_H - GAP_BELOW_HEADER - FOOTER_H
  }
  return { svg: `${header}${footer}`, content }
}

/** Wraps page content in an exact sheet-sized `<svg>` with a white background. */
export function wrapPage(sheet: SheetMm, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.wMm}mm" height="${sheet.hMm}mm" viewBox="0 0 ${sheet.wMm} ${sheet.hMm}" font-family="Helvetica, Arial, sans-serif"><rect x="0" y="0" width="${sheet.wMm}" height="${sheet.hMm}" fill="#fff"/>${inner}</svg>`
}
