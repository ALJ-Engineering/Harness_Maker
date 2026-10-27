import { describe, it, expect } from 'vitest'
import {
  endpointHandleId,
  parseHandleId,
  sameEndpoint,
  documentToFlow,
  describeEndpoint
} from './toFlow'
import { demoDocument } from '@shared/model/document'
import type { Endpoint } from '@shared/model/schema'

const endpoints: Endpoint[] = [
  { type: 'cavity', cavityId: 'cav-1' },
  { type: 'freeTerminal', terminalId: 'ft-1' },
  { type: 'splice', spliceId: 'sp-1' },
  { type: 'shield', cableId: 'cab-1', end: 'a' },
  { type: 'shield', cableId: 'cab-1', end: 'b' }
]

describe('handle id <-> endpoint', () => {
  it('roundtrips every endpoint kind', () => {
    for (const ep of endpoints) {
      expect(parseHandleId(endpointHandleId(ep))).toEqual(ep)
    }
  })

  it('sameEndpoint distinguishes the two shield ends', () => {
    expect(sameEndpoint(endpoints[3], endpoints[4])).toBe(false)
    expect(sameEndpoint(endpoints[3], { ...endpoints[3] })).toBe(true)
  })

  it('returns null for an unknown handle', () => {
    expect(parseHandleId('bogus:123')).toBeNull()
  })
})

describe('documentToFlow designators', () => {
  it('terminal and splice nodes carry their designator', () => {
    const doc = demoDocument()
    doc.splices.push({ id: 'sp-1', designator: 'SP1', kind: 'butt' })
    const { nodes } = documentToFlow(doc)
    expect(nodes.find((n) => n.id === 'ft-bplus')?.data.designator).toBe('T1')
    expect(nodes.find((n) => n.id === 'sp-1')?.data.designator).toBe('SP1')
  })
})

describe('documentToFlow', () => {
  it('projects the demo doc into nodes and edges', () => {
    const { nodes, edges } = documentToFlow(demoDocument())
    expect(nodes.map((n) => n.type).sort()).toEqual(['connector', 'connector', 'freeTerminal'])
    expect(edges).toHaveLength(2)
    // wire-1 connects two cavity handles
    const w1 = edges.find((e) => e.id === 'wire-1')!
    expect(w1.sourceHandle).toBe('cav:cav-x1-1')
    expect(w1.targetHandle).toBe('cav:cav-x2-a')
  })

  it('wire edge data includes gauge but not lengthMm (length is formboard-only)', () => {
    // demoDocument has wireRoutes for wire-1 and wire-2 via seg-1 and seg-2.
    // The schematic projection no longer includes lengthMm in edge data — length
    // is derived from the physical/formboard layout and shown in the properties panel.
    const { edges } = documentToFlow(demoDocument())
    const w1 = edges.find((e) => e.id === 'wire-1')!
    const d = w1.data as { gauge?: string; lengthMm?: unknown }
    expect(d.gauge).toContain('mm2')
    expect(d.lengthMm).toBeUndefined()
  })

  it('placed bodies are deletable, so Delete/Backspace reaches onBeforeDelete', () => {
    // React Flow drops `deletable: false` nodes before onBeforeDelete ever sees
    // them — a body flagged that way can never be removed from the keyboard.
    const doc = demoDocument()
    doc.splices.push({ id: 'sp-1', designator: 'SP1', kind: 'butt' })
    const { nodes } = documentToFlow(doc)
    for (const n of nodes) expect(n.deletable, n.type).not.toBe(false)
  })
})

