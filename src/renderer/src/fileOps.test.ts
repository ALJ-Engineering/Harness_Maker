import { describe, it, expect } from 'vitest'
import { loadFromText, withDataUris, skippedPictureLine } from './fileOps'
import { serializeDocument } from '@shared/model/serialize'
import { demoDocument } from '@shared/model/document'
import { DocumentParseError } from '@shared/model/serialize'

/** A pre-session-11 save: the label still points at a segment that was GC'd. */
function oldFileText(): string {
  const d = demoDocument()
  d.labels = [
    { id: 'l1', target: { type: 'branch', segmentId: 'seg-deleted' }, kind: 'flag', text: 'X', pos: { x: 0, y: 0 } }
  ]
  return serializeDocument(d)
}

describe('loadFromText — the open() pipeline', () => {
  it('a clean file loads with no repairs and no on-disk baseline', () => {
    const text = serializeDocument(demoDocument())
    const { doc, load } = loadFromText(text)
    expect(load.repairs).toEqual([])
    expect(load.onDiskDoc).toBeUndefined() // nothing to be dirty against
    expect(serializeDocument(doc)).toBe(text)
  })

  it('an old file is repaired, and the UNREPAIRED document is kept as the baseline', () => {
    const text = oldFileText()
    const { doc, load } = loadFromText(text)
    expect(load.repairs.map((r) => r.kind)).toEqual(['dangling-label-target'])
    expect(doc.labels).toEqual([])
    expect(load.onDiskDoc).toBeDefined()
    expect(serializeDocument(load.onDiskDoc!)).toBe(text) // exactly what is on disk
  })

  it('propagates a parse error', () => {
    expect(() => loadFromText('not json')).toThrow(DocumentParseError)
  })
})

describe('withDataUris — the print-window image swap', () => {
  it('swaps hrefs for data URLs and drops images that have none', () => {
    const images = {
      A: { href: 'parts-image://img/A', pxW: 1, pxH: 2 },
      B: { href: 'parts-image://img/B', pxW: 3, pxH: 4 }
    }
    expect(withDataUris(images, { A: 'data:image/png;base64,xx', B: null })).toEqual({
      A: { href: 'data:image/png;base64,xx', pxW: 1, pxH: 2 }
    })
  })
})

describe('skippedPictureLine — the >5 MB export warning (I3)', () => {
  it('says nothing when every picture made it into the PDF', () => {
    expect(skippedPictureLine([])).toBeUndefined()
  })

  it('names the parts whose picture was dropped, with a count', () => {
    expect(skippedPictureLine(['39-01-3045'])).toBe(
      '⚠ 1 picture(s) skipped (over 5 MB or unreadable): 39-01-3045'
    )
    expect(skippedPictureLine(['A', 'B'])).toBe(
      '⚠ 2 picture(s) skipped (over 5 MB or unreadable): A, B'
    )
  })

  it('composes onto the export alert as a trailing line', () => {
    const alert = ['Exported:', '/tmp/x.pdf', skippedPictureLine(['A'])].filter(Boolean).join('\n')
    expect(alert).toBe('Exported:\n/tmp/x.pdf\n⚠ 1 picture(s) skipped (over 5 MB or unreadable): A')
    // …and adds no blank line when nothing was skipped.
    expect(['Exported:', '/tmp/x.pdf', skippedPictureLine([])].filter(Boolean).join('\n')).toBe(
      'Exported:\n/tmp/x.pdf'
    )
  })
})
