import { describe, it, expect } from 'vitest'
import {
  computeFormboard,
  runLabel,
  bodyLabel,
  BODY_DOT_R,
  BODY_LABEL_OFFSET,
  LABEL_FONT,
  MIN_FONT,
  estTextWidthMm,
  LABEL_OFFSET,
  labelDisplayText,
} from './formboard'
import { segmentLengthMm } from './geometry'
import { computeCutList } from '../export/bom'
import { applyMergeBranchPoints } from './routing'
import { computeBom } from '../export/bom'
import { produce } from 'immer'
import { demoDocument, emptyDocument } from './document'
import type { HarnessDocument, RouteNode } from './schema'

describe('runLabel', () => {
  it('returns gauge · length when both are present', () => {
    expect(runLabel('0.5 mm2', 123.6)).toBe('0.5 mm2 · 124 mm')
  })

  it('returns gauge only when length is absent', () => {
    expect(runLabel('0.5 mm2', null)).toBe('0.5 mm2')
    expect(runLabel('0.5 mm2', undefined)).toBe('0.5 mm2')
  })

  it('returns length only when gauge is absent', () => {
    expect(runLabel(null, 50)).toBe('50 mm')
    expect(runLabel(undefined, 50)).toBe('50 mm')
  })

  it('returns empty string when neither is present', () => {
    expect(runLabel(null, null)).toBe('')
    expect(runLabel(undefined, undefined)).toBe('')
    expect(runLabel()).toBe('')
  })
})

function doc2(): HarnessDocument {
  const d = emptyDocument()
  d.connectors = [
    { id: 'c1', designator: 'X1', cavities: [
      { id: 'a', position: '1', status: 'populated' },
      { id: 'b', position: '2', status: 'populated' } ] },
    { id: 'c2', designator: 'X2', cavities: [{ id: 'z', position: 'A', status: 'populated' }] }
  ]
  d.placements = [{ refId: 'c1', pos: { x: 0, y: 0 } }, { refId: 'c2', pos: { x: 200, y: 0 } }]
  d.wires = [{ id: 'w1', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'z' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'RD' } }]
  d.segments = [{ id: 's1', from: { type: 'body', refId: 'c1' }, to: { type: 'body', refId: 'c2' } }]
  d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }]
  return d
}

