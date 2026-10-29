import { describe, it, expect } from 'vitest'
import { documentToSvg, renderDrawingGroup } from './svg'
import { demoDocument, emptyDocument } from '../model/document'
import { computeFormboard, BODY_DOT_R, LABEL_FONT, SLEEVE_CALLOUT_GAP } from '../model/formboard'
import { fmt, escapeXml } from '../print/text'
import { strokeForColor } from '../model/colors'
import type { HarnessDocument } from '../model/schema'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal two-connector doc with one routed wire (RD, 0.5 mm2). */
function routedWireDoc(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    {
      id: 'c1',
      designator: 'X1',
      cavities: [{ id: 'a', position: '1', status: 'populated' }]
    },
    {
      id: 'c2',
      designator: 'X2',
      cavities: [{ id: 'z', position: 'A', status: 'populated' }]
    }
  ]
  d.placements = [
    { refId: 'c1', pos: { x: 0, y: 0 } },
    { refId: 'c2', pos: { x: 200, y: 0 } }
  ]
  d.wires = [
    {
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'a' },
        { type: 'cavity', cavityId: 'z' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' }
    }
  ]
  d.segments = [
    {
      id: 's1',
      from: { type: 'body', refId: 'c1' },
      to: { type: 'body', refId: 'c2' }
    }
  ]
  d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }]
  return d
}

/** Same topology but a second wire also routes through s1 → bundle. */
function bundleWireDoc(): HarnessDocument {
  const d = routedWireDoc()
  d.connectors[0].cavities.push({ id: 'b', position: '2', status: 'populated' })
  d.wires.push({
    id: 'w2',
    ends: [
      { type: 'cavity', cavityId: 'b' },
      { type: 'cavity', cavityId: 'z' }
    ],
    gauge: { value: 1, unit: 'mm2' },
    color: { base: 'BK' }
  })
  d.wireRoutes.push({ wireId: 'w2', path: ['s1'] })
  return d
}

// ── Core SVG structure ────────────────────────────────────────────────────────

describe('documentToSvg', () => {
  it('emits an <svg> with millimetre dimensions and a viewBox (1:1 print)', () => {
    const svg = documentToSvg(demoDocument())
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
    expect(svg).toMatch(/width="[\d.]+mm"/)
    expect(svg).toMatch(/height="[\d.]+mm"/)
    expect(svg).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/)
  })

  it('labels each connector by its designator', () => {
    const svg = documentToSvg(demoDocument())
    expect(svg).toContain('X1')
    expect(svg).toContain('X2')
  })

  it('handles an empty document without throwing', () => {
    const svg = documentToSvg(emptyDocument())
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
  })
})

// ── New formboard segment model ───────────────────────────────────────────────

