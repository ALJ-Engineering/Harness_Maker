import { describe, it, expect } from 'vitest'
import { paginateRows, renderTable, tableWidth, rowHeight, TABLE_STYLE_PAGE, type Column, type Row } from './tables'

const cols: Column[] = [
  { key: 'a', title: 'A', wMm: 20 },
  { key: 'b', title: 'B', wMm: 40 }
]
const row = (i: number): Row => ({ a: String(i), b: `row ${i}` })

describe('paginateRows', () => {
  it('fits as many rows as the available height allows, header included, and never drops rows', () => {
    const rows = Array.from({ length: 23 }, (_, i) => row(i))
    const perPage = Math.floor((100 - TABLE_STYLE_PAGE.headerH) / TABLE_STYLE_PAGE.rowH) // 17
    const chunks = paginateRows(rows, cols, TABLE_STYLE_PAGE, 100)
    expect(chunks.map((c) => c.length)).toEqual([perPage, 23 - perPage])
    expect(chunks.flat()).toEqual(rows)
  })
  it('an empty table yields one empty chunk (so a page with just the header renders)', () => {
    expect(paginateRows([], cols, TABLE_STYLE_PAGE, 100)).toEqual([[]])
  })
  it('a two-line cell consumes a taller row', () => {
    const tall: Row = { a: '1', b: { text: '', lines: ['x', 'y'] } }
    expect(rowHeight(tall, cols, TABLE_STYLE_PAGE)).toBeGreaterThan(rowHeight(row(1), cols, TABLE_STYLE_PAGE))
  })
})

describe('renderTable', () => {
  it('emits one header cell per column, one text per cell, and reports its height', () => {
    const { svg, h } = renderTable(0, 0, cols, [row(1), row(2)], TABLE_STYLE_PAGE)
    expect((svg.match(/<text/g) ?? []).length).toBe(2 + 4)
    expect(h).toBeCloseTo(TABLE_STYLE_PAGE.headerH + 2 * TABLE_STYLE_PAGE.rowH, 5)
    expect(svg).toContain('fill="#e6e6e6"')
    expect(tableWidth(cols)).toBe(60)
  })
  it('renders a swatch rect with the IEC colour and escapes text', () => {
    const { svg } = renderTable(0, 0, cols, [{ a: { text: 'W1 <Red>', swatch: 'RD' }, b: '' }], TABLE_STYLE_PAGE)
    expect(svg).toContain('fill="#c62828"')
    expect(svg).toContain('W1 &lt;Red&gt;')
  })
  it('a title banner adds one headerH and a bold centred text', () => {
    const plain = renderTable(0, 0, cols, [], TABLE_STYLE_PAGE)
    const titled = renderTable(0, 0, cols, [], TABLE_STYLE_PAGE, { title: 'Bill of Materials' })
    expect(titled.h - plain.h).toBeCloseTo(TABLE_STYLE_PAGE.headerH, 5)
    expect(titled.svg).toContain('font-weight="bold"')
    expect(titled.svg).toContain('Bill of Materials')
  })
})
