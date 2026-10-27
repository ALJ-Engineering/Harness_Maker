import { describe, it, expect } from 'vitest'
import { sheetMm, frameRect } from './sheet'

describe('sheet', () => {
  it('A1 landscape = 841×594', () => {
    expect(sheetMm({ paper: 'A1', orientation: 'landscape' })).toEqual({ wMm: 841, hMm: 594 })
  })
  it('A0 is 841×1189 portrait, swapped for landscape', () => {
    expect(sheetMm({ paper: 'A0', orientation: 'portrait' })).toEqual({ wMm: 841, hMm: 1189 })
    expect(sheetMm({ paper: 'A0', orientation: 'landscape' })).toEqual({ wMm: 1189, hMm: 841 })
  })
  it('Plotter is a 914 mm roll of lengthMm (default 2000)', () => {
    expect(sheetMm({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 })).toEqual({ wMm: 2600, hMm: 914 })
    expect(sheetMm({ paper: 'Plotter', orientation: 'portrait', lengthMm: 2600 })).toEqual({ wMm: 914, hMm: 2600 })
    expect(sheetMm({ paper: 'Plotter', orientation: 'landscape' })).toEqual({ wMm: 2000, hMm: 914 })
  })
  it('frameRect insets by the margin', () => {
    expect(frameRect({ wMm: 297, hMm: 210 }, 10)).toEqual({ x: 10, y: 10, w: 277, h: 190 })
  })
})
