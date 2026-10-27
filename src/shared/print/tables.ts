import { fmt, fitText, svgText, PT, estimateTextWidthMm } from './text'
import { strokeForColor } from '../model/colors'

export interface Column {
  key: string
  title: string
  wMm: number
  align?: 'start' | 'end'
}

/** A table cell: plain text, or an object with optional colour swatch / wrapped lines. */
export type Cell = string | { text: string; swatch?: string; lines?: string[] }

export type Row = Record<string, Cell>

export interface TableStyle {
  fontMm: number
  rowH: number
  headerH: number
  pad: number
}

export const TABLE_STYLE_PAGE: TableStyle = { fontMm: 7 * PT, rowH: 5.5, headerH: 6, pad: 1.2 }
export const TABLE_STYLE_SHEET: TableStyle = { fontMm: 7 * PT, rowH: 4.8, headerH: 5.2, pad: 1 }

/** Sums column widths to get the overall table width in mm. */
export function tableWidth(cols: Column[]): number {
  return cols.reduce((s, c) => s + c.wMm, 0)
}

/** Extra width `fitColumns` adds past the estimate, in mm. */
const FIT_SLACK_MM = 1

/** A cell's plain text (no swatch, first line of a wrapped cell). */
const cellText = (c: Cell): string => (typeof c === 'string' ? c : c.text)

/**
 * Widens each column named in `keys` so its title and every cell fit at
 * `style` without an ellipsis. A column is never narrowed below its own `wMm`.
 * Only plain-text columns: a swatch's extra 5 mm is not counted.
 */
export function fitColumns(cols: Column[], rows: Row[], style: TableStyle, keys: string[]): Column[] {
  return cols.map((c) => {
    if (!keys.includes(c.key)) return c
    const texts = [c.title, ...rows.map((r) => cellText(r[c.key] ?? ''))]
    // +FIT_SLACK_MM: the width estimate is per-glyph and runs short on symbols such as "→".
    const need = Math.max(...texts.map((t) => estimateTextWidthMm(t, style.fontMm))) + 2 * style.pad + FIT_SLACK_MM
    return need > c.wMm ? { ...c, wMm: Math.ceil(need * 2) / 2 } : c
  })
}

/** Resolves a cell to its display lines (max 2). */
const cellLines = (c: Cell): string[] =>
  typeof c === 'string' ? [c] : c.lines?.length ? c.lines.slice(0, 2) : [c.text]

/** Row height: base `rowH`, or `rowH + fontMm*1.25` if any cell wraps to 2 lines. */
export function rowHeight(row: Row, cols: Column[], style: TableStyle): number {
  const n = Math.max(1, ...cols.map((c) => cellLines(row[c.key] ?? '').length))
  return n === 1 ? style.rowH : style.rowH + style.fontMm * 1.25
}

/**
 * Splits `rows` into chunks that each fit header + rows within `availableH`.
 * Never returns an empty array — zero rows yields one empty chunk so a
 * header-only page still renders.
 */
export function paginateRows(rows: Row[], cols: Column[], style: TableStyle, availableH: number): Row[][] {
  const chunks: Row[][] = []
  let cur: Row[] = []
  let used = style.headerH
  for (const r of rows) {
    const h = rowHeight(r, cols, style)
    if (cur.length > 0 && used + h > availableH) {
      chunks.push(cur)
      cur = []
      used = style.headerH
    }
    cur.push(r)
    used += h
  }
  chunks.push(cur)
  return chunks
}

/** Renders a table (optional title banner + header row + body rows) as an SVG group. */
export function renderTable(
  x: number,
  y: number,
  cols: Column[],
  rows: Row[],
  style: TableStyle,
  opts: { title?: string } = {}
): { svg: string; h: number } {
  const parts: string[] = []
  const W = tableWidth(cols)
  let cy = y
  const baseline = (top: number, h: number): number => top + h / 2 + style.fontMm * 0.35

  if (opts.title) {
    parts.push(
      `<rect x="${fmt(x)}" y="${fmt(cy)}" width="${fmt(W)}" height="${fmt(style.headerH)}" fill="#e6e6e6" stroke="#444" stroke-width="0.25"/>`
    )
    parts.push(
      svgText(x + W / 2, baseline(cy, style.headerH), opts.title, {
        size: style.fontMm * 1.15,
        anchor: 'middle',
        weight: 'bold',
        fill: '#111'
      })
    )
    cy += style.headerH
  }

  // Header row.
  let cx = x
  for (const c of cols) {
    parts.push(
      `<rect x="${fmt(cx)}" y="${fmt(cy)}" width="${fmt(c.wMm)}" height="${fmt(style.headerH)}" fill="#e6e6e6" stroke="#444" stroke-width="0.25"/>`
    )
    parts.push(
      svgText(cx + style.pad, baseline(cy, style.headerH), fitText(c.title, style.fontMm, c.wMm - 2 * style.pad), {
        size: style.fontMm,
        fill: '#111'
      })
    )
    cx += c.wMm
  }
  cy += style.headerH

  // Body rows.
  for (const r of rows) {
    const h = rowHeight(r, cols, style)
    cx = x
    for (const c of cols) {
      const cell = r[c.key] ?? ''
      parts.push(
        `<rect x="${fmt(cx)}" y="${fmt(cy)}" width="${fmt(c.wMm)}" height="${fmt(h)}" fill="#fff" stroke="#444" stroke-width="0.25"/>`
      )
      let tx = cx + style.pad
      let avail = c.wMm - 2 * style.pad
      const swatch = typeof cell === 'object' ? cell.swatch : undefined
      if (swatch) {
        parts.push(
          `<rect x="${fmt(tx)}" y="${fmt(cy + h / 2 - 1.2)}" width="4" height="2.4" fill="${strokeForColor(swatch)}" stroke="#333" stroke-width="0.2"/>`
        )
        tx += 5
        avail -= 5
      }
      const lines = cellLines(cell)
      lines.forEach((ln, i) => {
        const ly = lines.length === 1 ? baseline(cy, h) : cy + style.pad + style.fontMm * (0.9 + i * 1.25)
        const anchorX = c.align === 'end' ? cx + c.wMm - style.pad : tx
        parts.push(
          svgText(anchorX, ly, fitText(ln, style.fontMm, avail), {
            size: style.fontMm,
            fill: '#111',
            anchor: c.align === 'end' ? 'end' : undefined
          })
        )
      })
      cx += c.wMm
    }
    cy += h
  }

  return { svg: `<g class="table">${parts.join('')}</g>`, h: cy - y }
}
