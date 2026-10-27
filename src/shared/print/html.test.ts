import { describe, it, expect } from 'vitest'
import { pageSetToHtml } from './html'

describe('pageSetToHtml', () => {
  const set = {
    sheet: { wMm: 297, hMm: 210 },
    pages: [
      { id: 'p1', section: 'A', svg: '<svg>1</svg>' },
      { id: 'p2', section: 'B', svg: '<svg>2</svg>' }
    ]
  }

  it('sets @page size, one .page div per page in order, no external references', () => {
    const html = pageSetToHtml(set, 'X1 rev A')
    expect(html).toContain('@page { size: 297mm 210mm; margin: 0 }')
    expect((html.match(/class="page"/g) ?? []).length).toBe(2)
    expect(html.indexOf('<svg>1</svg>')).toBeLessThan(html.indexOf('<svg>2</svg>'))
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('names the document so the PDF gets a /Title', () => {
    expect(pageSetToHtml(set, 'X1 rev A')).toContain('<title>X1 rev A</title>')
  })

  it('escapes the title', () => {
    expect(pageSetToHtml(set, 'A & <B>')).toContain('<title>A &amp; &lt;B&gt;</title>')
  })
})