describe('documentToSvg — formboard segments', () => {
  it('a routed single-wire doc contains the connector label and a coloured segment stroke', () => {
    const svg = documentToSvg(routedWireDoc())
    // Body label
    expect(svg).toContain('X1')
    // The segment for a single RD wire must use strokeForColor('RD') = #c62828
    expect(svg).toContain('#c62828')
    // Must use class="segment" (not the old wire-path)
    expect(svg).toContain('class="segment"')
    // The 100 mm scale bar must be present
    expect(svg).toContain('100 mm')
  })

  it('a doc where two wires share a segment contains segment--bundle', () => {
    const svg = documentToSvg(bundleWireDoc())
    expect(svg).toContain('segment--bundle')
    // Bundle is grey #999, not a wire colour
    expect(svg).toContain('#999')
  })

  it('draws every body as a dot of BODY_DOT_R and a bold label at labelPos', () => {
    const d = demoDocument()
    const svg = documentToSvg(d)
    const fb = computeFormboard(d)
    for (const b of fb.bodies) {
      expect(svg).toContain(`<circle class="body body-${b.kind}" cx="${fmt(b.pos.x)}" cy="${fmt(b.pos.y)}" r="${fmt(BODY_DOT_R)}"`)
      expect(svg).toContain(
        `<text class="body-label" x="${fmt(b.labelPos.x)}" y="${fmt(b.labelPos.y + LABEL_FONT * 0.35)}" font-size="${fmt(LABEL_FONT)}" font-weight="bold" text-anchor="start">${escapeXml(b.label)}</text>`
      )
    }
    expect(svg).not.toContain('class="pin-label"')
  })

  it('does NOT emit the old wire-path class', () => {
    const svg = documentToSvg(demoDocument())
    expect(svg).not.toContain('class="wire-path"')
  })

  it('single-wire segment label includes the run length in mm', () => {
    // Demo wire-1 runs X1.1 → X2.A. A body is ONE dot at its placement, so the
    // run is dot-to-dot: X1 at (52,60), X2 at (372,60) → 320 mm exactly.
    // The formboard prints the length alone — no wire size (user decision 2026-10-27).
    const svg = documentToSvg(demoDocument())
    expect(svg).toContain('>320 mm</text>')
  })

  it('a single-wire segment label carries no wire size', () => {
    const labels = documentToSvg(routedWireDoc()).match(/<text class="segment-label"[^>]*>[^<]*<\/text>/g) ?? []
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatch(/>200 mm<\/text>$/)
    expect(labels[0]).not.toContain('mm2')
  })

  it('skips segments whose endpoints are not placed', () => {
    // A segment referencing an unplaced cavity must not appear
    const d = emptyDocument()
    d.connectors = [
      {
        id: 'c1',
        designator: 'X1',
        cavities: [{ id: 'cav1', position: '1', status: 'populated' }]
      }
    ]
    d.placements = [{ refId: 'c1', pos: { x: 0, y: 0 } }]
    d.wires = [
      {
        id: 'w1',
        ends: [
          { type: 'cavity', cavityId: 'cav1' },
          { type: 'cavity', cavityId: 'ghost' }
        ],
        gauge: { value: 0.5, unit: 'mm2' },
        color: { base: 'RD' }
      }
    ]
    d.segments = [
      {
        id: 's1',
        from: { type: 'body', refId: 'c1' },
        to: { type: 'body', refId: 'ghost-body' }
      }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }]
    const svg = documentToSvg(d)
    // No segment rendered (ghost endpoint is unplaced)
    expect((svg.match(/class="segment"/g) ?? []).length).toBe(0)
  })
})

// ── Branch points ─────────────────────────────────────────────────────────────

describe('documentToSvg — routing layer', () => {
  it('draws a branch point and includes a scale-check bar labelled 100 mm', () => {
    const d = demoDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 200, y: 140 } }]
    d.segments.push({
      id: 'segx',
      from: { type: 'branch', branchId: 'bp1' },
      to: { type: 'body', refId: 'conn-x2' }
    })
    const svg = documentToSvg(d)
    expect(svg).toContain('class="branch-point"')
    expect(svg).toContain('100 mm')
    expect(svg).toContain('class="scale-bar"')
  })
})

// ── Narrow-width guard ────────────────────────────────────────────────────────

describe('documentToSvg — scale-bar width guard', () => {
  it('width is at least 124 mm on a narrow drawing so the 100 mm bar is never clipped', () => {
    const d = emptyDocument()
    d.connectors = [
      {
        id: 'c1',
        designator: 'X1',
        cavities: [{ id: 'cav1', position: '1', status: 'populated' }]
      }
    ]
    d.placements = [{ refId: 'c1', pos: { x: 0, y: 0 } }]
    const svg = documentToSvg(d)

    const m = svg.match(/width="([\d.]+)mm"/)
    expect(m).not.toBeNull()
    const widthMm = parseFloat(m![1])
    expect(widthMm).toBeGreaterThanOrEqual(124)

    expect(svg).toContain('class="scale-bar"')
    expect(svg).toContain('100 mm')
  })
})

// ── Treatments, labels, title block ──────────────────────────────────────────

