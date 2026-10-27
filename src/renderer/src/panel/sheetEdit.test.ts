import { describe, it, expect } from 'vitest'
import { PLOTTER_DEFAULT_LENGTH_MM } from '@shared/model/schema'
import { plotterLengthMm, sheetDescription, withPaper } from './sheetEdit'

describe('withPaper', () => {
  it('switching to Plotter adds the default length when there is none', () => {
    expect(withPaper({ paper: 'A3', orientation: 'landscape' }, 'Plotter')).toEqual({
      paper: 'Plotter',
      orientation: 'landscape',
      lengthMm: PLOTTER_DEFAULT_LENGTH_MM
    })
  })

  it('keeps an existing plotter length', () => {
    expect(withPaper({ paper: 'Plotter', orientation: 'portrait', lengthMm: 2600 }, 'Plotter')).toEqual({
      paper: 'Plotter',
      orientation: 'portrait',
      lengthMm: 2600
    })
  })

  it('switching away from Plotter drops lengthMm entirely (no key left behind)', () => {
    const out = withPaper({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 }, 'A0')
    expect(out).toEqual({ paper: 'A0', orientation: 'landscape' })
    expect('lengthMm' in out).toBe(false)
  })
})

describe('plotterLengthMm', () => {
  it('rounds to whole mm and clamps to 914–5000', () => {
    expect(plotterLengthMm(2600)).toBe(2600)
    expect(plotterLengthMm(2600.4)).toBe(2600)
    expect(plotterLengthMm(914)).toBe(914)
    expect(plotterLengthMm(26)).toBe(914)
    expect(plotterLengthMm(0.2)).toBe(914)
    expect(plotterLengthMm(-50)).toBe(914)
    expect(plotterLengthMm(9000)).toBe(5000)
  })

  it('rejects a non-number', () => {
    expect(plotterLengthMm(undefined)).toBeUndefined()
    expect(plotterLengthMm(Number.NaN)).toBeUndefined()
  })
})

describe('sheetDescription', () => {
  it('names the paper, its size in mm and the orientation', () => {
    expect(sheetDescription({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 })).toBe(
      'Plotter 914 × 2600 mm, landscape'
    )
    expect(sheetDescription({ paper: 'Plotter', orientation: 'portrait', lengthMm: 914 })).toBe(
      'Plotter 914 × 914 mm, portrait'
    )
    expect(sheetDescription({ paper: 'A3', orientation: 'landscape' })).toBe('A3 297 × 420 mm, landscape')
    expect(sheetDescription({ paper: 'A0', orientation: 'portrait' })).toBe('A0 841 × 1189 mm, portrait')
  })
})
