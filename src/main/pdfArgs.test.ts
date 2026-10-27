import { describe, it, expect } from 'vitest'
import { validateExportPdfArgs, htmlFileNameFor } from './pdfArgs'
import { PLOTTER_MAX_LENGTH_MM, PLOTTER_ROLL_WIDTH_MM } from '../shared/model/schema'

const part = { html: '<html></html>', widthMm: 297, heightMm: 210 }
const good = { parts: [part] }

describe('validateExportPdfArgs', () => {
  it('returns a well-formed payload unchanged', () => {
    expect(validateExportPdfArgs(good)).toBe(good)
  })

  it('accepts the optional fields', () => {
    const withOpts = { ...good, defaultPath: '/tmp/x.pdf', title: 'Export' }
    expect(validateExportPdfArgs(withOpts)).toBe(withOpts)
  })

  it('accepts 1–4 parts', () => {
    // One part per paper size: the drawing set is two, and the bound leaves
    // room for a couple more before it starts looking like a runaway payload.
    expect(() => validateExportPdfArgs({ parts: [part] })).not.toThrow()
    expect(() => validateExportPdfArgs({ parts: [part, part] })).not.toThrow()
    expect(() => validateExportPdfArgs({ parts: [part, part, part, part] })).not.toThrow()
  })

  it('rejects zero, five, or a bad part', () => {
    expect(() => validateExportPdfArgs({ parts: [] })).toThrow()
    expect(() => validateExportPdfArgs({ parts: Array(5).fill(part) })).toThrow()
    expect(() => validateExportPdfArgs({ parts: [{ ...part, widthMm: 0 }] })).toThrow()
    expect(() => validateExportPdfArgs({ parts: [{ ...part, heightMm: PLOTTER_MAX_LENGTH_MM + 1 }] })).toThrow()
    expect(() => validateExportPdfArgs({ parts: [{ ...part, html: 1 }] })).toThrow()
  })

  it('rejects a bad part in any position, not just the first', () => {
    expect(() => validateExportPdfArgs({ parts: [part, { ...part, widthMm: -1 }] })).toThrow()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 7],
    ['missing parts', { defaultPath: '/tmp/x.pdf' }],
    ['parts not an array', { parts: part }],
    ['a null part', { parts: [null] }],
    ['a string part', { parts: ['<html/>'] }],
    ['missing html', { parts: [{ widthMm: 297, heightMm: 210 }] }],
    ['non-string html', { parts: [{ ...part, html: 42 }] }],
    ['missing widthMm', { parts: [{ html: '', heightMm: 210 }] }],
    ['zero widthMm', { parts: [{ ...part, widthMm: 0 }] }],
    ['negative heightMm', { parts: [{ ...part, heightMm: -1 }] }],
    ['NaN widthMm', { parts: [{ ...part, widthMm: Number.NaN }] }],
    ['Infinite heightMm', { parts: [{ ...part, heightMm: Number.POSITIVE_INFINITY }] }],
    ['string widthMm', { parts: [{ ...part, widthMm: '297' }] }],
    ['widthMm past the sheet bound', { parts: [{ ...part, widthMm: PLOTTER_MAX_LENGTH_MM + 0.1 }] }],
    ['heightMm past the sheet bound', { parts: [{ ...part, heightMm: 20000 }] }],
    ['non-string defaultPath', { ...good, defaultPath: 7 }],
    ['null defaultPath', { ...good, defaultPath: null }],
    ['non-string title', { ...good, title: { text: 'x' } }],
    ['null title', { ...good, title: null }]
  ])('rejects %s', (_label, bad) => {
    expect(() => validateExportPdfArgs(bad)).toThrow('exportPdf: invalid arguments')
  })

  it('accepts an empty html string (an empty page set is still a valid render)', () => {
    expect(() => validateExportPdfArgs({ parts: [{ ...part, html: '' }] })).not.toThrow()
  })

  it('accepts the largest sheet we support and rejects one past it', () => {
    // The longest page is a plotter roll at PLOTTER_MAX_LENGTH_MM, both ways
    // round; A0 landscape (1189 × 841) is well inside it.
    expect(() =>
      validateExportPdfArgs({ parts: [{ ...part, widthMm: 1189, heightMm: 841 }] })
    ).not.toThrow()
    expect(() =>
      validateExportPdfArgs({
        parts: [{ ...part, widthMm: PLOTTER_MAX_LENGTH_MM, heightMm: PLOTTER_ROLL_WIDTH_MM }]
      })
    ).not.toThrow()
    expect(() =>
      validateExportPdfArgs({
        parts: [{ ...part, widthMm: PLOTTER_ROLL_WIDTH_MM, heightMm: PLOTTER_MAX_LENGTH_MM }]
      })
    ).not.toThrow()
    expect(() => validateExportPdfArgs({ parts: [{ ...part, widthMm: PLOTTER_MAX_LENGTH_MM + 1 }] })).toThrow()
  })
})

describe('htmlFileNameFor', () => {
  it('derives the stem from the pdf path, dropping directory and extension', () => {
    expect(htmlFileNameFor('/tmp/looms/loom-a-drawing-set.pdf')).toBe('loom-a-drawing-set.html')
  })

  it('handles windows separators', () => {
    expect(htmlFileNameFor('C:\\looms\\loom-a.pdf')).toBe('loom-a.html')
  })

  it('falls back to "harness" with no path', () => {
    expect(htmlFileNameFor(undefined)).toBe('harness.html')
  })

  it('falls back to "harness" when the stem is empty', () => {
    expect(htmlFileNameFor('/tmp/.pdf')).toBe('harness.html')
    expect(htmlFileNameFor('')).toBe('harness.html')
  })

  it('collapses a run of unsafe characters to a single underscore', () => {
    expect(htmlFileNameFor('/tmp/€€€.pdf')).toBe('_.html')
  })

  it('replaces characters that are not safe in a file name', () => {
    expect(htmlFileNameFor('/tmp/a:b*c?.pdf')).toBe('a_b_c_.html')
  })

  it('caps the result at 80 characters', () => {
    const long = `/tmp/${'x'.repeat(500)}.pdf`
    const name = htmlFileNameFor(long)
    expect(name.length).toBe(80)
    expect(name.endsWith('.html')).toBe(true)
  })
})
