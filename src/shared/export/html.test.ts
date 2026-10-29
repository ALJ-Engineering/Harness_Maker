import { describe, it, expect } from 'vitest'
import { reportToHtml } from './html'
import { demoDocument, emptyDocument } from '../model/document'
import type { HarnessDocument } from '../model/schema'

describe('reportToHtml', () => {
  it('is a self-contained HTML document', () => {
    const html = reportToHtml(demoDocument())
    expect(html.toLowerCase()).toContain('<!doctype html>')
    expect(html).toContain('</html>')
  })

  it('includes both a BOM and a cut-list section', () => {
    const html = reportToHtml(demoDocument())
    expect(html).toMatch(/Bill of Materials/i)
    expect(html).toMatch(/Cut list/i)
  })

  it('renders a cut-list row for each wire with its endpoints', () => {
    const html = reportToHtml(demoDocument())
    expect(html).toContain('X1.1')
    expect(html).toContain('X2.A')
    expect(html).toContain('W1')
  })

  it('escapes HTML-special characters in content', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'c1', designator: 'X<1>', housing: { partNumber: 'A&B' }, cavities: [] }
    ]
    const html = reportToHtml(d)
    expect(html).toContain('A&amp;B')
    expect(html).not.toContain('X<1>')
  })

  it('shows a length-source column and an unknown marker', () => {
    const d = emptyDocument()
    d.wires = [
      { id: 'w1', ends: [{ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'y' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } }
    ]
    const html = reportToHtml(d)
    expect(html).toMatch(/unknown/i)
  })
})

// ─── Helper: doc with a placed 50mm segment for treatment tests ───

function docWithPlacedSegment(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    { id: 'c1', designator: 'X1', cavities: [{ id: 'cav1', position: '1', status: 'populated' }] },
    { id: 'c2', designator: 'X2', cavities: [{ id: 'cav2', position: 'A', status: 'populated' }] }
  ]
  d.placements = [
    { refId: 'c1', pos: { x: 0, y: 0 } },
    { refId: 'c2', pos: { x: 30, y: 40 } } // 50mm
  ]
  d.wires = [
    {
      id: 'w1',
      ends: [{ type: 'cavity', cavityId: 'cav1' }, { type: 'cavity', cavityId: 'cav2' }],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' }
    }
  ]
  d.segments = [
    {
      id: 'seg1',
      from: { type: 'body', refId: 'c1' },
      to: { type: 'body', refId: 'c2' }
    }
  ]
  d.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
  return d
}

describe('reportToHtml — Treatments table', () => {
  it('does NOT show a Treatments section when there are none', () => {
    const html = reportToHtml(demoDocument())
    expect(html).not.toMatch(/Treatments/i)
  })

  it('shows a Treatments section when sleeving is present', () => {
    const d = docWithPlacedSegment()
    d.sleeving = [
      {
        id: 'sl1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['seg1'] },
        sleevingType: 'heatshrink'
      }
    ]
    const html = reportToHtml(d)
    expect(html).toMatch(/Treatments/i)
    expect(html).toContain('Heat shrink')
    expect(html).toContain('50')
  })

  it('shows a Treatments section when twists are present', () => {
    const d = docWithPlacedSegment()
    d.twists = [{ id: 'tw1', wireIds: ['w1'], span: { segmentIds: ['seg1'] } }]
    const html = reportToHtml(d)
    expect(html).toMatch(/Treatments/i)
    expect(html).toContain('twist')
  })
})

describe('reportToHtml — Wire markers table', () => {
  it('does NOT show a Wire markers section when there are none', () => {
    const html = reportToHtml(demoDocument())
    expect(html).not.toMatch(/Wire markers/i)
  })

  it('shows Wire markers section for wireMarker labels', () => {
    const d = docWithPlacedSegment()
    d.labels = [
      {
        id: 'lbl1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'wireMarker',
        text: 'CAN-HI',
        pos: { x: 0, y: 0 }
      }
    ]
    const html = reportToHtml(d)
    expect(html).toMatch(/Wire markers/i)
    expect(html).toContain('CAN-HI')
    expect(html).toContain('W1')
  })

  it('shows Wire markers section for heatshrinkPrint labels', () => {
    const d = docWithPlacedSegment()
    d.labels = [
      {
        id: 'lbl2',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'heatshrinkPrint',
        text: 'GND',
        pos: { x: 0, y: 0 }
      }
    ]
    const html = reportToHtml(d)
    expect(html).toMatch(/Wire markers/i)
    expect(html).toContain('GND')
  })

  it('does NOT show Wire markers section for callout-only labels', () => {
    const d = docWithPlacedSegment()
    d.labels = [
      {
        id: 'lbl3',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'callout',
        text: 'just a note',
        pos: { x: 0, y: 0 }
      }
    ]
    const html = reportToHtml(d)
    expect(html).not.toMatch(/Wire markers/i)
  })
})

describe('bundle loom tape in the HTML report', () => {
  it('renders the loom-tape BOM row with its part number and metre length', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'c1', designator: 'X1', cavities: [{ id: 'cav1', position: '1', status: 'populated' }] },
      { id: 'c2', designator: 'X2', cavities: [{ id: 'cav2', position: 'A', status: 'populated' }] }
    ]
    d.placements = [
      { refId: 'c1', pos: { x: 0, y: 0 } },
      { refId: 'c2', pos: { x: 600, y: 800 } } // 1000 mm
    ]
    d.segments = [
      {
        id: 'seg1',
        from: { type: 'body', refId: 'c1' },
        to: { type: 'body', refId: 'c2' }
      }
    ]
    d.bundles = [
      { id: 'bn1', segmentIds: ['seg1'], memberWireIds: [], part: { partNumber: 'TAPE-19' } }
    ]
    const html = reportToHtml(d)
    expect(html).toContain('loom tape')
    expect(html).toContain('TAPE-19')
    expect(html).toContain('1.00 m')
  })
})
