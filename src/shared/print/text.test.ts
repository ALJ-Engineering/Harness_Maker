import { describe, it, expect } from 'vitest'
import { estimateTextWidthMm, fitText, escapeXml, svgText, wrapText } from './text'

describe('estimateTextWidthMm', () => {
  it('scales linearly with font size and is ~0.55 em per average char', () => {
    // uppercase ~0.6 em * 10 chars * 10mm; loose precision because the glyph
    // table narrows capital 'I', so this string isn't purely 0.6-em chars
    expect(estimateTextWidthMm('ABCDEFGHIJ', 10)).toBeCloseTo(60, -1)
    expect(estimateTextWidthMm('abcdefghij', 5)).toBeLessThan(estimateTextWidthMm('abcdefghij', 10))
  })
  it('narrow glyphs (i l . ,) are narrower than wide ones (M W)', () => {
    expect(estimateTextWidthMm('iiii', 4)).toBeLessThan(estimateTextWidthMm('MMMM', 4))
  })
})
describe('fitText', () => {
  it('returns text unchanged when it fits', () => expect(fitText('C1.1', 3.5, 20)).toBe('C1.1'))
  it('clips with an ellipsis so the result fits', () => {
    const out = fitText('Molex 39-01-3045 Mini-Fit Jr. Receptacle Housing', 3.5, 30)
    expect(out.endsWith('…')).toBe(true)
    expect(estimateTextWidthMm(out, 3.5)).toBeLessThanOrEqual(30)
  })
  it('returns "…" alone if nothing fits', () => expect(fitText('abc', 3.5, 1)).toBe('…'))
})
describe('wrapText', () => {
  it('splits on word boundaries, never mid-word, until it fits', () => {
    const lines = wrapText('one two three four five six seven eight', 3.5, 15, 4)
    expect(lines.length).toBeLessThanOrEqual(4)
    for (const ln of lines) expect(estimateTextWidthMm(ln, 3.5)).toBeLessThanOrEqual(15)
    expect(lines.join(' ').replace(/…$/, '').trim()).not.toMatch(/[a-z]-$/)
  })
  it('short text fits on one line without padding to maxLines', () => {
    expect(wrapText('hi there', 3.5, 50, 3)).toEqual(['hi there'])
  })
  it('ellipsis-clips the final line when text overflows maxLines', () => {
    const lines = wrapText('a very long confidential notice that will not fit in three short lines at all no matter what', 3.5, 20, 2)
    expect(lines.length).toBe(2)
    expect(lines[1].endsWith('…')).toBe(true)
  })
  it('empty text yields no lines', () => expect(wrapText('', 3.5, 20, 3)).toEqual([]))
  it('clips an oversized single word on a non-final line so no line ever exceeds maxWMm', () => {
    const lines = wrapText('hi Supercalifragilisticexpialidocious there', 3.5, 20, 3)
    expect(lines.length).toBeGreaterThan(1)
    for (const ln of lines) expect(estimateTextWidthMm(ln, 3.5)).toBeLessThanOrEqual(20)
  })
})
describe('svgText', () => {
  it('escapes and emits attributes', () => {
    expect(svgText(1, 2, 'a<b', { size: 3.5, anchor: 'end', weight: 'bold' })).toBe(
      '<text x="1" y="2" font-size="3.5" text-anchor="end" font-weight="bold">a&lt;b</text>'
    )
  })
  it('escapeXml handles & < > "', () => expect(escapeXml('&<>"')).toBe('&amp;&lt;&gt;&quot;'))
})