describe('documentToSvg — sleeving/twist spans', () => {
  it('renders sleeving over a placed segment with class treatment treatment--sleeving', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a1', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b1', position: '1', status: 'populated' }] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 100, y: 0 } }
    ]
    d.segments = [
      {
        id: 'seg1',
        from: { type: 'body', refId: 'cA' },
        to: { type: 'body', refId: 'cB' }
      }
    ]
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'bundle', bundleId: 'b1' },
        span: { segmentIds: ['seg1'] },
        sleevingType: 'braided'
      }
    ]
    const svg = documentToSvg(d)
    expect(svg).toContain('class="treatment')
    expect(svg).toContain('treatment--sleeving')
  })

  it('renders twist over a placed segment with class treatment treatment--twist', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a1', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b1', position: '1', status: 'populated' }] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 100, y: 0 } }
    ]
    d.segments = [
      {
        id: 'seg1',
        from: { type: 'body', refId: 'cA' },
        to: { type: 'body', refId: 'cB' }
      }
    ]
    d.twists = [
      {
        id: 'tw1',
        wireIds: [],
        span: { segmentIds: ['seg1'] }
      }
    ]
    const svg = documentToSvg(d)
    expect(svg).toContain('class="treatment')
    expect(svg).toContain('treatment--twist')
  })

  it('renders the lay length on a twist span when set', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [{ id: 'a1', position: '1', status: 'populated' }] },
      { id: 'cB', designator: 'B', cavities: [{ id: 'b1', position: '1', status: 'populated' }] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 100, y: 0 } }
    ]
    d.segments = [
      {
        id: 'seg1',
        from: { type: 'body', refId: 'cA' },
        to: { type: 'body', refId: 'cB' }
      }
    ]
    d.twists = [{ id: 'tw1', wireIds: [], span: { segmentIds: ['seg1'] }, layLengthMm: 25 }]
    const svg = documentToSvg(d)
    expect(svg).toContain('lay 25 mm')
  })

  it('skips treatments whose segments are unresolved', () => {
    const d = emptyDocument()
    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'wire', wireId: 'w1' },
        span: { segmentIds: ['ghost-seg'] },
        sleevingType: 'braided'
      }
    ]
    const svg = documentToSvg(d)
    expect(svg).not.toContain('class="treatment')
  })
})

describe('documentToSvg — labels', () => {
  it('renders a label text at its pos with class label', () => {
    const d = emptyDocument()
    d.labels = [
      {
        id: 'lbl1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'callout',
        text: 'CAN-H',
        pos: { x: 50, y: 30 }
      }
    ]
    const svg = documentToSvg(d)
    expect(svg).toContain('class="label"')
    expect(svg).toContain('CAN-H')
  })

  it('renders a leader line from label.pos to target when leader=true', () => {
    const d = emptyDocument()
    d.branchPoints = [{ id: 'bp1', pos: { x: 80, y: 40 } }]
    d.labels = [
      {
        id: 'lbl1',
        target: { type: 'branchPoint', branchId: 'bp1' },
        kind: 'callout',
        text: 'Junction',
        pos: { x: 60, y: 20 },
        leader: true
      }
    ]
    const svg = documentToSvg(d)
    expect(svg).toContain('class="label"')
    expect(svg).toContain('class="label-leader"')
    expect(svg).toContain('Junction')
  })

  it('renders label without a leader when leader=false', () => {
    const d = emptyDocument()
    d.labels = [
      {
        id: 'lbl1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'wireMarker',
        text: 'W01',
        pos: { x: 50, y: 30 }
        // no leader property
      }
    ]
    const svg = documentToSvg(d)
    expect(svg).toContain('class="label"')
    expect(svg).not.toContain('class="label-leader"')
  })

  it('prefixes the label text with its human kind name', () => {
    const d = emptyDocument()
    d.labels = [
      {
        id: 'lbl1',
        target: { type: 'wire', wireId: 'w1' },
        kind: 'heatshrinkPrint',
        text: 'CAN H',
        pos: { x: 10, y: 10 }
      }
    ]
    expect(documentToSvg(d)).toContain('Heatshrink print: CAN H')
  })
})