describe('computeFormboard', () => {
  it('colours a segment by its single routed wire and is not a bundle', () => {
    const s = computeFormboard(doc2()).segments.find((x) => x.id === 's1')!
    expect(s.wireIds).toEqual(['w1'])
    expect(s.bundle).toBe(false)
    expect(s.colour).toBe('RD')
    expect(s.gauge).toBe('0.5 mm2')
    // the two nodes resolve to the two connectors' dots
    expect(s.a.x).toBeLessThan(s.b.x)
  })

  it('marks a segment shared by two wires as a bundle (grey, no single colour)', () => {
    const d = doc2()
    d.wires.push({ id: 'w2', ends: [{ type: 'cavity', cavityId: 'b' }, { type: 'cavity', cavityId: 'z' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } })
    d.wireRoutes.push({ wireId: 'w2', path: ['s1'] }) // both wires share s1
    const s = computeFormboard(d).segments.find((x) => x.id === 's1')!
    expect(s.bundle).toBe(true)
    expect(s.wireIds.sort()).toEqual(['w1', 'w2'])
    expect(s.colour).toBeUndefined()
  })

  it('bbox covers all bodies and the segment', () => {
    const bb = computeFormboard(doc2()).bbox
    expect(bb.minX).toBeLessThanOrEqual(0)
    expect(bb.maxX).toBeGreaterThanOrEqual(200)
  })

  it('skips a segment whose node is unplaced (no NaN)', () => {
    const d = doc2()
    d.placements = d.placements.filter((p) => p.refId !== 'c2')
    const segs = computeFormboard(d).segments
    expect(segs.find((x) => x.id === 's1')).toBeUndefined()
  })

  it('lengthMm is the model-derived dot-to-dot distance (B1)', () => {
    // doc2: c1 'X1' at (0,0), c2 'X2' at (200,0) — the dots ARE the placements,
    // so the limb is a flat 200 mm.
    const s = computeFormboard(doc2()).segments.find((x) => x.id === 's1')!
    expect(s.lengthMm).not.toBeNull()
    expect(s.lengthMm).toBeCloseTo(200, 4)
    // and it agrees with the drawn line, which is the whole point of B1
    expect(s.lengthMm).toBeCloseTo(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y))
  })

  it('lengthMm is null when a segment endpoint is unplaced (tested via segmentLengthMm)', () => {
    // computeFormboard skips segments with unresolved anchors entirely.
    // We verify the null contract via the underlying segmentLengthMm function.
    // Doc2 with c2 unplaced: s1 references body c2; resolveNodePos(c2) → null
    // so segmentLengthMm returns null for that segment.
    // (The segment also won't appear in computeFormboard's output, which is tested elsewhere.)
    const d = doc2()
    d.placements = d.placements.filter((p) => p.refId !== 'c2')
    expect(segmentLengthMm(d, 's1')).toBeNull()
  })

  it('all text sizes are at least 10 pt (≈ 3.528 mm)', () => {
    const tenPtMm = (10 * 25.4) / 72
    expect(MIN_FONT).toBeCloseTo(tenPtMm)
    expect(LABEL_FONT).toBeGreaterThanOrEqual(tenPtMm)
  })

  it('estTextWidthMm scales with font size', () => {
    expect(estTextWidthMm('AB', LABEL_FONT)).toBeCloseTo(2 * LABEL_FONT * 0.62)
  })
})

