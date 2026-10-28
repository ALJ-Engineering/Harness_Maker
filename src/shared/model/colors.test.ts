import { describe, it, expect } from 'vitest'
import { strokeForColor, colorName, IEC_COLORS, isKnownColor, searchColors } from './colors'

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

describe('IEC_COLORS / isKnownColor', () => {
  it('lists every colour the canvas draws, each with a name and its own stroke', () => {
    expect(IEC_COLORS.map((c) => c.code)).toEqual([
      'BK', 'BN', 'RD', 'OG', 'YE', 'GN', 'BU', 'VT', 'GY', 'WH', 'PK', 'GNYE', 'TQ', 'SR', 'GD'
    ])
    for (const c of IEC_COLORS) {
      expect(c.name).not.toBe(c.code)
      expect(strokeForColor(c.code)).not.toBe('#555')
    }
  })

  it('knows IEC codes in any case and valid hex; not aliases, typos or bad hex', () => {
    expect(isKnownColor('RD')).toBe(true)
    expect(isKnownColor('gnye')).toBe(true)
    expect(isKnownColor('#a1b2c3')).toBe(true)
    expect(isKnownColor('BLK')).toBe(false)
    expect(isKnownColor('#12')).toBe(false)
    expect(isKnownColor('')).toBe(false)
  })
})

describe('searchColors', () => {
  const codes = (q: string): string[] => searchColors(q).map((c) => c.code)

  it('lists every colour for an empty query', () => {
    expect(codes('')).toEqual(IEC_COLORS.map((c) => c.code))
    expect(codes('  ')).toHaveLength(IEC_COLORS.length)
  })

  it('finds a colour by code, name or common non-IEC abbreviation', () => {
    expect(codes('RD')[0]).toBe('RD')
    expect(codes('red')[0]).toBe('RD')
    expect(codes('BLK')).toEqual(['BK'])
    expect(codes('wht')).toEqual(['WH'])
    expect(codes('purple')).toEqual([])
    expect(codes('violet')).toEqual(['VT'])
  })

  it('ranks an exact code before a prefix before a name match', () => {
    expect(codes('GN')).toEqual(['GN', 'GNYE'])
    expect(codes('yel')).toEqual(['YE', 'GNYE'])
    // Code prefix (list order), then a name merely containing G: OranGe.
    expect(codes('G')).toEqual(['GN', 'GY', 'GNYE', 'GD', 'OG'])
  })

  it('has no rows for a hex value (it is committed as typed)', () => {
    expect(codes('#ff0000')).toEqual([])
  })
})