describe('documentToSvg — title block', () => {
  it('renders a title-block group with class title-block when titleBlock is set', () => {
    const d = emptyDocument()
    d.drawing.titleBlock = { title: 'Loom B', revision: 'A', partNumber: 'AB' }
    const svg = documentToSvg(d)
    expect(svg).toContain('class="title-block"')
    expect(svg).toContain('Loom B')
  })

  it('does not render title-block when titleBlock is absent', () => {
    const d = emptyDocument()
    const svg = documentToSvg(d)
    expect(svg).not.toContain('class="title-block"')
  })

  it('title block does not break existing width/height or narrow-width guard', () => {
    const d = emptyDocument()
    d.drawing.titleBlock = { title: 'Test' }
    d.connectors = [
      { id: 'c1', designator: 'X1', cavities: [{ id: 'cv1', position: '1', status: 'populated' }] }
    ]
    d.placements = [{ refId: 'c1', pos: { x: 0, y: 0 } }]
    const svg = documentToSvg(d)
    const m = svg.match(/width="([\d.]+)mm"/)
    expect(m).not.toBeNull()
    expect(parseFloat(m![1])).toBeGreaterThanOrEqual(124)
    expect(svg).toContain('class="scale-bar"')
  })

  it('title-block x is >= content minX on a narrow drawing (no negative x)', () => {
    const d = emptyDocument()
    d.drawing.titleBlock = { title: 'Narrow', revision: 'B' }
    d.connectors = [
      { id: 'c1', designator: 'X1', cavities: [{ id: 'cv1', position: '1', status: 'populated' }] }
    ]
    d.placements = [{ refId: 'c1', pos: { x: 0, y: 0 } }]
    const svg = documentToSvg(d)
    const tbMatch = svg.match(/<g class="title-block">([\s\S]*?)<\/g>/)
    expect(tbMatch).not.toBeNull()
    const rectXMatch = tbMatch![1].match(/x="(-?[\d.]+)"/)
    expect(rectXMatch).not.toBeNull()
    const tbX = parseFloat(rectXMatch![1])
    // The dot's own bbox reaches BODY_DOT_R left of the placement, so "no
    // negative x" is really "not left of the content" — the clamp in
    // documentToSvg is `Math.max(minX, …)`.
    expect(tbX).toBeGreaterThanOrEqual(computeFormboard(d).bbox.minX)
  })
})

// ── Reversed-segment span orientation ────────────────────────────────────────

describe('documentToSvg — reversed-segment span orientation', () => {
  it('span polyline has continuous joints when the second segment is stored reversed', () => {
    const d = emptyDocument()

    d.branchPoints = [
      { id: 'bpA', pos: { x: 0, y: 0 } },
      { id: 'bpJ', pos: { x: 50, y: 0 } },
      { id: 'bpB', pos: { x: 100, y: 0 } }
    ]

    d.segments = [
      {
        id: 'seg1',
        from: { type: 'branch', branchId: 'bpJ' },
        to: { type: 'branch', branchId: 'bpA' }
      },
      {
        id: 'seg2',
        from: { type: 'branch', branchId: 'bpJ' },
        to: { type: 'branch', branchId: 'bpB' }
      }
    ]

    d.sleeving = [
      {
        id: 'slv1',
        target: { type: 'bundle', bundleId: 'b1' },
        span: {
          segmentIds: ['seg1', 'seg2'],
          startFraction: 0,
          endFraction: 1
        },
        sleevingType: 'braided'
      }
    ]

    const svg = documentToSvg(d)
    const pathMatch = svg.match(/class="treatment treatment--sleeving"[^>]*d="([^"]+)"/)
    expect(pathMatch).not.toBeNull()
    const pathD = pathMatch![1]

    const coords = [...pathD.matchAll(/[ML]\s+([-\d.]+)\s+([-\d.]+)/g)].map((m) => ({
      x: parseFloat(m[1]),
      y: parseFloat(m[2])
    }))

    expect(coords).toHaveLength(3)

    expect(coords[0].x).toBeCloseTo(0)
    expect(coords[0].y).toBeCloseTo(0)

    expect(coords[1].x).toBeCloseTo(50)
    expect(coords[1].y).toBeCloseTo(0)

    expect(coords[2].x).toBeCloseTo(100)
    expect(coords[2].y).toBeCloseTo(0)
  })
})