describe('computeFormboard — bundle band after merging branch points', () => {
  const RN = (branchId: string): RouteNode => ({ type: 'branch', branchId })
  const ep = (refId: string): RouteNode => ({ type: 'body', refId })

  it('the shared limb formed by merging two branch points renders as a grey bundle band', () => {
    // w1: a1→P→R→b1, w2: a2→P→S→b2. Branch points carry positions so their
    // segments resolve in the formboard even without connectors placed.
    const d = emptyDocument()
    d.wires = [
      { id: 'w1', ends: [{ type: 'cavity', cavityId: 'a1' }, { type: 'cavity', cavityId: 'b1' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } },
      { id: 'w2', ends: [{ type: 'cavity', cavityId: 'a2' }, { type: 'cavity', cavityId: 'b2' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'BK' } }
    ]
    d.branchPoints = [
      { id: 'P', pos: { x: 40, y: 0 } },
      { id: 'R', pos: { x: 80, y: 0 } },
      { id: 'S', pos: { x: 80, y: 4 } }
    ]
    d.segments = [
      { id: 'a1P', from: ep('a1'), to: RN('P') },
      { id: 'sPR', from: RN('P'), to: RN('R') },
      { id: 'Rb1', from: RN('R'), to: ep('b1') },
      { id: 'a2P', from: ep('a2'), to: RN('P') },
      { id: 'sPS', from: RN('P'), to: RN('S') },
      { id: 'Sb2', from: RN('S'), to: ep('b2') }
    ]
    d.wireRoutes = [
      { wireId: 'w1', path: ['a1P', 'sPR', 'Rb1'] },
      { wireId: 'w2', path: ['a2P', 'sPS', 'Sb2'] }
    ]

    // Before the merge the parallel limbs are two single-wire segments.
    const before = computeFormboard(d)
    expect(before.segments.find((s) => s.id === 'sPR')!.bundle).toBe(false)

    const merged = produce(d, (draft) => {
      applyMergeBranchPoints(draft, 'S', 'R')
    })
    const fb = computeFormboard(merged)
    const shared = fb.segments.find((s) => s.id === 'sPR')!
    expect(shared.bundle).toBe(true) // grey band, no single colour
    expect(shared.colour).toBeUndefined()
    expect(shared.wireIds.sort()).toEqual(['w1', 'w2'])
  })
})

describe('computeFormboard anchored labels', () => {
  const RN = (b: string): RouteNode => ({ type: 'branch', branchId: b })
  it('puts the bead on the wire (lerp) and offsets the text + leader', () => {
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'P', pos: { x: 0, y: 0 } },
      { id: 'Q', pos: { x: 100, y: 0 } }
    ]
    d.segments = [{ id: 's1', from: RN('P'), to: RN('Q') }]
    d.wires = [
      { id: 'w1', ends: [{ type: 'splice', spliceId: 'x' }, { type: 'splice', spliceId: 'y' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['s1'] }]
    d.labels = [
      { id: 'L', target: { type: 'wire', wireId: 'w1' }, kind: 'wireMarker', text: 'M', pos: { x: 0, y: 0 }, anchor: { segmentId: 's1', fraction: 0.25 } }
    ]
    const fb = computeFormboard(d).labels.find((l) => l.id === 'L')!
    expect(fb.bead).toEqual({ x: 25, y: 0 })
    expect(fb.leader).toEqual({ x: 25, y: 0 })
    expect(fb.pos).toEqual({ x: 25 + LABEL_OFFSET.x, y: LABEL_OFFSET.y })
  })

  it('falls back to the free pos when the anchor segment is unresolved', () => {
    const d = emptyDocument()
    d.labels = [
      { id: 'L', target: { type: 'wire', wireId: 'w1' }, kind: 'flag', text: 'M', pos: { x: 7, y: 9 }, anchor: { segmentId: 'ghost', fraction: 0.5 } }
    ]
    const fb = computeFormboard(d).labels.find((l) => l.id === 'L')!
    expect(fb.bead).toBeUndefined()
    expect(fb.pos).toEqual({ x: 7, y: 9 })
  })
})

describe('dot bodies', () => {
  it('every placed connector / terminal / splice is one FbBody at its placement pos', () => {
    const d = demoDocument()
    const fb = computeFormboard(d)
    for (const p of d.placements) {
      const b = fb.bodies.find((x) => x.id === p.refId)
      expect(b, p.refId).toBeDefined()
      expect(b!.pos).toEqual(p.pos)
      expect(b!.labelPos).toEqual({
        x: p.pos.x + BODY_LABEL_OFFSET.x,
        y: p.pos.y + BODY_LABEL_OFFSET.y
      })
    }
    expect(fb.bodies.length).toBe(d.placements.length)
  })

  it('bodyLabel formats designator + BOM items', () => {
    expect(bodyLabel('C2', [14, 15])).toBe('C2 [14, 15]')
    expect(bodyLabel('C2', [])).toBe('C2')
  })

  it('connector label carries the BOM items of housing + contacts, sorted', () => {
    const d = emptyDocument()
    d.connectors.push({
      id: 'c1',
      designator: 'C2',
      housing: { partNumber: 'HSG' },
      cavities: [{ id: 'cv1', position: '1', status: 'populated', pin: { partNumber: 'PIN' } }]
    })
    d.placements.push({ refId: 'c1', pos: { x: 10, y: 20 } })
    const items = computeBom(d).map((l) => l.item)
    const fb = computeFormboard(d)
    expect(fb.bodies[0].label).toBe(`C2 [${[...items].sort((a, b) => a - b).join(', ')}]`)
  })

  it('segments run dot to dot and lengthMm is the dot distance', () => {
    const d = emptyDocument()
    d.connectors.push({
      id: 'c1',
      designator: 'X1',
      cavities: [{ id: 'a', position: '1', status: 'populated' }]
    })
    d.freeTerminals.push({ id: 'ft1', designator: 'T1', kind: 'ring' })
    d.placements.push({ refId: 'c1', pos: { x: 0, y: 0 } }, { refId: 'ft1', pos: { x: 300, y: 400 } })
    d.wires.push({
      id: 'w1',
      ends: [
        { type: 'cavity', cavityId: 'a' },
        { type: 'freeTerminal', terminalId: 'ft1' }
      ],
      gauge: { value: 1, unit: 'mm2' },
      color: { base: 'RD' }
    })
    d.segments.push({ id: 's1', from: { type: 'body', refId: 'c1' }, to: { type: 'body', refId: 'ft1' } })
    d.wireRoutes.push({ wireId: 'w1', path: ['s1'] })
    const fb = computeFormboard(d)
    expect(fb.segments[0].a).toEqual({ x: 0, y: 0 })
    expect(fb.segments[0].b).toEqual({ x: 300, y: 400 })
    expect(fb.segments[0].lengthMm).toBe(500)
  })

  it('bbox covers dots (± radius) and their labels', () => {
    const d = emptyDocument()
    d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] })
    d.placements.push({ refId: 'c1', pos: { x: 0, y: 0 } })
    const fb = computeFormboard(d)
    expect(fb.bbox.minX).toBeLessThanOrEqual(-BODY_DOT_R)
    expect(fb.bbox.minY).toBeLessThanOrEqual(-BODY_DOT_R)
    expect(fb.bbox.maxX).toBeGreaterThan(BODY_LABEL_OFFSET.x)
  })
})

