import { describe, it, expect } from 'vitest'
import { renderPageFrame, renderFooter, wrapPage, HEADER_H, FOOTER_H } from './frame'
import { PAGE_MARGIN, sheetMm } from './sheet'
import type { PaperSize } from '@shared/model/schema'

const sheet = { wMm: 420, hMm: 297 }
describe('renderPageFrame', () => {
  it('emits header rows, section + page footers, and the free content rect', () => {
    const { svg, content } = renderPageFrame({ sheet, tb: { title: 'T', partNumber: 'PN', description: 'D' }, branding: {}, section: 'Bill of Materials', sectionIndex: 1, sectionCount: 2, pageNo: 4, pageCount: 7 })
    expect(svg).toContain('Bill of Materials 1 of 2'); expect(svg).toContain('Page 4 of 7')
    expect(svg).toContain('PN')
    expect(content).toEqual({ x: PAGE_MARGIN, y: PAGE_MARGIN + HEADER_H + 5, w: 420 - 2 * PAGE_MARGIN, h: 297 - 2 * PAGE_MARGIN - HEADER_H - 5 - FOOTER_H })
  })
  it('shows ---- for a missing title', () => {
    expect(renderPageFrame({ sheet, tb: undefined, branding: {}, section: 'S', sectionIndex: 1, sectionCount: 1, pageNo: 1, pageCount: 1 }).svg).toContain('----')
  })
  it('draws no logo and no fallback text when no branding logo is supplied', () => {
    const o = { sheet, tb: undefined, section: 'S', sectionIndex: 1, sectionCount: 1, pageNo: 1, pageCount: 1 }
    const bare = renderPageFrame({ ...o, branding: {} }).svg
    const withLogo = renderPageFrame({ ...o, branding: { logoDataUri: 'data:image/png;base64,AAAA' } }).svg
    expect(bare).not.toContain('<image')
    expect((bare.match(/<text/g) ?? []).length).toBe((withLogo.match(/<text/g) ?? []).length)
  })
})
describe('renderFooter', () => {
  it('is usable standalone, independent of the header', () => {
    const svg = renderFooter({ sheet, tb: undefined, branding: {}, section: 'Cut List', sectionIndex: 2, sectionCount: 3, pageNo: 5, pageCount: 9 })
    expect(svg).toContain('Cut List 2 of 3')
    expect(svg).toContain('Page 5 of 9')
  })
})
describe('wrapPage', () => {
  it('produces an exactly sheet-sized svg with a 1:1 viewBox and white background', () => {
    const svg = wrapPage(sheet, '<g/>')
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 420 297"')).toBe(true)
    expect(svg).toContain('<rect x="0" y="0" width="420" height="297" fill="#fff"/>')
    expect(svg).toContain('<g/>')
    expect(svg.trim().endsWith('</svg>')).toBe(true)
  })
})

describe('header vs logo', () => {
  // On A4 portrait the fixed 30 + 150 mm header ran to x = 190 while the logo
  // started at x = 164 — the Title/Part Number/Description box printed straight
  // through the logo. The value column is now derived from the sheet.
  const papers: PaperSize[] = ['A4', 'A3', 'A2', 'A1']
  const orientations = ['portrait', 'landscape'] as const
  for (const paper of papers) {
    for (const orientation of orientations) {
      it(`${paper} ${orientation}: the header box stops before the logo`, () => {
        const sheet = sheetMm({ paper, orientation })
        const { svg } = renderPageFrame({
          sheet,
          tb: { title: 'A very long harness title that would happily overflow', partNumber: 'PN-0000-0000-0000', description: 'A description long enough to need clipping on any sheet at all' },
          branding: { logoDataUri: 'data:image/png;base64,AAAA' },
          section: 'S',
          sectionIndex: 1,
          sectionCount: 1,
          pageNo: 1,
          pageCount: 1
        })
        const header = svg.match(/<g class="page-header">([\s\S]*?)<\/g>/)![1]
        const box = header.match(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/)!
        const right = Number(box[1]) + Number(box[2])
        const logoX = Number(header.match(/<image x="([\d.]+)"/)![1])
        expect({ paper, orientation, fits: right <= logoX + 1e-9 }).toEqual({ paper, orientation, fits: true })
      })
    }
  }
})