describe('renderDrawingGroup', () => {
  it('is exactly the drawing body of documentToSvg (refactor guard)', () => {
    const doc = demoDocument()
    const full = documentToSvg(doc)
    const body = renderDrawingGroup(computeFormboard(doc))
    expect(full).toContain(body)
  })
  it('textScale multiplies font sizes and stroke widths', () => {
    // Uses bundleWireDoc (not demoDocument) so a bundled segment (stroke-width
    // 3 → 6 under textScale=2) actually exists to assert on.
    const l = computeFormboard(bundleWireDoc())
    const a = renderDrawingGroup(l, { scaleBar: false })
    const b = renderDrawingGroup(l, { textScale: 2, scaleBar: false })
    const sizes = (s: string) => [...s.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(sizes(b)).toEqual(sizes(a).map((v) => Number((v * 2).toFixed(2))))
    expect(b).toContain('stroke-width="6"') // bundle band 3 → 6
  })
  it('scaleBar:false omits the scale bar', () => {
    expect(renderDrawingGroup(computeFormboard(demoDocument()), { scaleBar: false })).not.toContain('scale-bar')
  })
})

describe('renderDrawingGroup — scale-bar textScale (fix round 1)', () => {
  it('scale-bar tick offsets and label y-nudge scale with textScale', () => {
    const l = computeFormboard(demoDocument())
    const a = renderDrawingGroup(l, { textScale: 1 })
    const b = renderDrawingGroup(l, { textScale: 2 })

    const scaleBarGroup = (s: string) => s.match(/<g class="scale-bar">([\s\S]*?)<\/g>/)![1]

    // Tick span: the two vertical tick <line>s run from (barY - 1.5*ts) to (barY + 1.5*ts).
    const tickSpan = (s: string) => {
      const group = scaleBarGroup(s)
      const lines = [...group.matchAll(/<line[^>]*y1="([-\d.]+)"[^>]*y2="([-\d.]+)"/g)]
      // lines[0] is the horizontal bar itself (y1 === y2); lines[1]/[2] are the ticks.
      const [, y1, y2] = lines[1]
      return Number((Number(y2) - Number(y1)).toFixed(2))
    }
    expect(tickSpan(a)).toBe(3) // 1.5 + 1.5 at ts=1 — unchanged (documentToSvg path)
    expect(tickSpan(b)).toBe(6) // 2 * 3 at ts=2 — the bug: was still 3

    // Label y-nudge: label sits (barY - 2*ts) above the horizontal bar's y.
    const labelOffset = (s: string) => {
      const group = scaleBarGroup(s)
      const barY = Number(group.match(/<line[^>]*y1="([-\d.]+)"/)![1])
      const labelY = Number(group.match(/<text[^>]*y="([-\d.]+)"/)![1])
      return Number((barY - labelY).toFixed(2))
    }
    expect(labelOffset(a)).toBe(2)
    expect(labelOffset(b)).toBe(4)
  })
})

// ── Typed (broken) segment length ────────────────────────────────────────────

describe('renderDrawingGroup — broken typed length prints red', () => {
  const labelsOf = (svg: string) => svg.match(/<text class="segment-label"[^>]*>[^<]*<\/text>/g) ?? []

  it('a single-wire limb typed off its drawn length prints the typed value in #d32f2f', () => {
    const d = routedWireDoc() // drawn 200 mm
    d.segments[0].specifiedLengthMm = 250
    const labels = labelsOf(renderDrawingGroup(computeFormboard(d)))
    expect(labels).toHaveLength(1)
    expect(labels[0]).toContain('fill="#d32f2f"')
    expect(labels[0]).toContain('250 mm')
  })

  it('a typed length that matches the drawing (and an untyped one) prints without the red fill', () => {
    const d = routedWireDoc()
    expect(renderDrawingGroup(computeFormboard(d))).not.toContain('#d32f2f')
    d.segments[0].specifiedLengthMm = 200
    const svg = renderDrawingGroup(computeFormboard(d))
    expect(svg).not.toContain('#d32f2f')
    expect(labelsOf(svg)[0]).toContain('200 mm')
  })

  it('a broken BUNDLE limb still prints only its wire count, never red', () => {
    const d = bundleWireDoc()
    d.segments[0].specifiedLengthMm = 250
    const fb = computeFormboard(d)
    expect(fb.segments[0].broken).toBe(true) // guard: the fixture really is broken
    const labels = labelsOf(renderDrawingGroup(fb))
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatch(/>2<\/text>$/)
    expect(labels[0]).not.toContain('#d32f2f')
  })
})

describe('sleeve callout', () => {
  /** Two bodies joined by one run from `a` to `b`, sleeved PVC 5mm BK over it. */
  function sleevedRun(a: { x: number; y: number }, b: { x: number; y: number }): HarnessDocument {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [] },
      { id: 'cB', designator: 'B', cavities: [] }
    ]
    d.placements = [
      { refId: 'cA', pos: a },
      { refId: 'cB', pos: b }
    ]
    d.segments = [{ id: 's', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    d.sleeving = [
      { id: 'sl', target: { type: 'bundle', bundleId: 'x' }, span: { segmentIds: ['s'] }, sleevingType: 'pvc', size: '5mm', color: 'BK' }
    ]
    return d
  }
  const callout = (d: HarnessDocument) => computeFormboard(d).treatments[0].callouts![0]

  it('names the sleeve by ref, description and BOM item, and the PDF prints it', () => {
    const d = sleevedRun({ x: 0, y: 0 }, { x: 100, y: 0 })
    expect(callout(d).text).toBe('SL1 PVC tube 5mm BK [1]')
    d.sleeving[0].part = { partNumber: 'PVC-5-BK' }
    expect(callout(d).text).toBe('SL1 PVC tube 5mm BK [1]')
    const svg = renderDrawingGroup(computeFormboard(d))
    expect(svg).toContain('class="treatment-label treatment-label--sleeving"')
    expect(svg).toContain('>SL1 PVC tube 5mm BK [1]</text>')
  })

  it('sits a quarter of the way along, below a level run and right of a vertical one', () => {
    const level = callout(sleevedRun({ x: 0, y: 0 }, { x: 100, y: 0 })).rect
    expect(level.x + level.w / 2).toBeCloseTo(25, 6)
    expect(level.y).toBeCloseTo(SLEEVE_CALLOUT_GAP, 6)
    const upright = callout(sleevedRun({ x: 0, y: 0 }, { x: 0, y: 100 })).rect
    expect(upright.x).toBeCloseTo(SLEEVE_CALLOUT_GAP, 6)
    expect(upright.y + upright.h / 2).toBeCloseTo(25, 6)
  })

  it('keeps clear of a diagonal run along its whole box', () => {
    const r = callout(sleevedRun({ x: 0, y: 0 }, { x: 100, y: 100 })).rect
    // Signed distance of each box corner from the line y = x: all on one side, none nearer than the gap.
    const corners = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x, r.y + r.h],
      [r.x + r.w, r.y + r.h]
    ].map(([x, y]) => (y - x) / Math.SQRT2)
    expect(Math.min(...corners)).toBeGreaterThanOrEqual(SLEEVE_CALLOUT_GAP - 1e-9)
  })
})

