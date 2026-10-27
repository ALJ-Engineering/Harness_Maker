import type { Approval, TitleBlock } from '@shared/model/schema'
import { DEFAULT_CONFIDENTIALITY } from '@shared/model/schema'
import { fmt, fitText, svgText, wrapText, PT } from './text'

/** Overall title-block footprint in mm (mirrors the reference drawing's bottom-right block). */
export const TITLE_BLOCK_W = 150
export const TITLE_BLOCK_H = 30

/**
 * Print-time branding assets. The logo comes from the parts library
 * (`<library>/branding/logo.*`); absent, the logo cell is simply left empty.
 */
export interface PrintBranding {
  logoDataUri?: string
}

// Column widths (mm), left to right, summing to TITLE_BLOCK_W.
const COL_TITLE_W = 50 // Title / Description, stacked
const COL_PN_W = 30 // Part Number / Revision, stacked
const COL_APPROVALS_W = 40 // approvals grid
const COL_BRAND_W = TITLE_BLOCK_W - COL_TITLE_W - COL_PN_W - COL_APPROVALS_W // logo + confidentiality

const HALF_H = TITLE_BLOCK_H / 2 // 15mm — height of each stacked label/value cell

const APPROVAL_HEADER_H = 4
const APPROVAL_ROW_H = 5.5
const APPROVAL_NAME_W = 22
const APPROVAL_DATE_W = 18

/** A bordered cell with a small grey label at the top and a value beneath it. */
function labelValueCell(x: number, y: number, w: number, h: number, label: string, value: string | undefined): string {
  const parts: string[] = []
  parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="none" stroke="#888" stroke-width="0.2"/>`)
  parts.push(svgText(x + 1.5, y + 3.2, label, { size: 5 * PT, fill: '#666' }))
  parts.push(svgText(x + 1.5, y + h - 2, fitText(value ?? '', 8 * PT, w - 3), { size: 8 * PT, weight: 'bold' }))
  return parts.join('')
}

/** Renders the title block (Title/PN/Description/Revision, approvals grid, logo, confidentiality). */
export function renderTitleBlock(x: number, y: number, tb: TitleBlock | undefined, branding: PrintBranding): string {
  const parts: string[] = []

  parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${TITLE_BLOCK_W}" height="${TITLE_BLOCK_H}" fill="none" stroke="#000" stroke-width="0.5"/>`)

  // Left column: Title over Description.
  parts.push(labelValueCell(x, y, COL_TITLE_W, HALF_H, 'Title', tb?.title))
  parts.push(labelValueCell(x, y + HALF_H, COL_TITLE_W, HALF_H, 'Description', tb?.description))

  // Middle-left column: Part Number over Revision.
  const pnX = x + COL_TITLE_W
  parts.push(labelValueCell(pnX, y, COL_PN_W, HALF_H, 'Part Number', tb?.partNumber))
  parts.push(labelValueCell(pnX, y + HALF_H, COL_PN_W, HALF_H, 'Revision', tb?.revision))

  // Approvals grid: header row (Name/Date) + 4 rows (Drawn By/Eng Approved/Mfg Approved/QA).
  const gx = pnX + COL_PN_W
  const gy = y
  const gridH = APPROVAL_HEADER_H + 4 * APPROVAL_ROW_H
  parts.push(`<rect x="${fmt(gx)}" y="${fmt(gy)}" width="${fmt(COL_APPROVALS_W)}" height="${fmt(gridH)}" fill="none" stroke="#888" stroke-width="0.2"/>`)
  parts.push(`<rect x="${fmt(gx)}" y="${fmt(gy)}" width="${fmt(COL_APPROVALS_W)}" height="${fmt(APPROVAL_HEADER_H)}" fill="#e6e6e6" stroke="#888" stroke-width="0.2"/>`)
  parts.push(svgText(gx + APPROVAL_NAME_W / 2, gy + APPROVAL_HEADER_H - 0.9, 'Name', { size: 3.4 * PT, anchor: 'middle', weight: 'bold' }))
  parts.push(
    svgText(gx + APPROVAL_NAME_W + APPROVAL_DATE_W / 2, gy + APPROVAL_HEADER_H - 0.9, 'Date', {
      size: 3.4 * PT,
      anchor: 'middle',
      weight: 'bold'
    })
  )
  parts.push(
    `<line x1="${fmt(gx + APPROVAL_NAME_W)}" y1="${fmt(gy)}" x2="${fmt(gx + APPROVAL_NAME_W)}" y2="${fmt(gy + gridH)}" stroke="#888" stroke-width="0.2"/>`
  )

  const rows: Array<[string, Approval | undefined]> = [
    ['Drawn By', tb?.drawnBy],
    ['Eng Approved', tb?.engApproved],
    ['Mfg Approved', tb?.mfgApproved],
    ['QA', tb?.qa]
  ]
  const approvalValueFont = 4.2 * PT
  // Shared baseline convention (see tables.ts): top + h/2 + fontMm*0.35.
  const approvalValueBaseline = (ry: number): number => ry + APPROVAL_ROW_H / 2 + approvalValueFont * 0.35
  rows.forEach(([label, appr], i) => {
    const ry = gy + APPROVAL_HEADER_H + i * APPROVAL_ROW_H
    parts.push(`<rect x="${fmt(gx)}" y="${fmt(ry)}" width="${fmt(COL_APPROVALS_W)}" height="${fmt(APPROVAL_ROW_H)}" fill="none" stroke="#ccc" stroke-width="0.15"/>`)
    parts.push(svgText(gx + 1, ry + 1.9, label, { size: 2.6 * PT, fill: '#666' }))
    parts.push(
      svgText(gx + 1, approvalValueBaseline(ry), fitText(appr?.name ?? '----', approvalValueFont, APPROVAL_NAME_W - 2), {
        size: approvalValueFont
      })
    )
    parts.push(
      svgText(gx + APPROVAL_NAME_W + 1, approvalValueBaseline(ry), fitText(appr?.date ?? '----', approvalValueFont, APPROVAL_DATE_W - 2), {
        size: approvalValueFont
      })
    )
  })

  // Right cell: logo above wrapped confidentiality text.
  const rx = gx + COL_APPROVALS_W
  parts.push(`<rect x="${fmt(rx)}" y="${fmt(y)}" width="${fmt(COL_BRAND_W)}" height="${TITLE_BLOCK_H}" fill="none" stroke="#888" stroke-width="0.2"/>`)
  const logoX = rx + (COL_BRAND_W - 26) / 2
  const logoY = y + 1
  if (branding.logoDataUri?.startsWith('data:image/')) {
    parts.push(`<image x="${fmt(logoX)}" y="${fmt(logoY)}" width="26" height="8" preserveAspectRatio="xMidYMid meet" href="${branding.logoDataUri}"/>`)
  }

  const confidentiality = tb?.confidentiality ?? DEFAULT_CONFIDENTIALITY
  const lineH = 4.5 * PT + 0.6
  const lines = wrapText(confidentiality, 4.5 * PT, 28, 3)
  lines.forEach((ln, i) => {
    parts.push(svgText(rx + 1, logoY + 10 + i * lineH, ln, { size: 4.5 * PT, fill: '#444' }))
  })

  return `<g class="title-block">${parts.join('')}</g>`
}
