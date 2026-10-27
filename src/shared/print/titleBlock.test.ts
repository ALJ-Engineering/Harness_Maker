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