describe('sleeve callouts on a shared run', () => {
  it('stack outward instead of printing on top of each other', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [] },
      { id: 'cB', designator: 'B', cavities: [] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 100, y: 0 } }
    ]
    d.segments = [{ id: 's', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    const span = { segmentIds: ['s'] }
    d.sleeving = [
      { id: 'a', target: { type: 'bundle', bundleId: 'x' }, span, sleevingType: 'pvc', size: '5mm', color: 'BK' },
      { id: 'b', target: { type: 'bundle', bundleId: 'x' }, span, sleevingType: 'heatshrink', size: '6mm' }
    ]
    const [a, b] = computeFormboard(d).treatments.map((t) => t.callouts![0].rect)
    expect(a.y).toBeCloseTo(SLEEVE_CALLOUT_GAP, 6)
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h)
  })
})

describe('sleeve callouts per piece', () => {
  it('a sleeve over two segments gets one callout beside each segment', () => {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [] },
      { id: 'cB', designator: 'B', cavities: [] },
      { id: 'cC', designator: 'C', cavities: [] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 100, y: 0 } },
      { refId: 'cC', pos: { x: 100, y: 200 } }
    ]
    d.segments = [
      { id: 's1', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } },
      { id: 's2', from: { type: 'body', refId: 'cB' }, to: { type: 'body', refId: 'cC' } }
    ]
    d.sleeving = [
      { id: 'sl', target: { type: 'bundle', bundleId: 'x' }, span: { segmentIds: ['s1', 's2'] }, sleevingType: 'pvc', size: '5mm', color: 'BK' }
    ]
    const [first, second] = computeFormboard(d).treatments[0].callouts!
    expect(first.text).toBe('SL1.1 PVC tube 5mm BK [1]')
    expect(second.text).toBe('SL1.2 PVC tube 5mm BK [2]')
    // Level s1: below it, a quarter along (x = 25). Upright s2: right of it, a quarter down (y = 50).
    expect(first.rect.x + first.rect.w / 2).toBeCloseTo(25, 6)
    expect(first.rect.y).toBeCloseTo(SLEEVE_CALLOUT_GAP, 6)
    expect(second.rect.x).toBeCloseTo(100 + SLEEVE_CALLOUT_GAP, 6)
    expect(second.rect.y + second.rect.h / 2).toBeCloseTo(50, 6)
  })
})

