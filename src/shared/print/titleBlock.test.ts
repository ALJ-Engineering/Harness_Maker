import { describe, it, expect } from 'vitest'
import { renderTitleBlock, TITLE_BLOCK_W, TITLE_BLOCK_H } from './titleBlock'
import { DEFAULT_CONFIDENTIALITY } from '../model/schema'

describe('renderTitleBlock', () => {
  it('renders field values, ---- placeholders, and the default confidentiality text', () => {
    const svg = renderTitleBlock(0, 0, { title: 'BATTERY LOOM', partNumber: 'HX-100-A', revision: 'A', drawnBy: { name: 'J Smith', date: '2025-11-11' } }, {})
    expect(svg).toContain('BATTERY LOOM'); expect(svg).toContain('HX-100-A'); expect(svg).toContain('J Smith')
    expect((svg.match(/----/g) ?? []).length).toBe(6) // 3 approvals × (name,date)
    expect(svg).toContain('confidential')
  })
  it('uses the logo image when provided, else leaves the logo cell empty', () => {
    expect(renderTitleBlock(0, 0, undefined, { logoDataUri: 'data:image/png;base64,AAAA' })).toContain('<image')
    const bare = renderTitleBlock(0, 0, undefined, {})
    expect(bare).not.toContain('<image')
    // No text mark stands in for a missing logo: same text runs either way.
    const withLogo = renderTitleBlock(0, 0, undefined, { logoDataUri: 'data:image/png;base64,AAAA' })
    expect((bare.match(/<text/g) ?? []).length).toBe((withLogo.match(/<text/g) ?? []).length)
  })
  it('rejects a non-image data uri, leaving the logo cell empty', () => {
    expect(renderTitleBlock(0, 0, undefined, { logoDataUri: 'not-a-data-uri' })).not.toContain('<image')
  })
  it('the default confidentiality text names no company', () => {
    expect(DEFAULT_CONFIDENTIALITY).toBe(
      'This document contains confidential and proprietary information. It may not be reproduced or disclosed, in whole or in part, without written authorization.'
    )
  })
  it('outer box is exactly TITLE_BLOCK_W × TITLE_BLOCK_H at x,y', () => {
    const svg = renderTitleBlock(200, 250, {}, {})
    expect(svg).toContain(`<rect x="200" y="250" width="${TITLE_BLOCK_W}" height="${TITLE_BLOCK_H}"`)
  })
  it('renders empty (not ----) for missing title/partNumber/description/revision', () => {
    const svg = renderTitleBlock(0, 0, {}, {})
    expect((svg.match(/----/g) ?? []).length).toBe(8) // 4 approvals × (name,date)
  })
  it('escapes user text', () => expect(renderTitleBlock(0, 0, { title: 'a<b' }, {})).toContain('a&lt;b'))
})

describe('the description cell', () => {
  // Bold runs in the bottom-left cell (x < 50, y > 15) are the description's lines.
  const descLines = (description: string): { text: string; y: number; size: number }[] =>
    [...renderTitleBlock(0, 0, { description }, {}).matchAll(/<text x="([\d.]+)" y="([\d.]+)" font-size="([\d.]+)" font-weight="bold">([^<]*)<\/text>/g)]
      .filter((m) => Number(m[1]) < 50 && Number(m[2]) > 15)
      .map((m) => ({ text: m[4], y: Number(m[2]), size: Number(m[3]) }))

  it('a short description is one line, where it always was', () => {
    expect(descLines('Battery loom')).toEqual([{ text: 'Battery loom', y: 28, size: 2.82 }])
  })

  it('a long description wraps onto more lines instead of being cut off', () => {
    const text = 'Main battery loom for the 12 V system, front left'
    const lines = descLines(text)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.map((l) => l.text).join(' ')).toBe(text)
    expect(lines.at(-1)!.y).toBe(28) // the last line sits where a single line would
    expect(lines.every((l) => l.y > 15 + 4)).toBe(true) // all below the label
  })

  it('keeps the line breaks typed into it', () => {
    expect(descLines('Front loom\nRev B wiring').map((l) => l.text)).toEqual(['Front loom', 'Rev B wiring'])
  })

  it('steps the size down to fit, and clips only what 5 pt cannot hold', () => {
    const medium = descLines('Main battery loom for the 12 V system, from the battery to the fuse box and the VCU')
    expect(medium[0].size).toBeLessThan(2.82)
    expect(medium.map((l) => l.text).join(' ')).not.toContain('…')
    const huge = descLines('word '.repeat(200).trim())
    expect(huge.at(-1)!.text.endsWith('…')).toBe(true)
    expect(huge[0].size).toBe(1.76)
  })
})
