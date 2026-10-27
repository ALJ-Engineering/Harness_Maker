import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { mergePdfs } from './pdfMerge'

const PT_PER_MM = 72 / 25.4

async function pdfWithPages(sizesMm: [number, number][], title?: string): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  if (title) d.setTitle(title)
  for (const [w, h] of sizesMm) d.addPage([w * PT_PER_MM, h * PT_PER_MM])
  return d.save()
}

describe('mergePdfs', () => {
  it('keeps page order and every page box exactly, across parts of different sizes', async () => {
    const a = await pdfWithPages([[420, 297], [420, 297]])
    const b = await pdfWithPages([[297, 210]])
    const merged = await PDFDocument.load(await mergePdfs([a, b]))
    const sizes = merged.getPages().map((p) => [p.getWidth() / PT_PER_MM, p.getHeight() / PT_PER_MM])
    expect(sizes.length).toBe(3)
    expect(sizes[0][0]).toBeCloseTo(420, 6); expect(sizes[0][1]).toBeCloseTo(297, 6)
    expect(sizes[2][0]).toBeCloseTo(297, 6); expect(sizes[2][1]).toBeCloseTo(210, 6)
  })
  it('a single part round-trips unchanged in page count', async () => {
    const a = await pdfWithPages([[210, 297]])
    const merged = await PDFDocument.load(await mergePdfs([a]))
    expect(merged.getPageCount()).toBe(1)
  })
  it("carries the first part's title onto the merged document", async () => {
    // `copyPages` copies page dictionaries only, never the Info dictionary — so
    // without an explicit hand-over the merged file has no /Title and the whole
    // `pdfTitle` → <title> → Chromium chain is dead for every real export,
    // which always takes the multi-part path.
    const a = await pdfWithPages([[420, 297]], 'X1 rev A')
    const b = await pdfWithPages([[297, 210]], 'ignored second title')
    const merged = await PDFDocument.load(await mergePdfs([a, b]))
    expect(merged.getTitle()).toBe('X1 rev A')
  })
  it('is fine with parts that carry no title', async () => {
    const merged = await PDFDocument.load(await mergePdfs([await pdfWithPages([[210, 297]])]))
    expect(merged.getTitle()).toBeUndefined()
  })
  it('rejects zero parts', async () => {
    await expect(mergePdfs([])).rejects.toThrow(/at least one/)
  })
})