describe('sleeve colour', () => {
  function run(color?: string): HarnessDocument {
    const d = emptyDocument()
    d.connectors = [
      { id: 'cA', designator: 'A', cavities: [] },
      { id: 'cB', designator: 'B', cavities: [] }
    ]
    d.placements = [
      { refId: 'cA', pos: { x: 0, y: 0 } },
      { refId: 'cB', pos: { x: 100, y: 0 } }
    ]
    d.segments = [{ id: 's', from: { type: 'body', refId: 'cA' }, to: { type: 'body', refId: 'cB' } }]
    d.sleeving = [
      { id: 'sl', target: { type: 'bundle', bundleId: 'x' }, span: { segmentIds: ['s'] }, sleevingType: 'heatshrink', ...(color ? { color } : {}) }
    ]
    return d
  }

  it('draws the band in the sleeve colour with a dark edge, or the default blue without one', () => {
    const black = renderDrawingGroup(computeFormboard(run('BK')))
    expect(black).toContain(`class="treatment treatment--sleeving" d="M 0 0 L 100 0" stroke="${strokeForColor('BK')}"`)
    expect(black).toContain('class="treatment treatment--sleeving-edge"')
    const white = renderDrawingGroup(computeFormboard(run('WH')))
    expect(white).toContain(`stroke="${strokeForColor('WH')}"`)
    const plain = renderDrawingGroup(computeFormboard(run()))
    expect(plain).toContain('class="treatment treatment--sleeving" d="M 0 0 L 100 0" stroke="#4a90d9"')
    expect(plain).not.toContain('treatment--sleeving-edge')
  })

  it('draws the band under the run, so the wire line stays on top', () => {
    const svg = renderDrawingGroup(computeFormboard(run('YE')))
    expect(svg.indexOf('treatment--sleeving')).toBeGreaterThan(-1)
    expect(svg.indexOf('treatment--sleeving')).toBeLessThan(svg.indexOf('class="segment'))
  })
})