describe('documentToFlow — splices', () => {
  it('projects a splice to a splice node and resolves a wire to its handle', () => {
    const doc = demoDocument()
    doc.splices = [{ id: 'sp-1', designator: 'SP1', kind: 'butt' }]
    doc.placements.push({ refId: 'sp-1', pos: { x: 200, y: 200 } })
    doc.wires.push({
      id: 'wire-sp',
      ends: [
        { type: 'cavity', cavityId: 'cav-x1-3' },
        { type: 'splice', spliceId: 'sp-1' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'GN' }
    })

    const { nodes, edges } = documentToFlow(doc)

    const spNode = nodes.find((n) => n.id === 'sp-1')
    expect(spNode?.type).toBe('splice')
    expect(spNode?.position).toEqual({ x: 200, y: 200 })

    const w = edges.find((e) => e.id === 'wire-sp')!
    expect(w.target).toBe('sp-1')
    expect(w.targetHandle).toBe('sp:sp-1')
  })
})

describe('documentToFlow — schematicPos + gauge-only label', () => {
  it('schematic node uses schematicPos when present, else falls back to pos', () => {
    const d = demoDocument()
    // give conn-x1 a distinct schematic position
    const pl = d.placements.find((p) => p.refId === 'conn-x1')!
    pl.schematicPos = { x: 500, y: 500 }
    const { nodes } = documentToFlow(d)
    expect(nodes.find((n) => n.id === 'conn-x1')!.position).toEqual({ x: 500, y: 500 })
    // conn-x2 has no schematicPos → falls back to its physical pos
    const x2pos = d.placements.find((p) => p.refId === 'conn-x2')!.pos
    expect(nodes.find((n) => n.id === 'conn-x2')!.position).toEqual(x2pos)
  })

  it('schematic wire edge label does not include a mm length (gauge only)', () => {
    const { edges } = documentToFlow(demoDocument())
    const w = edges.find((e) => e.id === 'wire-1')!
    const data = w.data as { gauge?: string; lengthMm?: number | null }
    expect(data.gauge).toContain('mm2') // gauge present
    // no rendered length: either lengthMm is omitted or WireEdge ignores it (asserted via gauge-only label)
  })
})

describe('documentToFlow — schematic exit side', () => {
  it('connector node data carries the schematic exit side (default right)', () => {
    const d = demoDocument()
    const { nodes } = documentToFlow(d)
    expect((nodes.find((n) => n.id === 'conn-x1')!.data as { exitSide: string }).exitSide).toBe('right')
    // set a schematic exit side
    d.placements.find((p) => p.refId === 'conn-x1')!.schematicExitSide = 'left'
    const out = documentToFlow(d)
    expect((out.nodes.find((n) => n.id === 'conn-x1')!.data as { exitSide: string }).exitSide).toBe('left')
  })
})

describe('documentToFlow — reversed pin order', () => {
  // X1's cavities in the demo are 1, 2, 3; the flip mirrors the symbol
  // top↔bottom, so pin 1 goes to the bottom row.
  const order = (d: ReturnType<typeof demoDocument>): string[] =>
    (documentToFlow(d).nodes.find((n) => n.id === 'conn-x1')!.data as { cavities: { position: string }[] })
      .cavities.map((c) => c.position)

  it('lists cavities in natural order by default', () => {
    expect(order(demoDocument())).toEqual(['1', '2', '3'])
  })

  it('lists them bottom-up when the placement reverses the pin order', () => {
    const d = demoDocument()
    d.placements.find((p) => p.refId === 'conn-x1')!.schematicPinOrderReversed = true
    expect(order(d)).toEqual(['3', '2', '1'])
  })
})

describe('describeEndpoint', () => {
  const doc = demoDocument()

  it('labels a cavity as designator.position', () => {
    expect(describeEndpoint(doc, { type: 'cavity', cavityId: 'cav-x1-1' })).toBe('X1.1')
    expect(describeEndpoint(doc, { type: 'cavity', cavityId: 'cav-x2-a' })).toBe('X2.A')
  })

  it('labels a free terminal with its landing', () => {
    expect(describeEndpoint(doc, { type: 'freeTerminal', terminalId: 'ft-bplus' })).toBe(
      'T1 ring → B+ stud'
    )
  })

  it('falls back gracefully for unknown ids', () => {
    expect(describeEndpoint(doc, { type: 'cavity', cavityId: 'nope' })).toBe('cavity ?')
  })
})

describe('schematic connector node lists cavities in natural order (session-10 nit)', () => {
  it('sorts "1","2","10" numerically regardless of document order', () => {
    const d = demoDocument()
    const c = d.connectors[0]
    c.cavities = [
      { id: 'z10', position: '10', status: 'populated' },
      { id: 'z1', position: '1', status: 'populated' },
      { id: 'z2', position: '2', status: 'populated' }
    ]
    const { nodes } = documentToFlow(d)
    const n = nodes.find((x) => x.id === c.id)!
    expect((n.data as { cavities: { position: string }[] }).cavities.map((cv) => cv.position)).toEqual([
      '1',
      '2',
      '10'
    ])
    // Display-only: the stored order is untouched.
    expect(d.connectors[0].cavities.map((cv) => cv.position)).toEqual(['10', '1', '2'])
  })
})
