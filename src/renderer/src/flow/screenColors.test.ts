import { describe, it, expect } from 'vitest'
import { strokeForColor } from '@shared/model/colors'
import { screenStroke, relativeLuminance, NEAR_BLACK_LUMINANCE, DARK_WIRE_BLACK } from './screenColors'

const IEC = ['BK','BN','RD','OG','YE','GN','BU','VT','GY','WH','PK','GNYE','TQ','SR','GD']

describe('screenStroke', () => {
  it('lifts black to the light wire colour on a dark canvas', () => {
    expect(screenStroke('BK', 'dark')).toBe(DARK_WIRE_BLACK)
    expect(screenStroke('bk', 'dark')).toBe(DARK_WIRE_BLACK)
  })

  it('leaves black alone in the light theme', () => {
    expect(screenStroke('BK', 'light')).toBe(strokeForColor('BK'))
  })

  it('leaves every other IEC colour untouched in both themes', () => {
    for (const base of IEC.filter((b) => b !== 'BK')) {
      expect(screenStroke(base, 'dark')).toBe(strokeForColor(base))
      expect(screenStroke(base, 'light')).toBe(strokeForColor(base))
    }
  })

  it('substitutes a near-black hex but not a mid-tone one', () => {
    expect(screenStroke('#1a1b1e', 'dark')).toBe(DARK_WIRE_BLACK)
    expect(screenStroke('#6d4c41', 'dark')).toBe('#6d4c41')
    expect(screenStroke('#1a1b1e', 'light')).toBe('#1a1b1e')
  })

  it('keeps the invalid-hex fallback', () => {
    expect(screenStroke('#zzz', 'dark')).toBe('#555')
    expect(screenStroke('nonsense', 'dark')).toBe('#555')
  })

  it('puts the threshold below every IEC colour except black', () => {
    for (const base of IEC.filter((b) => b !== 'BK')) {
      expect(relativeLuminance(strokeForColor(base))).toBeGreaterThan(NEAR_BLACK_LUMINANCE)
    }
    expect(relativeLuminance(strokeForColor('BK'))).toBeLessThan(NEAR_BLACK_LUMINANCE)
  })
})