describe('labelDisplayText', () => {
  it('prefixes the human kind name; omits the colon when text is empty', () => {
    expect(labelDisplayText('heatshrinkPrint', 'CAN H')).toBe('Heatshrink print: CAN H')
    expect(labelDisplayText('wireMarker', 'W01')).toBe('Wire marker: W01')
    expect(labelDisplayText('callout', '')).toBe('Callout')
  })
})

describe('body labels lead with the designator', () => {
  const labelOf = (doc: HarnessDocument, id: string): string | undefined =>
    computeFormboard(doc).bodies.find((b) => b.id === id)?.label

  it('terminal: designator + landsOn; without landsOn just the designator; splice: designator', () => {
    const d = emptyDocument()
    d.freeTerminals = [
      { id: 't1', designator: 'T1', kind: 'ring', landsOn: 'B+ stud' },
      { id: 't2', designator: 'T2', kind: 'ring' }
    ]
    d.splices = [{ id: 's1', designator: 'SP1', kind: 'butt' }]
    d.placements = [
      { refId: 't1', pos: { x: 0, y: 0 } },
      { refId: 't2', pos: { x: 50, y: 0 } },
      { refId: 's1', pos: { x: 100, y: 0 } }
    ]
    expect(labelOf(d, 't1')).toBe('T1 B+ stud')
    expect(labelOf(d, 't2')).toBe('T2')
    expect(labelOf(d, 's1')).toBe('SP1')
  })

  it('the demo terminal reads T1 B+ stud (modulo a BOM-items suffix)', () => {
    expect(labelOf(demoDocument(), 'ft-bplus')).toMatch(/^T1 B\+ stud/)
  })
})

describe('typed segment length on the formboard', () => {
  it('typed length survives a drag and reads broken; the cut list keeps the typed length', () => {
    const d = doc2()
    d.segments[0].specifiedLengthMm = 200 // = drawn
    const before = computeFormboard(d).segments.find((x) => x.id === 's1')!
    expect(before.broken).toBe(false)
    expect(before.lengthMm).toBe(200)
    d.placements.find((p) => p.refId === 'c2')!.pos = { x: 260, y: 0 } // drag
    const after = computeFormboard(d).segments.find((x) => x.id === 's1')!
    expect(after.broken).toBe(true)
    expect(after.specifiedLengthMm).toBe(200)
    expect(after.lengthMm).toBe(200) // the label shows the typed value
    expect(after.drawnLengthMm).toBeCloseTo(260)
    expect(computeCutList(d).find((r) => r.sourceId === 'w1')!.lengthMm).toBe(200)
  })
})
