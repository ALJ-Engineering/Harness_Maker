import { describe, it, expect } from 'vitest'
import { strokeForColor, colorName } from './colors'

describe('strokeForColor', () => {
  it('maps a known IEC abbreviation to its hex (case-insensitive)', () => {
    expect(strokeForColor('RD')).toBe('#c62828')
    expect(strokeForColor('rd')).toBe('#c62828')
  })

  it('passes a hex colour through unchanged', () => {
    expect(strokeForColor('#123abc')).toBe('#123abc')
  })

  it('falls back to a neutral grey for an unknown abbreviation', () => {
    expect(strokeForColor('ZZ')).toBe('#555')
  })

  it('maps the IEC green/yellow protective-earth code (GNYE)', () => {
    expect(strokeForColor('GNYE')).toBe('#4caf50')
    expect(strokeForColor('gnye')).toBe('#4caf50')
  })

  it('falls back to grey for a malformed hex (cannot break out of the SVG stroke attr)', () => {
    expect(strokeForColor('#000" onload="x')).toBe('#555')
    expect(strokeForColor('#12')).toBe('#555')
    expect(strokeForColor('#abcd')).toBe('#555')
  })

  it('still passes a valid 3- and 6-digit hex through unchanged', () => {
    expect(strokeForColor('#abc')).toBe('#abc')
    expect(strokeForColor('#A1B2C3')).toBe('#A1B2C3')
  })
})

describe('colorName', () => {
  it('maps IEC abbreviations and passes hex/unknown through', () => {
    expect(colorName('RD')).toBe('Red')
    expect(colorName('GNYE')).toBe('Green/Yellow')
    expect(colorName('#abc')).toBe('#abc')
    expect(colorName('ZZ')).toBe('ZZ')
  })
})
