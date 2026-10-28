import { describe, it, expect, beforeEach } from 'vitest'
import { useHarnessStore } from './store'
import { emptyDocument, demoDocument } from '@shared/model/document'
import { routeConnected, wireLength } from '@shared/model/geometry'
import type { HarnessDocument } from '@shared/model/schema'
import { newLibraryPart, type LibraryPart } from '@shared/parts/librarySchema'
import { LibraryCatalog } from '@shared/parts/catalog'
import { runDrc } from '@shared/drc'
import { computeFormboard } from '@shared/model/formboard'
import { framedSheetOrigin } from '@shared/print/board'

const s = () => useHarnessStore.getState()

/**
 * Cavity ids the fixtures below wire up. Route nodes are body-keyed (schema
 * 0.4.0), so a wire end only auto-routes if its cavity has an owning connector:
 * `reset()` seeds one single-cavity connector per id, giving the connector the
 * SAME id as its cavity so a fixture can name the body it lands on directly.
 */
const FIXTURE_CAVITIES = [
  'a', 'b', 'c', 'd', 'e', 'f', 'x', 'y', 'z',
  'a0', 'a1', 'a2', 'b0', 'b1', 'b2', 'cA', 'cB', 'cC'
]

/**
 * An empty document that already carries `drawing.sheetOrigin`, i.e. a current
 * (0.6+) file: `setDocument` keeps it as the very object passed, clean. A
 * document WITHOUT one is pinned on load (a new object, dirty) — that has its
 * own tests below; every other fixture loads one of these.
 */
function pinnedEmpty(): HarnessDocument {
  const doc = emptyDocument()
  doc.drawing.sheetOrigin = { x: 0, y: 0 }
  return doc
}

/** Reset to a known, "saved" document (fixture bodies only) with cleared history. */
function reset(): HarnessDocument {
  const doc = pinnedEmpty()
  for (const id of FIXTURE_CAVITIES)
    doc.connectors.push({
      id,
      designator: id,
      cavities: [{ id, position: '1', status: 'populated' }]
    })
  s().setDocument(doc, '/tmp/test.harness.json')
  return doc
}

/** Reset to a truly empty document — for tests that COUNT connectors. */
function resetEmpty(): HarnessDocument {
  const doc = pinnedEmpty()
  s().setDocument(doc, '/tmp/test.harness.json')
  return doc
}

/**
 * Create a chain of real, end-to-end segments with the given ids (plus the
 * branch points they hang off). Span-carrying actions reject ids that are not a
 * contiguous run of LIVE segments (R2), so tests that used to pass invented
 * segment ids need the geometry to actually exist.
 */
function addChain(ids: string[]): void {
  s().applyEdit((d) => {
    let prev = `${ids[0]}-n0`
    d.branchPoints.push({ id: prev, pos: { x: 0, y: 0 } })
    ids.forEach((id, i) => {
      const next = `${ids[0]}-n${i + 1}`
      d.branchPoints.push({ id: next, pos: { x: (i + 1) * 10, y: 0 } })
      d.segments.push({
        id,
        from: { type: 'branch', branchId: prev },
        to: { type: 'branch', branchId: next }
      })
      prev = next
    })
  })
}

describe('history (undo/redo)', () => {
  beforeEach(() => reset())

  it('starts with no history and clean', () => {
    expect(s().past.length).toBe(0)
    expect(s().future.length).toBe(0)
    expect(s().dirty).toBe(false)
  })

  it('applyEdit pushes one undo entry and marks dirty', () => {
    resetEmpty()
    s().applyEdit((d) => {
      d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] })
    })
    expect(s().doc.connectors).toHaveLength(1)
    expect(s().past).toHaveLength(1)
    expect(s().dirty).toBe(true)
  })

  it('undo restores previous state; redo re-applies', () => {
    resetEmpty()
    s().applyEdit((d) => {
      d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] })
    })
    s().undo()
    expect(s().doc.connectors).toHaveLength(0)
    expect(s().future).toHaveLength(1)
    s().redo()
    expect(s().doc.connectors).toHaveLength(1)
    expect(s().future).toHaveLength(0)
  })

  it('undo back to the saved state clears dirty', () => {
    s().applyEdit((d) => {
      d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] })
    })
    expect(s().dirty).toBe(true)
    s().undo()
    expect(s().dirty).toBe(false) // reference-equal to savedDoc again
  })

  it('a new edit clears the redo stack', () => {
    s().applyEdit((d) => d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] }))
    s().undo()
    expect(s().future).toHaveLength(1)
    s().applyEdit((d) => d.connectors.push({ id: 'c2', designator: 'X2', cavities: [] }))
    expect(s().future).toHaveLength(0)
  })

  it('marking saved makes the current state the clean baseline', () => {
    s().applyEdit((d) => d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] }))
    s().markSaved('/tmp/test.harness.json')
    expect(s().dirty).toBe(false)
    s().applyEdit((d) => d.connectors.push({ id: 'c2', designator: 'X2', cavities: [] }))
    expect(s().dirty).toBe(true)
    s().undo() // back to the saved 1-connector state
    expect(s().dirty).toBe(false)
  })

  it('markSaved with the written document stays dirty for an edit made during the write', () => {
    const written = s().doc
    s().applyEdit((d) => d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] }))
    s().markSaved('/tmp/test.harness.json', written)
    expect(s().savedDoc).toBe(written)
    expect(s().dirty).toBe(true)
    s().undo() // back to what is on disk
    expect(s().dirty).toBe(false)
  })

  it('markSaved with the current document is clean', () => {
    s().applyEdit((d) => d.connectors.push({ id: 'c1', designator: 'X1', cavities: [] }))
    s().markSaved('/tmp/test.harness.json', s().doc)
    expect(s().dirty).toBe(false)
  })
})

describe('batchEdit', () => {
  beforeEach(() => resetEmpty())
  const add = (id: string) => s().applyEdit((d) => d.connectors.push({ id, designator: id, cavities: [] }))

  it('collapses the actions it runs into ONE undo step', () => {
    add('c0')
    const before = s().doc
    expect(
      s().batchEdit(() => {
        add('c1')
        add('c2')
        add('c3')
        return true
      })
    ).toBe(true)
    expect(s().doc.connectors).toHaveLength(4)
    expect(s().past).toHaveLength(2)
    expect(s().past[1]).toBe(before)
    expect(s().dirty).toBe(true)
    s().undo()
    expect(s().doc).toBe(before)
  })

  it('a refusal restores doc, past, future and dirty exactly', () => {
    add('c0')
    s().undo() // leaves a redo entry, so `future` is non-empty too
    const snap = s()
    expect(
      s().batchEdit(() => {
        add('c1')
        add('c2')
        return false
      })
    ).toBe(false)
    expect(s().doc).toBe(snap.doc)
    expect(s().past).toBe(snap.past)
    expect(s().future).toBe(snap.future)
    expect(s().dirty).toBe(snap.dirty)
  })

  it('a throw restores the snapshot and rethrows', () => {
    const snap = s()
    expect(() =>
      s().batchEdit(() => {
        add('c1')
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(s().doc).toBe(snap.doc)
    expect(s().past).toBe(snap.past)
    expect(s().dirty).toBe(false)
  })

  it('a run that changes nothing leaves no history entry', () => {
    add('c0')
    const snap = s()
    expect(s().batchEdit(() => (s().applyEdit(() => {}), true))).toBe(true)
    expect(s().doc).toBe(snap.doc)
    expect(s().past).toBe(snap.past)
  })

  it('keeps the history limit', () => {
    for (let i = 0; i < 200; i++) add(`p${i}`)
    expect(s().past).toHaveLength(200)
    const before = s().doc
    s().batchEdit(() => (add('x'), add('y'), true))
    expect(s().past).toHaveLength(200)
    expect(s().past[199]).toBe(before)
  })

  it('batch back to the saved document is clean', () => {
    const saved = s().doc
    add('c0')
    s().batchEdit(() => (s().undo(), true))
    expect(s().doc).toBe(saved)
    expect(s().dirty).toBe(false)
  })
})

describe('wire creation / deletion', () => {
  beforeEach(() => reset())

  it('addWire creates an undoable wire', () => {
    const id = s().addWire(
      { type: 'cavity', cavityId: 'x' },
      { type: 'freeTerminal', terminalId: 'y' }
    )
    expect(s().doc.wires).toHaveLength(1)
    expect(s().doc.wires[0].id).toBe(id)
    expect(s().dirty).toBe(true)
    s().undo()
    expect(s().doc.wires).toHaveLength(0)
    expect(s().dirty).toBe(false)
  })

  it('a new wire from a factory lead takes the size and colour of the lead, not 0.5 mm² grey', () => {
    s().applyEdit((d) => {
      d.connectors.push({
        id: 'f1',
        designator: 'F1',
        cavities: [{ id: 'lead', position: '1', status: 'populated', lead: { gauge: { value: 14, unit: 'AWG' }, color: { base: 'RD' } } }]
      })
    })
    s().addWire({ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'lead' })
    s().addWire({ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'z' })
    expect(s().doc.wires.map((w) => [w.gauge, w.color])).toEqual([
      [{ value: 14, unit: 'AWG' }, { base: 'RD' }],
      [{ value: 0.5, unit: 'mm2' }, { base: 'GY' }]
    ])
  })

  it('parallel wires between the same pins are allowed (multigraph)', () => {
    const a = { type: 'cavity', cavityId: 'x' } as const
    const b = { type: 'cavity', cavityId: 'z' } as const
    s().addWire(a, b)
    s().addWire(a, b)
    expect(s().doc.wires).toHaveLength(2)
  })

  it('removeWire drops the wire and its route', () => {
    const id = s().addWire(
      { type: 'cavity', cavityId: 'x' },
      { type: 'cavity', cavityId: 'z' }
    )
    s().applyEdit((d) => d.wireRoutes.push({ wireId: id, path: [] }))
    s().removeWire(id)
    expect(s().doc.wires).toHaveLength(0)
    expect(s().doc.wireRoutes).toHaveLength(0)
    s().undo() // removeWire is undoable
    expect(s().doc.wires).toHaveLength(1)
  })
})

describe('adding elements from the UI', () => {
  beforeEach(() => reset())

  it('addConnector creates a connector + placement with one cavity, as one undo step', () => {
    const id = s().addConnector({ x: 100, y: 50 })
    const conn = s().doc.connectors.find((c) => c.id === id)
    expect(conn).toBeDefined()
    expect(conn!.cavities).toHaveLength(1)
    expect(conn!.cavities[0].position).toBe('1')
    expect(conn!.cavities[0].status).toBe('populated')
    // placement created near the requested position
    const p = s().doc.placements.find((pp) => pp.refId === id)
    expect(p).toBeDefined()
    // one atomic undo step removes both the entity and its placement
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(s().doc.connectors.find((c) => c.id === id)).toBeUndefined()
    expect(s().doc.placements.find((pp) => pp.refId === id)).toBeUndefined()
    expect(s().dirty).toBe(false)
  })

  it('addConnector auto-increments the designator (X1, X2, …)', () => {
    resetEmpty()
    s().addConnector({ x: 0, y: 0 })
    s().addConnector({ x: 0, y: 0 })
    const designators = s().doc.connectors.map((c) => c.designator)
    expect(designators).toEqual(['X1', 'X2'])
  })

  it('addConnector takes the lowest free number (fills gaps)', () => {
    s().applyEdit((d) => {
      d.connectors.push({ id: 'pre', designator: 'X5', cavities: [] })
    })
    const id = s().addConnector({ x: 0, y: 0 })
    expect(s().doc.connectors.find((c) => c.id === id)!.designator).toBe('X1')
  })

  it('addFreeTerminal / addSplice assign T1, T2 / SP1, SP2 designators', () => {
    resetEmpty()
    s().addFreeTerminal({ x: 0, y: 0 })
    s().addFreeTerminal({ x: 0, y: 0 })
    s().addSplice({ x: 0, y: 0 })
    expect(s().doc.freeTerminals.map((t) => t.designator)).toEqual(['T1', 'T2'])
    expect(s().doc.splices.map((x) => x.designator)).toEqual(['SP1'])
  })

  it('addSpliceFromPart takes the next SP designator', () => {
    resetEmpty()
    s().addSplice({ x: 0, y: 0 })
    const id = s().addSpliceFromPart({ x: 0, y: 0 }, { ...newLibraryPart('splice', 'S1'), splice: { kind: 'weld' } })
    expect(s().doc.splices.find((x) => x.id === id)!.designator).toBe('SP2')
  })

  it('undo frees the designator for reuse', () => {
    resetEmpty()
    s().addFreeTerminal({ x: 0, y: 0 })
    s().addFreeTerminal({ x: 0, y: 0 })
    s().undo()
    const id = s().addFreeTerminal({ x: 0, y: 0 })
    expect(s().doc.freeTerminals.find((t) => t.id === id)!.designator).toBe('T2')
  })

  it('connector numbering is per prefix: X1 + T1 present -> addConnector gives X2', () => {
    resetEmpty()
    s().applyEdit((d) => {
      d.connectors.push({ id: 'c', designator: 'X1', cavities: [] })
      d.freeTerminals.push({ id: 't', designator: 'T1', kind: 'ring' })
    })
    const id = s().addConnector({ x: 0, y: 0 })
    expect(s().doc.connectors.find((c) => c.id === id)!.designator).toBe('X2')
  })

  it('addFreeTerminal creates a ring terminal + placement, undoable', () => {
    const id = s().addFreeTerminal({ x: 10, y: 20 })
    const ft = s().doc.freeTerminals.find((f) => f.id === id)
    expect(ft).toBeDefined()
    expect(ft!.kind).toBe('ring')
    expect(s().doc.placements.find((pp) => pp.refId === id)).toBeDefined()
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(s().doc.freeTerminals).toHaveLength(0)
    expect(s().doc.placements).toHaveLength(0)
  })

  it('addSplice creates a butt splice + placement, undoable', () => {
    const id = s().addSplice({ x: 10, y: 20 })
    const sp = s().doc.splices.find((x) => x.id === id)
    expect(sp).toBeDefined()
    expect(sp!.kind).toBe('butt')
    expect(s().doc.placements.find((pp) => pp.refId === id)).toBeDefined()
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(s().doc.splices).toHaveLength(0)
    expect(s().doc.placements).toHaveLength(0)
  })
})

describe('removeElements (schematic Delete/Backspace)', () => {
  beforeEach(() => reset())

  it('removes a connector, its placement and every wire on any of its cavities, as ONE undo step', () => {
    const conn = s().addConnector({ x: 0, y: 0 })
    const cav = s().doc.connectors.find((c) => c.id === conn)!.cavities[0].id
    const w1 = s().addWire({ type: 'cavity', cavityId: cav }, { type: 'cavity', cavityId: 'x' })
    const w2 = s().addWire({ type: 'cavity', cavityId: cav }, { type: 'cavity', cavityId: 'z' })
    const keep = s().addWire({ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'z' })
    s().applyEdit((d) => {
      d.drawing.blocks = { pinout: { [conn]: { x: 1, y: 1 } }, picture: { [conn]: { x: 2, y: 2 } } }
    })
    const before = s().past.length
    s().removeElements({ bodyIds: [conn], wireIds: [] })
    expect(s().past).toHaveLength(before + 1)
    expect(s().doc.connectors.some((c) => c.id === conn)).toBe(false)
    expect(s().doc.placements.some((p) => p.refId === conn)).toBe(false)
    expect(s().doc.wires.map((w) => w.id)).toEqual([keep])
    expect(s().doc.wireRoutes.some((r) => r.wireId === w1 || r.wireId === w2)).toBe(false)
    // No segment may still reach the removed body.
    const touches = (n: { type: string; refId?: string }): boolean => n.type === 'body' && n.refId === conn
    expect(s().doc.segments.some((sg) => touches(sg.from) || touches(sg.to))).toBe(false)
    expect(s().doc.drawing.blocks?.pinout?.[conn]).toBeUndefined()
    expect(s().doc.drawing.blocks?.picture?.[conn]).toBeUndefined()
    s().undo()
    expect(s().doc.connectors.some((c) => c.id === conn)).toBe(true)
    expect(s().doc.wires).toHaveLength(3)
    expect(s().doc.drawing.blocks?.pinout?.[conn]).toEqual({ x: 1, y: 1 })
  })

  it('removes free terminals and splices with the wires that end on them', () => {
    const ft = s().addFreeTerminal({ x: 0, y: 0 })
    const sp = s().addSplice({ x: 10, y: 0 })
    s().addWire({ type: 'freeTerminal', terminalId: ft }, { type: 'cavity', cavityId: 'x' })
    s().addWire({ type: 'splice', spliceId: sp }, { type: 'cavity', cavityId: 'x' })
    s().addWire({ type: 'splice', spliceId: sp }, { type: 'cavity', cavityId: 'z' })
    s().removeElements({ bodyIds: [ft, sp], wireIds: [] })
    expect(s().doc.freeTerminals).toHaveLength(0)
    expect(s().doc.splices).toHaveLength(0)
    expect(s().doc.wires).toHaveLength(0)
    expect(s().doc.placements.some((p) => p.refId === ft || p.refId === sp)).toBe(false)
  })

  it('a mixed body + wire selection is one undo entry', () => {
    const ft = s().addFreeTerminal({ x: 0, y: 0 })
    s().addWire({ type: 'freeTerminal', terminalId: ft }, { type: 'cavity', cavityId: 'x' })
    const other = s().addWire({ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'z' })
    const before = s().past.length
    s().removeElements({ bodyIds: [ft], wireIds: [other] })
    expect(s().past).toHaveLength(before + 1)
    expect(s().doc.wires).toHaveLength(0)
  })

  it('unknown ids are a no-op with no history entry', () => {
    const before = s().past.length
    s().removeElements({ bodyIds: ['nope'], wireIds: ['nada'] })
    expect(s().past).toHaveLength(before)
  })
})

describe('commitNodePositions (drag commit)', () => {
  beforeEach(() => reset())

  it('a finished drag is ONE undo entry', () => {
    s().commitNodePositions([{ refId: 'c1', pos: { x: 30, y: 30 } }], 'physical')
    expect(s().past).toHaveLength(1)
    expect(s().doc.placements).toEqual([{ refId: 'c1', pos: { x: 30, y: 30 } }])
  })

  it('commits multiple nodes (selection drag) as one entry', () => {
    s().commitNodePositions([
      { refId: 'c1', pos: { x: 10, y: 10 } },
      { refId: 'c2', pos: { x: 20, y: 20 } }
    ], 'physical')
    expect(s().past).toHaveLength(1)
    expect(s().doc.placements).toHaveLength(2)
  })

  it('undo reverts the whole gesture; dirty clears at the saved baseline', () => {
    s().commitNodePositions([{ refId: 'c1', pos: { x: 30, y: 30 } }], 'physical')
    s().undo()
    expect(s().doc.placements).toHaveLength(0)
    expect(s().dirty).toBe(false)
  })

  it('a no-op commit (unchanged position) produces no history entry', () => {
    s().commitNodePositions([{ refId: 'c1', pos: { x: 5, y: 5 } }], 'physical')
    expect(s().past).toHaveLength(1)
    s().commitNodePositions([{ refId: 'c1', pos: { x: 5, y: 5 } }], 'physical') // same pos
    expect(s().past).toHaveLength(1) // unchanged
  })
})

describe('commitNodePositions targets a layout', () => {
  beforeEach(() => reset())

  it("target 'physical' writes Placement.pos (one undo step)", () => {
    s().commitNodePositions([{ refId: 'c1', pos: { x: 30, y: 30 } }], 'physical')
    expect(s().past).toHaveLength(1)
    const p = s().doc.placements.find((pp) => pp.refId === 'c1')!
    expect(p.pos).toEqual({ x: 30, y: 30 })
    expect(p.schematicPos).toBeUndefined()
  })

  it("target 'schematic' writes Placement.schematicPos, leaving pos alone", () => {
    s().applyEdit((d) => d.placements.push({ refId: 'c1', pos: { x: 5, y: 5 } }))
    s().commitNodePositions([{ refId: 'c1', pos: { x: 70, y: 80 } }], 'schematic')
    const p = s().doc.placements.find((pp) => pp.refId === 'c1')!
    expect(p.pos).toEqual({ x: 5, y: 5 }) // physical untouched
    expect(p.schematicPos).toEqual({ x: 70, y: 80 })
  })

  it("the two layouts are independent (physical move doesn't change schematicPos)", () => {
    s().applyEdit((d) => d.placements.push({ refId: 'c1', pos: { x: 5, y: 5 }, schematicPos: { x: 9, y: 9 } }))
    s().commitNodePositions([{ refId: 'c1', pos: { x: 50, y: 50 } }], 'physical')
    const p = s().doc.placements.find((pp) => pp.refId === 'c1')!
    expect(p.pos).toEqual({ x: 50, y: 50 })
    expect(p.schematicPos).toEqual({ x: 9, y: 9 })
  })

  it('a physical move does not drag the schematic along when schematicPos was never set', () => {
    // The schematic draws `schematicPos ?? pos`, so without a freeze a formboard
    // drag of a body never dragged in the schematic would move it there too.
    s().applyEdit((d) => d.placements.push({ refId: 'c1', pos: { x: 5, y: 5 } }))
    s().commitNodePositions([{ refId: 'c1', pos: { x: 50, y: 50 } }], 'physical')
    const p = s().doc.placements.find((pp) => pp.refId === 'c1')!
    expect(p.pos).toEqual({ x: 50, y: 50 })
    expect(p.schematicPos ?? p.pos).toEqual({ x: 5, y: 5 })
    s().undo()
    const q = s().doc.placements.find((pp) => pp.refId === 'c1')!
    expect(q.pos).toEqual({ x: 5, y: 5 })
    expect(q.schematicPos).toBeUndefined()
  })

  it("target 'physical' still moves branch points by reference", () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const bp = s().insertBranchPoint(s().doc.segments[0].id, { x: 10, y: 10 })!
    s().commitNodePositions([{ refId: bp, pos: { x: 99, y: 88 } }], 'physical')
    expect(s().doc.branchPoints.find((b) => b.id === bp)!.pos).toEqual({ x: 99, y: 88 })
  })
})

describe('routing: auto-route + insert branch point', () => {
  beforeEach(() => reset())

  it('addWire auto-creates a direct segment and a single-segment route', () => {
    const id = s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    expect(s().doc.segments).toHaveLength(1)
    const route = s().doc.wireRoutes.find((r) => r.wireId === id)
    expect(route?.path).toEqual([s().doc.segments[0].id])
  })

  it('addWire routes body to body, so the segment names the two connectors', () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const seg = s().doc.segments[0]
    expect(seg.from).toEqual({ type: 'body', refId: 'a' })
    expect(seg.to).toEqual({ type: 'body', refId: 'b' })
  })

  it('a jumper between two cavities of ONE body gets no segment and no route', () => {
    s().applyEdit((d) =>
      d.connectors.push({
        id: 'jump',
        designator: 'J1',
        cavities: [
          { id: 'j1', position: '1', status: 'populated' },
          { id: 'j2', position: '2', status: 'populated' }
        ]
      })
    )
    const id = s().addWire({ type: 'cavity', cavityId: 'j1' }, { type: 'cavity', cavityId: 'j2' })
    expect(s().doc.wires.find((w) => w.id === id)).toBeDefined()
    expect(s().doc.segments).toHaveLength(0)
    expect(s().doc.wireRoutes).toHaveLength(0)
  })

  it('insertBranchPoint splits the wire segment and is one undo step', () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const segId = s().doc.segments[0].id
    const before = s().past.length
    s().insertBranchPoint(segId, { x: 10, y: 10 })
    expect(s().doc.branchPoints).toHaveLength(1)
    expect(s().doc.segments).toHaveLength(2)
    expect(s().doc.wireRoutes[0].path).toHaveLength(2)
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(s().doc.branchPoints).toHaveLength(0)
    expect(s().doc.segments).toHaveLength(1)
  })

  it('commitNodePositions moves a branch point by reference', () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const bp = s().insertBranchPoint(s().doc.segments[0].id, { x: 10, y: 10 })!
    s().commitNodePositions([{ refId: bp, pos: { x: 99, y: 88 } }], 'physical')
    expect(s().doc.branchPoints.find((b) => b.id === bp)!.pos).toEqual({ x: 99, y: 88 })
  })
})

describe('C1: one limb = ONE segment (addWire reuses the body↔body segment)', () => {
  beforeEach(() => reset())

  const cav = (cavityId: string) => ({ type: 'cavity', cavityId }) as const

  /** X1 and X2, two populated cavities each, placed 100 mm apart. */
  function twoConnectors(): void {
    s().applyEdit((d) => {
      d.connectors.push(
        {
          id: 'X1',
          designator: 'X1',
          cavities: [
            { id: 'x1a', position: '1', status: 'populated' },
            { id: 'x1b', position: '2', status: 'populated' }
          ]
        },
        {
          id: 'X2',
          designator: 'X2',
          cavities: [
            { id: 'x2a', position: '1', status: 'populated' },
            { id: 'x2b', position: '2', status: 'populated' }
          ]
        }
      )
      d.placements.push(
        { refId: 'X1', pos: { x: 0, y: 0 } },
        { refId: 'X2', pos: { x: 100, y: 0 } }
      )
    })
  }

  it('a second wire between the same two bodies routes through the SAME segment', () => {
    twoConnectors()
    const w1 = s().addWire(cav('x1a'), cav('x2a'))
    const w2 = s().addWire(cav('x1b'), cav('x2b'))
    const doc = s().doc
    // Was 2 before the fix: two coincident lines, two stacked length labels.
    expect(doc.segments).toHaveLength(1)
    const segId = doc.segments[0].id
    expect(doc.wireRoutes.find((r) => r.wireId === w1)!.path).toEqual([segId])
    expect(doc.wireRoutes.find((r) => r.wireId === w2)!.path).toEqual([segId])
    expect(routeConnected(doc, w1)).toBe(true)
    expect(routeConnected(doc, w2)).toBe(true)
  })

  it('reuses the segment whichever way round the second wire is drawn', () => {
    twoConnectors()
    s().addWire(cav('x1a'), cav('x2a'))
    const w2 = s().addWire(cav('x2b'), cav('x1b')) // X2 → X1, the pair reversed
    expect(s().doc.segments).toHaveLength(1)
    expect(routeConnected(s().doc, w2)).toBe(true)
  })

  it('the shared limb becomes a bundle holding both wires', () => {
    twoConnectors()
    const w1 = s().addWire(cav('x1a'), cav('x2a'))
    const w2 = s().addWire(cav('x1b'), cav('x2b'))
    const doc = s().doc
    expect(doc.bundles).toHaveLength(1)
    expect(doc.bundles[0].segmentIds).toEqual([doc.segments[0].id])
    expect([...doc.bundles[0].memberWireIds].sort()).toEqual([w1, w2].sort())
  })

  it('removing ONE wire keeps the segment; removing the last one GCs it', () => {
    twoConnectors()
    const w1 = s().addWire(cav('x1a'), cav('x2a'))
    const w2 = s().addWire(cav('x1b'), cav('x2b'))
    const segId = s().doc.segments[0].id
    s().removeWire(w1)
    expect(s().doc.segments.map((x) => x.id)).toEqual([segId]) // w2 still rides it
    expect(s().doc.bundles).toHaveLength(0) // one wire is not a bundle any more
    expect(routeConnected(s().doc, w2)).toBe(true)
    s().removeWire(w2)
    expect(s().doc.segments).toHaveLength(0)
  })

  it('insertBranchPoint on the shared limb splits it for BOTH wires', () => {
    twoConnectors()
    const w1 = s().addWire(cav('x1a'), cav('x2a'))
    const w2 = s().addWire(cav('x1b'), cav('x2b'))
    s().insertBranchPoint(s().doc.segments[0].id, { x: 50, y: 20 })
    const doc = s().doc
    expect(doc.segments).toHaveLength(2)
    for (const w of [w1, w2]) {
      expect(doc.wireRoutes.find((r) => r.wireId === w)!.path).toHaveLength(2)
      expect(routeConnected(doc, w)).toBe(true)
    }
  })

  it('a wire to a DIFFERENT body still gets its own segment', () => {
    twoConnectors()
    s().addWire(cav('x1a'), cav('x2a'))
    s().addWire(cav('x1b'), cav('c')) // 'c' is a fixture connector, not X2
    expect(s().doc.segments).toHaveLength(2)
  })
})

describe('UI-1: removeWire segment garbage collection', () => {
  beforeEach(() => reset())

  it('addWire then removeWire leaves doc.segments empty', () => {
    // addWire auto-creates a segment; removeWire must garbage-collect it
    const id = s().addWire(
      { type: 'cavity', cavityId: 'x' },
      { type: 'cavity', cavityId: 'y' }
    )
    expect(s().doc.segments).toHaveLength(1)
    s().removeWire(id)
    expect(s().doc.segments).toHaveLength(0)
  })

  it('a segment still referenced by another route is NOT removed', () => {
    // Add two wires sharing the same segment via a bundle route (contrived but valid)
    const id1 = s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const segId = s().doc.segments[0].id
    // Manually push a second route that also references the same segment
    s().applyEdit((d) => {
      d.wireRoutes.push({ wireId: 'w-other', path: [segId] })
    })
    // Also push a wire with that id so removeWire is coherent
    s().applyEdit((d) => {
      d.wires.push({
        id: 'w-other',
        ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' }],
        gauge: { value: 0.5, unit: 'mm2' },
        color: { base: 'GY' }
      })
    })
    // Remove the first wire — its route is gone but segId is still referenced by w-other
    s().removeWire(id1)
    expect(s().doc.segments.some((seg) => seg.id === segId)).toBe(true)
  })

  it('removeWire undo restores both the wire and its segment', () => {
    const id = s().addWire(
      { type: 'cavity', cavityId: 'x' },
      { type: 'cavity', cavityId: 'y' }
    )
    s().removeWire(id)
    expect(s().doc.segments).toHaveLength(0)
    s().undo() // undo the removeWire
    expect(s().doc.wires).toHaveLength(1)
    expect(s().doc.segments).toHaveLength(1)
  })
})

describe('removeWire prunes orphan treatments/labels', () => {
  beforeEach(() => reset())

  it('drops sleeving/label targeting the wire, removes it from twists, as one undo step', () => {
    const w1 = s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const w2 = s().addWire({ type: 'cavity', cavityId: 'c' }, { type: 'cavity', cavityId: 'd' })
    const w3 = s().addWire({ type: 'cavity', cavityId: 'e' }, { type: 'cavity', cavityId: 'f' })
    const segW1 = s().doc.wireRoutes.find((r) => r.wireId === w1)!.path
    s().addSleeving({ type: 'wire', wireId: w1 }, segW1)
    s().addLabel({ type: 'wire', wireId: w1 }, 'wireMarker', 'M', { x: 0, y: 0 })
    const twPair = s().addTwist([w1, w2], []) // 2 members → dropped when w1 goes
    const twTriple = s().addTwist([w1, w2, w3], []) // 3 members → survives without w1

    s().removeWire(w1)

    expect(s().doc.sleeving).toHaveLength(0)
    expect(s().doc.labels).toHaveLength(0)
    expect(s().doc.twists.map((t) => t.id)).toEqual([twTriple])
    expect(s().doc.twists[0].wireIds).toEqual([w2, w3])
    expect(twPair).not.toBe(twTriple)

    s().undo() // single undo restores every pruned annotation
    expect(s().doc.sleeving).toHaveLength(1)
    expect(s().doc.labels).toHaveLength(1)
    expect(s().doc.twists).toHaveLength(2)
  })
})

describe('treatments and labels', () => {
  beforeEach(() => reset())

  it('addSleeving pushes a Sleeving entity, is one undo step, returns a usable id, undo removes it', () => {
    const target = { type: 'bundle' as const, bundleId: 'b1' }
    addChain(['seg1'])
    const beforePast = s().past.length
    const id = s().addSleeving(target, ['seg1'])
    expect(id).toBeTruthy()
    expect(s().doc.sleeving).toHaveLength(1)
    expect(s().doc.sleeving[0].id).toBe(id)
    expect(s().doc.sleeving[0].target).toEqual(target)
    expect(s().doc.sleeving[0].sleevingType).toBe('braided')
    expect(s().doc.sleeving[0].span.segmentIds).toEqual(['seg1'])
    expect(s().past.length).toBe(beforePast + 1)
    s().undo()
    expect(s().doc.sleeving).toHaveLength(0)
  })

  it('addSleeving accepts an explicit sleevingType', () => {
    addChain(['seg2'])
    const id = s().addSleeving({ type: 'wire', wireId: 'w1' }, ['seg2'], 'heatshrink')
    expect(s().doc.sleeving[0].sleevingType).toBe('heatshrink')
    expect(id).toBeTruthy()
  })

  it('addTwist pushes a Twist entity, is one undo step, returns a usable id, undo removes it', () => {
    const wireIds = ['w1', 'w2']
    const segmentIds = ['seg1', 'seg2']
    addChain(segmentIds)
    const beforePast = s().past.length
    const id = s().addTwist(wireIds, segmentIds)
    expect(id).toBeTruthy()
    expect(s().doc.twists).toHaveLength(1)
    expect(s().doc.twists[0].id).toBe(id)
    expect(s().doc.twists[0].wireIds).toEqual(wireIds)
    expect(s().doc.twists[0].span.segmentIds).toEqual(segmentIds)
    expect(s().past.length).toBe(beforePast + 1)
    s().undo()
    expect(s().doc.twists).toHaveLength(0)
  })

  it('addLabel pushes a Label entity, is one undo step, returns a usable id, undo removes it', () => {
    const target = { type: 'wire' as const, wireId: 'w1' }
    const pos = { x: 10, y: 20 }
    const beforePast = s().past.length
    const id = s().addLabel(target, 'callout', 'Test label', pos)
    expect(id).toBeTruthy()
    expect(s().doc.labels).toHaveLength(1)
    expect(s().doc.labels[0].id).toBe(id)
    expect(s().doc.labels[0].target).toEqual(target)
    expect(s().doc.labels[0].kind).toBe('callout')
    expect(s().doc.labels[0].text).toBe('Test label')
    expect(s().doc.labels[0].pos).toEqual(pos)
    expect(s().past.length).toBe(beforePast + 1)
    s().undo()
    expect(s().doc.labels).toHaveLength(0)
  })
})

describe('routing: removeBranchPoint store action', () => {
  beforeEach(() => reset())

  it('insert then remove via store is undoable: undo brings back the branch + 2 segments', () => {
    // Add a wire (creates 1 segment)
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const segId = s().doc.segments[0].id
    // Insert a branch point → 2 segments, 1 branch
    const bpId = s().insertBranchPoint(segId, { x: 10, y: 10 })!
    expect(s().doc.branchPoints).toHaveLength(1)
    expect(s().doc.segments).toHaveLength(2)
    const pastBeforeRemove = s().past.length

    // Remove the branch point → 1 merged segment, 0 branch points
    const removed = s().removeBranchPoint(bpId)
    expect(removed).toBe(true)
    expect(s().doc.branchPoints).toHaveLength(0)
    expect(s().doc.segments).toHaveLength(1)
    expect(s().past.length).toBe(pastBeforeRemove + 1)

    // Undo removeBranchPoint → branch + 2 segments restored
    s().undo()
    expect(s().doc.branchPoints).toHaveLength(1)
    expect(s().doc.branchPoints[0].id).toBe(bpId)
    expect(s().doc.segments).toHaveLength(2)
  })

  it('removeBranchPoint on a degree-3 branch returns false and adds no history entry', () => {
    // Manually set up a degree-3 branch in the store doc
    s().applyEdit((d) => {
      d.branchPoints.push({ id: 'bp3', pos: { x: 5, y: 0 } })
      d.segments.push(
        { id: 'sA', from: { type: 'body', refId: 'cA' }, to: { type: 'branch', branchId: 'bp3' } },
        { id: 'sB', from: { type: 'branch', branchId: 'bp3' }, to: { type: 'body', refId: 'cB' } },
        { id: 'sC', from: { type: 'branch', branchId: 'bp3' }, to: { type: 'body', refId: 'cC' } }
      )
    })
    const pastBefore = s().past.length
    const removed = s().removeBranchPoint('bp3')
    expect(removed).toBe(false)
    // No history entry was added
    expect(s().past.length).toBe(pastBefore)
    // Doc unchanged
    expect(s().doc.branchPoints).toHaveLength(1)
    expect(s().doc.segments.filter((sg) => sg.id === 'sA' || sg.id === 'sB' || sg.id === 'sC')).toHaveLength(3)
  })

  it('removeBranchPoint refuses a bend whose limb is a SELF-LOOP (no history, no dangle)', () => {
    s().applyEdit((d) => {
      d.branchPoints.push({ id: 'bpL', pos: { x: 5, y: 0 } })
      d.segments.push(
        { id: 'sLoop', from: { type: 'branch', branchId: 'bpL' }, to: { type: 'branch', branchId: 'bpL' } },
        { id: 'sReal', from: { type: 'branch', branchId: 'bpL' }, to: { type: 'body', refId: 'cA' } }
      )
    })
    const pastBefore = s().past.length
    expect(s().removeBranchPoint('bpL')).toBe(false)
    expect(s().past.length).toBe(pastBefore)
    expect(s().doc.branchPoints.some((b) => b.id === 'bpL')).toBe(true)
    expect(s().doc.segments.map((x) => x.id)).toContain('sLoop')
    expect(s().doc.segments.map((x) => x.id)).toContain('sReal')
  })

  it('route path becomes a single merged segment id after remove', () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const segId = s().doc.segments[0].id
    const bpId = s().insertBranchPoint(segId, { x: 10, y: 10 })!
    // Route now has 2 segments
    expect(s().doc.wireRoutes[0].path).toHaveLength(2)
    s().removeBranchPoint(bpId)
    // Route collapsed to 1 merged segment
    expect(s().doc.wireRoutes[0].path).toHaveLength(1)
  })
})

describe('routing: mergeBranchPoints store action', () => {
  beforeEach(() => reset())

  it('fuses two branch points into one shared bundle limb (one undo step, undoable)', () => {
    // w1: a1→P→R→b1 ; w2: a2→P→S→b2 — share the start node P, separate downstream
    // branches R / S. Merging S into R coalesces the parallel P→R limbs into one.
    s().applyEdit((d) => {
      d.wires.push(
        { id: 'w1', ends: [{ type: 'cavity', cavityId: 'a1' }, { type: 'cavity', cavityId: 'b1' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } },
        { id: 'w2', ends: [{ type: 'cavity', cavityId: 'a2' }, { type: 'cavity', cavityId: 'b2' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } }
      )
      d.branchPoints.push(
        { id: 'P', pos: { x: 40, y: 0 } },
        { id: 'R', pos: { x: 80, y: 0 } },
        { id: 'S', pos: { x: 80, y: 4 } }
      )
      d.segments.push(
        { id: 'a1P', from: { type: 'body', refId: 'a1' }, to: { type: 'branch', branchId: 'P' } },
        { id: 'sPR', from: { type: 'branch', branchId: 'P' }, to: { type: 'branch', branchId: 'R' } },
        { id: 'Rb1', from: { type: 'branch', branchId: 'R' }, to: { type: 'body', refId: 'b1' } },
        { id: 'a2P', from: { type: 'body', refId: 'a2' }, to: { type: 'branch', branchId: 'P' } },
        { id: 'sPS', from: { type: 'branch', branchId: 'P' }, to: { type: 'branch', branchId: 'S' } },
        { id: 'Sb2', from: { type: 'branch', branchId: 'S' }, to: { type: 'body', refId: 'b2' } }
      )
      d.wireRoutes.push(
        { wireId: 'w1', path: ['a1P', 'sPR', 'Rb1'] },
        { wireId: 'w2', path: ['a2P', 'sPS', 'Sb2'] }
      )
    })
    const pastBefore = s().past.length
    const merged = s().mergeBranchPoints('S', 'R')
    expect(merged).toBe(true)
    expect(s().past.length).toBe(pastBefore + 1)
    expect(s().doc.branchPoints.map((b) => b.id).sort()).toEqual(['P', 'R'])
    expect(s().doc.segments.some((sg) => sg.id === 'sPS')).toBe(false)
    expect(s().doc.bundles).toHaveLength(1)
    expect(s().doc.bundles[0].segmentIds).toEqual(['sPR'])
    expect([...s().doc.bundles[0].memberWireIds].sort()).toEqual(['w1', 'w2'])

    // One undo restores the pre-merge topology: S returns, sPS returns, no bundle.
    s().undo()
    expect(s().doc.branchPoints.map((b) => b.id).sort()).toEqual(['P', 'R', 'S'])
    expect(s().doc.segments.some((sg) => sg.id === 'sPS')).toBe(true)
    expect(s().doc.bundles).toHaveLength(0)
  })

  it('is a no-op (returns false, no history entry) for an identical or missing branch point', () => {
    s().applyEdit((d) => {
      d.branchPoints.push({ id: 'P', pos: { x: 0, y: 0 } }, { id: 'R', pos: { x: 10, y: 0 } })
    })
    const pastBefore = s().past.length
    expect(s().mergeBranchPoints('P', 'P')).toBe(false)
    expect(s().mergeBranchPoints('ghost', 'P')).toBe(false)
    expect(s().past.length).toBe(pastBefore)
  })
})

describe('removeWire prunes a dangling bundle-targeted sleeving', () => {
  beforeEach(() => reset())

  /** N wires all routed through one shared segment `sh`, plus a Bundle `bnd`
   *  over it and a sleeving targeting that bundle. */
  function bundledWithSleeving(memberWireIds: string[]): void {
    s().applyEdit((d) => {
      d.branchPoints.push({ id: 'P', pos: { x: 0, y: 0 } }, { id: 'Q', pos: { x: 50, y: 0 } })
      d.segments.push({ id: 'sh', from: { type: 'branch', branchId: 'P' }, to: { type: 'branch', branchId: 'Q' } })
      let i = 0
      for (const w of memberWireIds) {
        d.wires.push({ id: w, ends: [{ type: 'cavity', cavityId: `a${i}` }, { type: 'cavity', cavityId: `b${i}` }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } })
        d.wireRoutes.push({ wireId: w, path: ['sh'] })
        i++
      }
      d.bundles.push({ id: 'bnd', segmentIds: ['sh'], memberWireIds: [...memberWireIds] })
      d.sleeving.push({ id: 'slv', target: { type: 'bundle', bundleId: 'bnd' }, span: { segmentIds: ['sh'] }, sleevingType: 'braided' })
    })
  }

  it('removing a member that dissolves the bundle (drops to one wire) prunes the sleeving, undoable', () => {
    bundledWithSleeving(['w1', 'w2'])
    expect(s().doc.sleeving).toHaveLength(1)
    s().removeWire('w1')
    expect(s().doc.bundles).toHaveLength(0)
    expect(s().doc.sleeving).toHaveLength(0) // bundle gone → phantom sleeving pruned
    s().undo()
    expect(s().doc.sleeving).toHaveLength(1)
  })

  it('removing a member that leaves the bundle intact (≥2 wires) keeps the sleeving', () => {
    bundledWithSleeving(['w1', 'w2', 'w3'])
    s().removeWire('w1')
    expect(s().doc.bundles).toHaveLength(1) // still 2 members → still a bundle
    expect(s().doc.bundles[0].id).toBe('bnd') // id preserved by overlap
    expect(s().doc.sleeving).toHaveLength(1)
  })
})

describe('reconnectWire (drag a wire end to another endpoint)', () => {
  beforeEach(() => reset())

  /** w1 a1→P→sPR→R→b1 and w2 a2→P→sPR→R→b2, bundled over sPR; w1 is red 1.5 mm². */
  function bundled(): void {
    s().applyEdit((d) => {
      d.branchPoints.push({ id: 'P', pos: { x: 40, y: 0 } }, { id: 'R', pos: { x: 80, y: 0 } })
      d.segments.push({ id: 'sPR', from: { type: 'branch', branchId: 'P' }, to: { type: 'branch', branchId: 'R' } })
      for (const [w, a, b] of [['w1', 'a1', 'b1'], ['w2', 'a2', 'b2']]) {
        d.wires.push({ id: w, ends: [{ type: 'cavity', cavityId: a }, { type: 'cavity', cavityId: b }], gauge: { value: 1.5, unit: 'mm2' }, color: { base: 'RD' } })
        d.segments.push(
          { id: `${a}P`, from: { type: 'body', refId: a }, to: { type: 'branch', branchId: 'P' } },
          { id: `R${b}`, from: { type: 'branch', branchId: 'R' }, to: { type: 'body', refId: b } }
        )
        d.wireRoutes.push({ wireId: w, path: [`${a}P`, 'sPR', `R${b}`] })
      }
      d.bundles.push({ id: 'bnd', segmentIds: ['sPR'], memberWireIds: ['w1', 'w2'] })
      // A second cavity on b1's connector, for a move that stays on one body.
      d.connectors.find((c) => c.id === 'b1')!.cavities.push({ id: 'b1-2', position: '2', status: 'populated' })
    })
  }
  const route = (w: string) => s().doc.wireRoutes.find((r) => r.wireId === w)?.path
  const w1 = () => s().doc.wires.find((w) => w.id === 'w1')!

  it('to another cavity of the same connector: only the end changes, the route stays, one undo step', () => {
    bundled()
    const before = s().past.length
    const routeBefore = route('w1')
    expect(s().reconnectWire('w1', 1, { type: 'cavity', cavityId: 'b1-2' })).toBe(true)
    expect(w1().ends[1]).toEqual({ type: 'cavity', cavityId: 'b1-2' })
    expect(w1().color).toEqual({ base: 'RD' })
    expect(w1().gauge).toEqual({ value: 1.5, unit: 'mm2' })
    expect(route('w1')).toEqual(routeBefore)
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(w1().ends[1]).toEqual({ type: 'cavity', cavityId: 'b1' })
  })

  it('to another connector: only the last leg changes, so the wire stays in its bundle', () => {
    bundled()
    expect(s().reconnectWire('w1', 1, { type: 'cavity', cavityId: 'c' })).toBe(true)
    const path = route('w1')!
    expect(path.slice(0, 2)).toEqual(['a1P', 'sPR'])
    const leg = s().doc.segments.find((g) => g.id === path[2])!
    expect([leg.from, leg.to]).toEqual([{ type: 'branch', branchId: 'R' }, { type: 'body', refId: 'c' }])
    // The bundle still carries both wires; the old leg into b1 had no other wire and is gone.
    expect(s().doc.bundles.map((b) => [...b.memberWireIds].sort())).toEqual([['w1', 'w2']])
    expect(s().doc.segments.some((g) => g.id === 'Rb1')).toBe(false)
    expect(routeConnected(s().doc, 'w1')).toBe(true)
    s().undo()
    expect(route('w1')).toEqual(['a1P', 'sPR', 'Rb1'])
  })

  it('moving the first end works the same way', () => {
    bundled()
    expect(s().reconnectWire('w1', 0, { type: 'cavity', cavityId: 'c' })).toBe(true)
    const path = route('w1')!
    expect(path.slice(1)).toEqual(['sPR', 'Rb1'])
    const leg = s().doc.segments.find((g) => g.id === path[0])!
    expect([leg.from, leg.to]).toContainEqual({ type: 'body', refId: 'c' })
    expect([leg.from, leg.to]).toContainEqual({ type: 'branch', branchId: 'P' })
  })

  it("a label on the wire's old leg is re-anchored onto its new route", () => {
    bundled()
    s().applyEdit((d) => {
      d.labels.push({ id: 'L', target: { type: 'wire', wireId: 'w1' }, kind: 'wireMarker', text: 'M', pos: { x: 0, y: 0 }, anchor: { segmentId: 'Rb1', fraction: 0.5 } })
    })
    s().reconnectWire('w1', 1, { type: 'cavity', cavityId: 'c' })
    const label = s().doc.labels.find((l) => l.id === 'L')!
    expect(route('w1')).toContain(label.anchor!.segmentId)
  })

  it('both ends on one body afterwards: no route, as for a jumper, and the bundle dissolves', () => {
    bundled()
    s().applyEdit((d) => {
      d.connectors.find((c) => c.id === 'a1')!.cavities.push({ id: 'a1-2', position: '2', status: 'populated' })
    })
    expect(s().reconnectWire('w1', 1, { type: 'cavity', cavityId: 'a1-2' })).toBe(true)
    expect(route('w1')).toBeUndefined()
    expect(s().doc.bundles).toHaveLength(0)
  })

  it('a wire without a route gets the direct one', () => {
    const w = s().addWire({ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'y' })
    s().applyEdit((d) => {
      d.wireRoutes = d.wireRoutes.filter((r) => r.wireId !== w)
    })
    expect(s().reconnectWire(w, 1, { type: 'cavity', cavityId: 'z' })).toBe(true)
    const path = route(w)!
    expect(path).toHaveLength(1)
    const seg = s().doc.segments.find((g) => g.id === path[0])!
    expect([seg.from, seg.to]).toEqual([{ type: 'body', refId: 'x' }, { type: 'body', refId: 'z' }])
  })

  it('refuses, with no history entry, the same end, the other end, a missing target or a shield', () => {
    bundled()
    const before = s().past.length
    expect(s().reconnectWire('w1', 1, { type: 'cavity', cavityId: 'b1' })).toBe(false)
    expect(s().reconnectWire('w1', 1, { type: 'cavity', cavityId: 'a1' })).toBe(false)
    expect(s().reconnectWire('w1', 1, { type: 'cavity', cavityId: 'nope' })).toBe(false)
    expect(s().reconnectWire('w1', 1, { type: 'shield', cableId: 'cab', end: 'a' })).toBe(false)
    expect(s().reconnectWire('nope', 1, { type: 'cavity', cavityId: 'c' })).toBe(false)
    expect(s().past.length).toBe(before)
    expect(w1().ends[1]).toEqual({ type: 'cavity', cavityId: 'b1' })
  })
})

describe('disconnectWireAtBranch store action', () => {
  beforeEach(() => reset())

  /** w1,w2 routed a_i→P→sPR→R→b_i, a Bundle over sPR, and a bundle sleeve+label. */
  function bundleWithTreatments(): void {
    s().applyEdit((d) => {
      d.branchPoints.push({ id: 'P', pos: { x: 40, y: 0 } }, { id: 'R', pos: { x: 80, y: 0 } })
      d.segments.push({ id: 'sPR', from: { type: 'branch', branchId: 'P' }, to: { type: 'branch', branchId: 'R' } })
      for (const [w, a, b] of [['w1', 'a1', 'b1'], ['w2', 'a2', 'b2']]) {
        d.wires.push({ id: w, ends: [{ type: 'cavity', cavityId: a }, { type: 'cavity', cavityId: b }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } })
        d.segments.push(
          { id: `${a}P`, from: { type: 'body', refId: a }, to: { type: 'branch', branchId: 'P' } },
          { id: `R${b}`, from: { type: 'branch', branchId: 'R' }, to: { type: 'body', refId: b } }
        )
        d.wireRoutes.push({ wireId: w, path: [`${a}P`, 'sPR', `R${b}`] })
      }
      d.bundles.push({ id: 'bnd', segmentIds: ['sPR'], memberWireIds: ['w1', 'w2'] })
      d.sleeving.push({ id: 'slv', target: { type: 'bundle', bundleId: 'bnd' }, span: { segmentIds: ['sPR'] }, sleevingType: 'braided' })
      d.labels.push({ id: 'lab', target: { type: 'bundle', bundleId: 'bnd' }, kind: 'flag', text: 'B', pos: { x: 0, y: 0 } })
    })
  }

  it('disconnecting the last-but-one wire at P dissolves the bundle + its sleeve/label, undoable', () => {
    bundleWithTreatments()
    const pastBefore = s().past.length
    expect(s().disconnectWireAtBranch('w1', 'P')).toBe(true)
    expect(s().past.length).toBe(pastBefore + 1)
    expect(s().doc.bundles).toHaveLength(0)
    expect(s().doc.sleeving).toHaveLength(0)
    expect(s().doc.labels).toHaveLength(0)
    // w1 bypassed P only (a1→R), keeping its R→b1 limb — not a full direct route.
    expect(s().doc.wireRoutes.find((r) => r.wireId === 'w1')!.path).toHaveLength(2)
    s().undo()
    expect(s().doc.bundles).toHaveLength(1)
    expect(s().doc.sleeving).toHaveLength(1)
    expect(s().doc.labels).toHaveLength(1)
  })

  it('is a no-op (returns false, no history) for a wire that has no such branch point', () => {
    const w = s().addWire({ type: 'cavity', cavityId: 'x' }, { type: 'cavity', cavityId: 'y' })
    const pastBefore = s().past.length
    expect(s().disconnectWireAtBranch(w, 'nope')).toBe(false)
    expect(s().past.length).toBe(pastBefore)
  })
})

describe('commitNodePositions schematic decoupling', () => {
  beforeEach(() => reset())

  it('schematic drag at same coords as physical pos still persists schematicPos (decoupling fix)', () => {
    // Placement has only physical pos — no schematicPos yet.
    s().applyEdit((d) => d.placements.push({ refId: 'c1', pos: { x: 70, y: 80 } }))
    // Drag ends at (70,80) — same as pos. Old code would treat this as a no-op.
    s().commitNodePositions([{ refId: 'c1', pos: { x: 70, y: 80 } }], 'schematic')
    const p = s().doc.placements.find((pp) => pp.refId === 'c1')!
    // schematicPos must now be set (decoupled from physical), NOT left undefined.
    expect(p.schematicPos).toEqual({ x: 70, y: 80 })
    // physical pos must be untouched
    expect(p.pos).toEqual({ x: 70, y: 80 })
  })
})

describe('setPinOrderReversed (schematic flip)', () => {
  beforeEach(() => reset())

  it('sets and clears the flag, one undo step each, and leaves the electrical model alone', () => {
    const id = s().addConnector({ x: 0, y: 0 })
    const before = s().doc.connectors.find((c) => c.id === id)
    const past = s().past.length
    s().setPinOrderReversed(id, true)
    expect(s().doc.placements.find((p) => p.refId === id)!.schematicPinOrderReversed).toBe(true)
    expect(s().past.length).toBe(past + 1)
    expect(s().doc.connectors.find((c) => c.id === id)).toEqual(before)
    s().setPinOrderReversed(id, false)
    // Absent IS normal order — clearing removes the key rather than storing false.
    expect('schematicPinOrderReversed' in s().doc.placements.find((p) => p.refId === id)!).toBe(false)
    s().undo()
    expect(s().doc.placements.find((p) => p.refId === id)!.schematicPinOrderReversed).toBe(true)
  })

  it('is a no-op with no history entry when nothing changes', () => {
    const id = s().addConnector({ x: 0, y: 0 })
    const past = s().past.length
    s().setPinOrderReversed(id, false)
    expect(s().past.length).toBe(past)
  })
})

describe('setExitSide (schematic pin exit side)', () => {
  beforeEach(() => reset())

  it('sets the schematicExitSide on an existing placement, is one undo step', () => {
    const id = s().addConnector({ x: 0, y: 0 })
    // Default: no explicit schematicExitSide (defaults to 'right' when projected)
    const beforePast = s().past.length
    s().setExitSide(id, 'left')
    expect(s().doc.placements.find((p) => p.refId === id)!.schematicExitSide).toBe('left')
    expect(s().past.length).toBe(beforePast + 1)
  })

  it('undo reverts the schematicExitSide change', () => {
    const id = s().addConnector({ x: 0, y: 0 })
    s().setExitSide(id, 'top')
    expect(s().doc.placements.find((p) => p.refId === id)!.schematicExitSide).toBe('top')
    s().undo()
    // After undo the side is gone (connector was just added, no prior side)
    expect(s().doc.placements.find((p) => p.refId === id)!.schematicExitSide).toBeUndefined()
  })

  it('creates a placement defensively if none exists', () => {
    // Directly push a connector with no placement
    s().applyEdit((d) => {
      d.connectors.push({ id: 'orphan', designator: 'X99', cavities: [] })
    })
    expect(s().doc.placements.find((p) => p.refId === 'orphan')).toBeUndefined()
    s().setExitSide('orphan', 'bottom')
    const p = s().doc.placements.find((pp) => pp.refId === 'orphan')
    expect(p).toBeDefined()
    expect(p!.schematicExitSide).toBe('bottom')
    expect(p!.pos).toEqual({ x: 0, y: 0 })
  })
})

describe('remove treatment actions', () => {
  beforeEach(() => reset())

  it('removeSleeving deletes the entity and is one undo step', () => {
    addChain(['s1'])
    const id = s().addSleeving({ type: 'wire', wireId: 'w1' }, ['s1'])
    expect(s().doc.sleeving).toHaveLength(1)
    const before = s().past.length
    s().removeSleeving(id!)
    expect(s().doc.sleeving).toHaveLength(0)
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(s().doc.sleeving).toHaveLength(1)
  })

  it('removeTwist / removeLabel delete their entity', () => {
    addChain(['s1'])
    const t = s().addTwist(['w1', 'w2'], ['s1'])
    const l = s().addLabel({ type: 'wire', wireId: 'w1' }, 'wireMarker', 'A', { x: 0, y: 0 })
    s().removeTwist(t!)
    s().removeLabel(l)
    expect(s().doc.twists).toHaveLength(0)
    expect(s().doc.labels).toHaveLength(0)
  })

  it('removing a missing id is a no-op with NO history entry', () => {
    const before = s().past.length
    s().removeSleeving('nope')
    s().removeTwist('nope')
    s().removeLabel('nope')
    expect(s().past.length).toBe(before)
  })
})

describe('addTwist permits an empty span (twisted-pair declaration before routing)', () => {
  beforeEach(() => reset())

  it('creates a twist with the given wires and an empty span, undoable', () => {
    const id = s().addTwist(['w1', 'w2'], [])
    const tw = s().doc.twists.find((t) => t.id === id)!
    expect(tw.wireIds).toEqual(['w1', 'w2'])
    expect(tw.span.segmentIds).toEqual([])
    s().undo()
    expect(s().doc.twists).toHaveLength(0)
  })
})

describe('commitLabelPositions', () => {
  beforeEach(() => reset())

  it('writes label pos as one undoable edit; no-op when unchanged', () => {
    const id = s().addLabel({ type: 'wire', wireId: 'w1' }, 'wireMarker', 'A', { x: 0, y: 0 })
    const before = s().past.length
    s().commitLabelPositions([{ id, pos: { x: 10, y: 20 } }])
    expect(s().doc.labels.find((l) => l.id === id)!.pos).toEqual({ x: 10, y: 20 })
    expect(s().past.length).toBe(before + 1)

    const after = s().past.length
    s().commitLabelPositions([{ id, pos: { x: 10, y: 20 } }]) // unchanged → no history
    expect(s().past.length).toBe(after)

    s().undo()
    expect(s().doc.labels.find((l) => l.id === id)!.pos).toEqual({ x: 0, y: 0 })
  })
})

describe('anchored labels (formboard)', () => {
  beforeEach(() => reset())
  const RN = (b: string) => ({ type: 'branch' as const, branchId: b })
  /** w1 routed through three segments s1,s2,s3 between four branch points. */
  function routedDoc(): HarnessDocument {
    const d = emptyDocument()
    d.branchPoints = [
      { id: 'P', pos: { x: 0, y: 0 } },
      { id: 'Q', pos: { x: 30, y: 0 } },
      { id: 'R', pos: { x: 60, y: 0 } },
      { id: 'S', pos: { x: 90, y: 0 } }
    ]
    d.segments = [
      { id: 's1', from: RN('P'), to: RN('Q') },
      { id: 's2', from: RN('Q'), to: RN('R') },
      { id: 's3', from: RN('R'), to: RN('S') }
    ]
    d.wires = [
      { id: 'w1', ends: [{ type: 'splice', spliceId: 'x' }, { type: 'splice', spliceId: 'y' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'GY' } }
    ]
    d.wireRoutes = [{ wireId: 'w1', path: ['s1', 's2', 's3'] }]
    return d
  }

  it('addLabel on a routed wire derives a segment anchor (middle segment @0.5)', () => {
    s().setDocument(routedDoc(), '/tmp/x.json')
    const id = s().addLabel({ type: 'wire', wireId: 'w1' }, 'wireMarker', 'M', { x: 0, y: 0 })
    expect(s().doc.labels.find((l) => l.id === id)!.anchor).toEqual({ segmentId: 's2', fraction: 0.5 })
  })

  it('addLabel on a branchPoint target stays free (no anchor)', () => {
    s().setDocument(routedDoc(), '/tmp/x.json')
    const id = s().addLabel({ type: 'branchPoint', branchId: 'P' }, 'callout', 'B', { x: 1, y: 2 })
    expect(s().doc.labels.find((l) => l.id === id)!.anchor).toBeUndefined()
  })

  it('commitLabelAnchors writes the fraction as one undo step; no-op when unchanged; undo restores', () => {
    s().setDocument(routedDoc(), '/tmp/x.json')
    const id = s().addLabel({ type: 'wire', wireId: 'w1' }, 'wireMarker', 'M', { x: 0, y: 0 })
    const before = s().past.length
    s().commitLabelAnchors([{ id, fraction: 0.8 }])
    expect(s().doc.labels.find((l) => l.id === id)!.anchor!.fraction).toBe(0.8)
    expect(s().past.length).toBe(before + 1)
    const after = s().past.length
    s().commitLabelAnchors([{ id, fraction: 0.8 }]) // unchanged → no history
    expect(s().past.length).toBe(after)
    s().undo()
    expect(s().doc.labels.find((l) => l.id === id)!.anchor!.fraction).toBe(0.5)
  })

  it("removeWire re-anchors a label off a GC'd segment instead of leaving it dangling", () => {
    const d = routedDoc()
    d.wires.push({ id: 'w2', ends: [{ type: 'splice', spliceId: 'p' }, { type: 'splice', spliceId: 'q' }], gauge: { value: 0.5, unit: 'mm2' }, color: { base: 'BU' } })
    d.wireRoutes.push({ wireId: 'w2', path: ['s2'] }) // shares s2 with w1
    d.labels = [
      { id: 'L', target: { type: 'wire', wireId: 'w2' }, kind: 'flag', text: 'x', pos: { x: 0, y: 0 }, anchor: { segmentId: 's1', fraction: 0.5 } }
    ]
    s().setDocument(d, '/tmp/x.json')
    s().removeWire('w1') // s1, s3 GC'd (single-wire); s2 survives for w2
    expect(s().doc.segments.find((seg) => seg.id === 's1')).toBeUndefined()
    const L = s().doc.labels.find((l) => l.id === 'L')!
    expect(L).toBeDefined() // label not deleted
    expect(L.anchor).toEqual({ segmentId: 's2', fraction: 0.5 }) // re-derived from w2's route
  })
})

describe('removeWire branch-point GC (B4)', () => {
  beforeEach(() => reset())

  it('removes branch points orphaned by deleting the only wire through them', () => {
    // arrange: two connectors + a wire, then insertBranchPoint on the wire's only segment
    const a = { type: 'cavity', cavityId: 'a' } as const
    const b = { type: 'cavity', cavityId: 'b' } as const
    const wireId = s().addWire(a, b)
    const segId = s().doc.wireRoutes[0].path[0]
    const bid = s().insertBranchPoint(segId, { x: 50, y: 0 })
    expect(s().doc.branchPoints).toHaveLength(1)
    s().removeWire(wireId)
    const doc = s().doc
    expect(doc.branchPoints).toHaveLength(0) // was 1 before the fix — floating dot + spurious DRC
    expect(doc.segments).toHaveLength(0)
  })

  it("removeWire prunes a branch-target label whose segment was GC'd (B3)", () => {
    const a = { type: 'cavity', cavityId: 'a' } as const
    const b = { type: 'cavity', cavityId: 'b' } as const
    const wireId = s().addWire(a, b)
    const segId = s().doc.wireRoutes[0].path[0]
    s().addLabel({ type: 'branch', segmentId: segId }, 'callout', 'x', { x: 0, y: 0 })
    expect(s().doc.labels).toHaveLength(1)
    s().removeWire(wireId)
    expect(s().doc.labels).toHaveLength(0)
  })
})

describe('insertBranchPoint no-op guard (R5)', () => {
  beforeEach(() => reset())

  it('pushes no history entry and returns null for a missing segment id', () => {
    const before = s().past.length
    const r = s().insertBranchPoint('no-such-segment', { x: 0, y: 0 })
    expect(r).toBeNull()
    expect(s().past.length).toBe(before)
  })
})

describe('removeWires batch (B5)', () => {
  beforeEach(() => reset())

  it('removeWires deletes N wires as ONE undo entry (B5)', () => {
    const a = { type: 'cavity', cavityId: 'a' } as const
    const b = { type: 'cavity', cavityId: 'b' } as const
    const w1 = s().addWire(a, b)
    const w2 = s().addWire(a, b)
    const w3 = s().addWire(a, b)
    // Three wires down ONE limb: one segment, not three coincident ones (C1).
    expect(s().doc.segments).toHaveLength(1)
    const before = s().past.length
    s().removeWires([w1, w2, w3])
    const st = s()
    expect(st.doc.wires).toHaveLength(0)
    expect(st.doc.segments).toHaveLength(0) // the last wire off the limb GCs it
    expect(st.past.length).toBe(before + 1)
    st.undo()
    expect(s().doc.wires).toHaveLength(3) // all back in one step
    expect(s().doc.segments).toHaveLength(1)
  })

  it('removeWires with no matching id is a no-op (no history entry)', () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const before = s().past.length
    s().removeWires(['no-such-wire'])
    expect(s().past.length).toBe(before)
    expect(s().doc.wires).toHaveLength(1)
  })
})

describe('removeBranchPoints batch (B5)', () => {
  beforeEach(() => reset())

  it('removeBranchPoints removes multiple degree-2 bends as ONE undo entry (B5)', () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const seg0 = s().doc.segments[0].id
    const b1 = s().insertBranchPoint(seg0, { x: 10, y: 0 })!
    const seg2 = s().doc.wireRoutes[0].path[1]
    const b2 = s().insertBranchPoint(seg2, { x: 20, y: 0 })!
    expect(s().doc.branchPoints).toHaveLength(2)
    const before = s().past.length
    const n = s().removeBranchPoints([b1, b2])
    expect(n).toBe(2)
    expect(s().past.length).toBe(before + 1)
    expect(s().doc.branchPoints).toHaveLength(0)
  })

  it('removeBranchPoints with no feasible id is a no-op (no history, returns 0)', () => {
    // A single wire's own segment endpoints aren't branch points at all — pass
    // a bogus id, which has incident count 0 (not 2) and is thus infeasible.
    const before = s().past.length
    const n = s().removeBranchPoints(['no-such-branch'])
    expect(n).toBe(0)
    expect(s().past.length).toBe(before)
  })

  it('removeBranchPoints with duplicate ids returns 1 (each branch removed once)', () => {
    s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const seg0 = s().doc.segments[0].id
    const b1 = s().insertBranchPoint(seg0, { x: 10, y: 0 })!
    expect(s().doc.branchPoints).toHaveLength(1)
    const before = s().past.length
    const n = s().removeBranchPoints([b1, b1])
    expect(n).toBe(1)
    expect(s().doc.branchPoints).toHaveLength(0)
    expect(s().past.length).toBe(before + 1)
  })
})

describe('commitGesture (B5)', () => {
  beforeEach(() => reset())

  it('commits node+label+anchor moves as ONE undo entry (B5)', () => {
    const connId = s().addConnector({ x: 0, y: 0 })
    const wireId = s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const freeLabelId = s().addLabel({ type: 'branchPoint', branchId: 'none' }, 'callout', 'free', {
      x: 1,
      y: 1
    })
    const anchoredLabelId = s().addLabel({ type: 'wire', wireId }, 'wireMarker', 'M', { x: 0, y: 0 })
    const before = s().past.length
    s().commitGesture({
      nodeMoves: [{ refId: connId, pos: { x: 9, y: 9 } }],
      target: 'physical',
      labelMoves: [{ id: freeLabelId, pos: { x: 5, y: 5 } }],
      anchorMoves: [{ id: anchoredLabelId, fraction: 0.25 }]
    })
    const st = s()
    expect(st.past.length).toBe(before + 1)
    expect(st.doc.placements.find((p) => p.refId === connId)!.pos).toEqual({ x: 9, y: 9 })
    expect(st.doc.labels.find((l) => l.id === freeLabelId)!.pos).toEqual({ x: 5, y: 5 })
    expect(st.doc.labels.find((l) => l.id === anchoredLabelId)!.anchor!.fraction).toBe(0.25)
    st.undo()
    const after = s()
    expect(after.doc.placements.find((p) => p.refId === connId)!.pos).toEqual({ x: 0, y: 0 })
    expect(after.doc.labels.find((l) => l.id === freeLabelId)!.pos).toEqual({ x: 1, y: 1 })
    expect(after.doc.labels.find((l) => l.id === anchoredLabelId)!.anchor!.fraction).toBe(0.5)
  })

  it('group gesture is one undo entry', () => {
    const c1 = s().addConnector({ x: 0, y: 0 })
    const c2 = s().addConnector({ x: 10, y: 10 })
    const labelId = s().addLabel({ type: 'branchPoint', branchId: 'none' }, 'callout', 'free', {
      x: 1,
      y: 1
    })
    const posOf = (id: string) => s().doc.placements.find((p) => p.refId === id)!.pos
    const [p1, p2] = [{ ...posOf(c1) }, { ...posOf(c2) }] // addConnector may nudge off the requested spot
    const blocksBefore = structuredClone(s().doc.drawing.blocks)
    const before = s().past.length
    s().commitGesture({
      nodeMoves: [
        { refId: c1, pos: { x: 90, y: 91 } },
        { refId: c2, pos: { x: 92, y: 93 } }
      ],
      target: 'physical',
      labelMoves: [{ id: labelId, pos: { x: 7, y: 8 } }],
      anchorMoves: [],
      blockMoves: [{ kind: 'bom', pos: { x: 300, y: 400 } }]
    })
    expect(s().past.length).toBe(before + 1)
    expect(s().doc.placements.find((p) => p.refId === c1)!.pos).toEqual({ x: 90, y: 91 })
    expect(s().doc.placements.find((p) => p.refId === c2)!.pos).toEqual({ x: 92, y: 93 })
    expect(s().doc.labels.find((l) => l.id === labelId)!.pos).toEqual({ x: 7, y: 8 })
    expect(s().doc.drawing.blocks?.bom).toEqual({ x: 300, y: 400 })
    s().undo()
    expect(s().doc.placements.find((p) => p.refId === c1)!.pos).toEqual(p1)
    expect(s().doc.placements.find((p) => p.refId === c2)!.pos).toEqual(p2)
    expect(s().doc.labels.find((l) => l.id === labelId)!.pos).toEqual({ x: 1, y: 1 })
    expect(s().doc.drawing.blocks).toEqual(blocksBefore)
  })

  it('an anchor move with a segmentId re-pins the label to that segment; an unknown one is ignored', () => {
    const wireId = s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    const seg0 = s().doc.wireRoutes.find((r) => r.wireId === wireId)!.path[0]
    s().insertBranchPoint(seg0, { x: 10, y: 0 })
    const [first, second] = s().doc.wireRoutes.find((r) => r.wireId === wireId)!.path
    const labelId = s().addLabel({ type: 'wire', wireId }, 'wireMarker', 'M', { x: 0, y: 0 })
    s().applyEdit((d) => {
      d.labels.find((l) => l.id === labelId)!.anchor = { segmentId: first, fraction: 0.5 }
    })
    const before = s().past.length
    s().commitGesture({
      nodeMoves: [],
      target: 'physical',
      labelMoves: [],
      anchorMoves: [{ id: labelId, segmentId: second, fraction: 0.25 }]
    })
    expect(s().doc.labels.find((l) => l.id === labelId)!.anchor).toEqual({ segmentId: second, fraction: 0.25 })
    expect(s().past.length).toBe(before + 1)
    s().commitGesture({
      nodeMoves: [],
      target: 'physical',
      labelMoves: [],
      anchorMoves: [{ id: labelId, segmentId: 'no-such-segment', fraction: 0.75 }]
    })
    expect(s().doc.labels.find((l) => l.id === labelId)!.anchor).toEqual({ segmentId: second, fraction: 0.25 })
    expect(s().past.length).toBe(before + 1)
  })

  it('commitGesture with no effective change pushes no history entry (B5)', () => {
    const before = s().past.length
    s().commitGesture({ nodeMoves: [], target: 'physical', labelMoves: [], anchorMoves: [] })
    expect(s().past.length).toBe(before)
  })
})

describe('setBundlePart (loom tape)', () => {
  beforeEach(() => {
    reset()
    s().applyEdit((d) => {
      d.bundles.push({ id: 'bn1', segmentIds: ['s1'], memberWireIds: ['w1', 'w2'] })
    })
  })

  it('sets the part as one undoable edit', () => {
    const before = s().past.length
    s().setBundlePart('bn1', { partNumber: 'TAPE-19' })
    expect(s().doc.bundles[0].part).toEqual({ partNumber: 'TAPE-19' })
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(s().doc.bundles[0].part).toBeUndefined()
  })

  it('clears the part when passed undefined', () => {
    s().setBundlePart('bn1', { partNumber: 'TAPE-19' })
    s().setBundlePart('bn1', undefined)
    expect(s().doc.bundles[0].part).toBeUndefined()
  })

  it('is a no-op with NO history entry for a missing bundle id', () => {
    const before = s().past.length
    s().setBundlePart('nope', { partNumber: 'TAPE-19' })
    expect(s().past.length).toBe(before)
  })
})

describe('cable-core deletion (R1)', () => {
  /** A 2-core shielded cable: cores w1/w2 + drain wd, each with a trivial route. */
  function cabled(): void {
    reset()
    s().applyEdit((d) => {
      for (const id of ['w1', 'w2', 'wd']) {
        d.wires.push({
          id,
          ends: [
            { type: 'cavity', cavityId: `${id}-a` },
            { type: 'cavity', cavityId: `${id}-b` }
          ],
          gauge: { value: 0.5, unit: 'mm2' },
          color: { base: 'GY' },
          ...(id === 'wd' ? {} : { cableId: 'cab1' })
        })
      }
      d.wires[2].ends[1] = { type: 'shield', cableId: 'cab1', end: 'a' }
      d.cables.push({
        id: 'cab1',
        name: 'CAN-1',
        coreWireIds: ['w1', 'w2'],
        shield: { present: true, drainWireId: 'wd' }
      })
    })
  }

  it('drops the core reference from the cable when a core wire is removed', () => {
    cabled()
    const before = s().past.length
    s().removeWire('w1')
    expect(s().doc.cables[0].coreWireIds).toEqual(['w2'])
    expect(s().past.length).toBe(before + 1) // SAME single undo entry
  })

  it('undo restores the core reference (one entry for wire + cable edit)', () => {
    cabled()
    s().removeWire('w1')
    s().undo()
    expect(s().doc.cables[0].coreWireIds).toEqual(['w1', 'w2'])
    expect(s().doc.wires.map((w) => w.id)).toEqual(['w1', 'w2', 'wd'])
  })

  it('removes the Cable entity when its last core goes', () => {
    cabled()
    s().applyEdit((d) => {
      // drop the shield so nothing else references the cable
      delete d.cables[0].shield
      d.wires = d.wires.filter((w) => w.id !== 'wd')
    })
    s().removeWires(['w1', 'w2'])
    expect(s().doc.cables).toHaveLength(0)
  })

  it('keeps a coreless cable that a surviving shield endpoint still references', () => {
    cabled()
    s().removeWires(['w1', 'w2'])
    expect(s().doc.cables).toHaveLength(1)
    expect(s().doc.cables[0].coreWireIds).toEqual([])
  })

  it('clears drainWireId when the drain wire is removed', () => {
    cabled()
    s().removeWire('wd')
    expect(s().doc.cables[0].shield!.drainWireId).toBeUndefined()
    expect(s().doc.cables[0].shield!.present).toBe(true)
  })
})

describe('span contiguity guard (R2)', () => {
  /** Three collinear segments s1-s2-s3 plus a detached s9. */
  function routed(): void {
    reset()
    s().applyEdit((d) => {
      d.branchPoints.push(
        { id: 'n0', pos: { x: 0, y: 0 } },
        { id: 'n1', pos: { x: 10, y: 0 } },
        { id: 'n2', pos: { x: 20, y: 0 } },
        { id: 'n3', pos: { x: 30, y: 0 } },
        { id: 'n8', pos: { x: 90, y: 0 } },
        { id: 'n9', pos: { x: 99, y: 0 } }
      )
      const seg = (id: string, a: string, b: string) =>
        d.segments.push({
          id,
          from: { type: 'branch', branchId: a },
          to: { type: 'branch', branchId: b }
        })
      seg('s1', 'n0', 'n1')
      seg('s2', 'n1', 'n2')
      seg('s3', 'n2', 'n3')
      seg('s9', 'n8', 'n9')
      d.wires.push(
        { id: 'w1', ends: [{ type: 'splice', spliceId: 'a' }, { type: 'splice', spliceId: 'b' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'RD' } },
        { id: 'w2', ends: [{ type: 'splice', spliceId: 'a' }, { type: 'splice', spliceId: 'c' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } }
      )
      d.wireRoutes.push(
        { wireId: 'w1', path: ['s1', 's2', 's3'] },
        { wireId: 'w2', path: ['s1', 's2', 's3'] }
      )
    })
  }

  it('addTwist accepts a contiguous span', () => {
    routed()
    const before = s().past.length
    const id = s().addTwist(['w1', 'w2'], ['s1', 's2'])
    expect(id).not.toBeNull()
    expect(s().doc.twists).toHaveLength(1)
    expect(s().past.length).toBe(before + 1)
  })

  it('addTwist REJECTS a non-contiguous span — no twist, no history entry', () => {
    routed()
    const before = s().past.length
    const id = s().addTwist(['w1', 'w2'], ['s1', 's9'])
    expect(id).toBeNull()
    expect(s().doc.twists).toHaveLength(0)
    expect(s().past.length).toBe(before)
  })

  it('addTwist still allows the empty span (authored before the wires are co-routed)', () => {
    routed()
    const id = s().addTwist(['w1', 'w2'], [])
    expect(id).not.toBeNull()
    expect(s().doc.twists[0].span.segmentIds).toEqual([])
  })

  it('addSleeving REJECTS a non-contiguous span — no sleeving, no history entry', () => {
    routed()
    const before = s().past.length
    const id = s().addSleeving({ type: 'wire', wireId: 'w1' }, ['s1', 's3'])
    expect(id).toBeNull()
    expect(s().doc.sleeving).toHaveLength(0)
    expect(s().past.length).toBe(before)
  })

  it('addSleeving REJECTS a span over a segment that does not exist', () => {
    routed()
    expect(s().addSleeving({ type: 'wire', wireId: 'w1' }, ['ghost'])).toBeNull()
    expect(s().doc.sleeving).toHaveLength(0)
  })
})

describe('ghost treatment-only segments on wire removal (R4)', () => {
  /**
   * sA is routed by w1, w2 and w3; sB hangs off it and is routed by w1 ONLY.
   * A twist over all three names both segments.
   */
  function ghostFixture(): void {
    reset()
    s().applyEdit((d) => {
      d.branchPoints.push(
        { id: 'n0', pos: { x: 0, y: 0 } },
        { id: 'n1', pos: { x: 10, y: 0 } },
        { id: 'n2', pos: { x: 20, y: 0 } }
      )
      d.segments.push(
        { id: 'sA', from: { type: 'branch', branchId: 'n0' }, to: { type: 'branch', branchId: 'n1' } },
        { id: 'sB', from: { type: 'branch', branchId: 'n1' }, to: { type: 'branch', branchId: 'n2' } }
      )
      for (const id of ['w1', 'w2', 'w3']) {
        d.wires.push({
          id,
          ends: [{ type: 'splice', spliceId: 'p' }, { type: 'splice', spliceId: `q${id}` }],
          gauge: { value: 1, unit: 'mm2' },
          color: { base: 'RD' }
        })
      }
      d.wireRoutes.push(
        { wireId: 'w1', path: ['sA', 'sB'] },
        { wireId: 'w2', path: ['sA'] },
        { wireId: 'w3', path: ['sA'] }
      )
    })
  }

  it('GCs the segment no wire routes any more and trims the twist span', () => {
    ghostFixture()
    s().addTwist(['w1', 'w2', 'w3'], ['sA', 'sB'])
    s().removeWire('w1')
    expect(s().doc.segments.map((x) => x.id)).toEqual(['sA']) // no wire-less ghost
    expect(s().doc.twists).toHaveLength(1)
    expect(s().doc.twists[0].span.segmentIds).toEqual(['sA'])
  })

  it('removes the twist when its span held ONLY the now-unrouted segment', () => {
    ghostFixture()
    s().addTwist(['w1', 'w2', 'w3'], ['sB'])
    s().removeWire('w1')
    expect(s().doc.segments.map((x) => x.id)).toEqual(['sA'])
    expect(s().doc.twists).toHaveLength(0)
  })

  it('the whole cascade is still ONE undo entry', () => {
    ghostFixture()
    s().addTwist(['w1', 'w2', 'w3'], ['sA', 'sB'])
    const before = s().past.length
    s().removeWire('w1')
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(s().doc.segments.map((x) => x.id)).toEqual(['sA', 'sB'])
    expect(s().doc.twists[0].span.segmentIds).toEqual(['sA', 'sB'])
  })
})

describe('mm overrides reject bad values at the store boundary (session-10 nit)', () => {
  beforeEach(() => reset())

  const mkWire = (): string => {
    const id = s().addWire({ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' })
    return id
  }
  const wireOf = (id: string) => s().doc.wires.find((w) => w.id === id)!

  it('accepts a positive length override', () => {
    const id = mkWire()
    expect(s().setWireLengthOverride(id, 250)).toBe(true)
    expect(wireOf(id).specifiedLengthMm).toBe(250)
  })

  it('accepts ZERO — an explicit zero-length override is legal', () => {
    const id = mkWire()
    expect(s().setWireLengthOverride(id, 0)).toBe(true)
    expect(wireOf(id).specifiedLengthMm).toBe(0)
  })

  it('accepts undefined — clearing back to "derive from route"', () => {
    const id = mkWire()
    s().setWireLengthOverride(id, 250)
    expect(s().setWireLengthOverride(id, undefined)).toBe(true)
    expect(wireOf(id).specifiedLengthMm).toBeUndefined()
  })

  it.each([-1, -0.001, NaN, Infinity, -Infinity])(
    'rejects %p: no write, no history entry',
    (bad) => {
      const id = mkWire()
      s().setWireLengthOverride(id, 300)
      const past = s().past.length
      expect(s().setWireLengthOverride(id, bad as number)).toBe(false)
      expect(wireOf(id).specifiedLengthMm).toBe(300) // untouched
      expect(s().past.length).toBe(past) // no history entry
    }
  )

  it('rejects an unknown wire id without a history entry', () => {
    const past = s().past.length
    expect(s().setWireLengthOverride('nope', 10)).toBe(false)
    expect(s().past.length).toBe(past)
  })

  it('setWireAllowance applies the same rule', () => {
    const id = mkWire()
    expect(s().setWireAllowance(id, 0)).toBe(true)
    expect(s().setWireAllowance(id, 25)).toBe(true)
    expect(wireOf(id).addLengthMm).toBe(25)
    const past = s().past.length
    expect(s().setWireAllowance(id, -5)).toBe(false)
    expect(wireOf(id).addLengthMm).toBe(25)
    expect(s().past.length).toBe(past)
  })

  it('a no-op write (same value) pushes no history entry', () => {
    const id = mkWire()
    s().setWireLengthOverride(id, 100)
    const past = s().past.length
    expect(s().setWireLengthOverride(id, 100)).toBe(true)
    expect(s().past.length).toBe(past)
  })
})

describe('setSegmentLength (typed segment length)', () => {
  /** a(0,0) ── seg1 ── b(1000,0), drawn 1000; wire w1 a→b routed [seg1]. */
  function lineDoc(): HarnessDocument {
    const doc = pinnedEmpty()
    for (const id of ['a', 'b'])
      doc.connectors.push({ id, designator: id, cavities: [{ id, position: '1', status: 'populated' }] })
    doc.placements = [
      { refId: 'a', pos: { x: 0, y: 0 } },
      { refId: 'b', pos: { x: 1000, y: 0 } }
    ]
    doc.wires = [
      {
        id: 'w1',
        ends: [
          { type: 'cavity', cavityId: 'a' },
          { type: 'cavity', cavityId: 'b' }
        ],
        gauge: { value: 0.5, unit: 'mm2' },
        color: { base: 'GY' }
      }
    ]
    doc.segments = [{ id: 'seg1', from: { type: 'body', refId: 'a' }, to: { type: 'body', refId: 'b' } }]
    doc.wireRoutes = [{ wireId: 'w1', path: ['seg1'] }]
    return doc
  }
  const seg = (id: string) => s().doc.segments.find((x) => x.id === id)!

  beforeEach(() => s().setDocument(lineDoc(), '/tmp/test.harness.json'))

  it.each([0, -3, NaN, Infinity])('rejects %p: false, no write, no history entry', (bad) => {
    const past = s().past.length
    expect(s().setSegmentLength('seg1', bad)).toBe(false)
    expect(s().past.length).toBe(past)
    expect('specifiedLengthMm' in seg('seg1')).toBe(false)
  })

  it('850 → true, one history entry, value stored', () => {
    const past = s().past.length
    expect(s().setSegmentLength('seg1', 850)).toBe(true)
    expect(s().past.length).toBe(past + 1)
    expect(seg('seg1').specifiedLengthMm).toBe(850)
  })

  it('an unchanged value → false, no history entry', () => {
    s().setSegmentLength('seg1', 850)
    const past = s().past.length
    expect(s().setSegmentLength('seg1', 850)).toBe(false)
    expect(s().past.length).toBe(past)
  })

  it('null deletes the key (not set to undefined); null on an untyped segment is a no-op', () => {
    s().setSegmentLength('seg1', 850)
    expect(s().setSegmentLength('seg1', null)).toBe(true)
    expect('specifiedLengthMm' in seg('seg1')).toBe(false)
    const past = s().past.length
    expect(s().setSegmentLength('seg1', null)).toBe(false)
    expect(s().past.length).toBe(past)
  })

  it('an unknown segment id → false, no history entry', () => {
    const past = s().past.length
    expect(s().setSegmentLength('nope', 100)).toBe(false)
    expect(s().past.length).toBe(past)
  })

  it('insert at 25 % on drawn 1000 / typed 1200 → 300 + 900, cut length unchanged, undo restores', () => {
    s().setSegmentLength('seg1', 1200)
    expect(wireLength(s().doc, 'w1').mm).toBe(1200)
    expect(s().insertBranchPoint('seg1', { x: 250, y: 0 })).not.toBeNull()
    const typed = s().doc.segments.map((x) => x.specifiedLengthMm)
    expect(typed).toEqual([300, 900])
    expect(typed[0]! + typed[1]!).toBe(1200)
    expect(wireLength(s().doc, 'w1').mm).toBe(1200)
    s().undo()
    expect(s().doc.segments).toHaveLength(1)
    expect(seg('seg1').specifiedLengthMm).toBe(1200)
  })
})

describe('rescaleSegment (typed segment length)', () => {
  /** a(0,0) ─seg1─ b(1000,0) ─seg2─ c(1500,0); wire w1 a→c routed [seg1, seg2]; seg1 typed 1200. */
  function chainDoc(): HarnessDocument {
    const doc = pinnedEmpty()
    for (const id of ['a', 'b', 'c'])
      doc.connectors.push({ id, designator: id, cavities: [{ id, position: '1', status: 'populated' }] })
    doc.placements = [
      { refId: 'a', pos: { x: 0, y: 0 } },
      { refId: 'b', pos: { x: 1000, y: 0 } },
      { refId: 'c', pos: { x: 1500, y: 0 } }
    ]
    doc.wires = [
      {
        id: 'w1',
        ends: [
          { type: 'cavity', cavityId: 'a' },
          { type: 'cavity', cavityId: 'c' }
        ],
        gauge: { value: 0.5, unit: 'mm2' },
        color: { base: 'GY' }
      }
    ]
    doc.segments = [
      { id: 'seg1', from: { type: 'body', refId: 'a' }, to: { type: 'body', refId: 'b' }, specifiedLengthMm: 1200 },
      { id: 'seg2', from: { type: 'body', refId: 'b' }, to: { type: 'body', refId: 'c' } }
    ]
    doc.wireRoutes = [{ wireId: 'w1', path: ['seg1', 'seg2'] }]
    doc.drawing.blocks = { pinout: { c: { x: 1490, y: 30 } } }
    return doc
  }
  const pos = (id: string) => s().doc.placements.find((p) => p.refId === id)!.pos

  beforeEach(() => s().setDocument(chainDoc(), '/tmp/test.harness.json'))

  it('ok: one history entry, cut list uses the typed value before and after; undo restores every position', () => {
    const before = s().doc
    expect(wireLength(before, 'w1').mm).toBe(1700)
    const past = s().past.length
    expect(s().rescaleSegment('seg1', 'to')).toBe('ok')
    expect(s().past.length).toBe(past + 1)
    expect(pos('b')).toEqual({ x: 1200, y: 0 })
    expect(pos('c')).toEqual({ x: 1700, y: 0 })
    expect(pos('a')).toEqual({ x: 0, y: 0 })
    expect(s().doc.drawing.blocks!.pinout!.c).toEqual({ x: 1690, y: 30 })
    expect(s().doc.drawing.sheetOrigin).toEqual({ x: 0, y: 0 })
    expect(wireLength(s().doc, 'w1').mm).toBe(1700)
    s().undo()
    expect(s().doc.placements).toEqual(before.placements)
    expect(s().doc.drawing).toEqual(before.drawing)
  })

  it('loop: refused, no history entry, nothing moves', () => {
    s().applyEdit((d) => {
      d.segments.push({ id: 'seg3', from: { type: 'body', refId: 'a' }, to: { type: 'body', refId: 'c' } })
    })
    const before = s().doc
    const past = s().past.length
    expect(s().rescaleSegment('seg1', 'to')).toBe('loop')
    expect(s().past.length).toBe(past)
    expect(s().doc).toBe(before)
  })

  it('not-broken / no-segment: no history entry', () => {
    const past = s().past.length
    expect(s().rescaleSegment('seg2', 'to')).toBe('not-broken')
    expect(s().rescaleSegment('nope', 'from')).toBe('no-segment')
    expect(s().past.length).toBe(past)
  })
})

// ─── Load-time reconcile (setDocument's third argument) ──────────────────────

describe('setDocument load info', () => {
  beforeEach(() => reset())

  const repair = { kind: 'orphaned-route' as const, entityId: 'w9', message: 'dropped' }

  it('a clean load is not dirty and carries no repairs', () => {
    const doc = pinnedEmpty()
    s().setDocument(doc, '/tmp/clean.json', { repairs: [], migrated: [] })
    expect(s().dirty).toBe(false)
    expect(s().loadRepairs).toEqual([])
    expect(s().savedDoc).toBe(doc)
  })

  it('a repaired load is dirty against the ON-DISK document and exposes the repairs', () => {
    const onDisk = pinnedEmpty()
    const repaired = pinnedEmpty()
    s().setDocument(repaired, '/tmp/old.json', { repairs: [repair], migrated: [], onDiskDoc: onDisk })
    expect(s().doc).toBe(repaired)
    expect(s().savedDoc).toBe(onDisk)
    expect(s().dirty).toBe(true) // saving will change the file — say so
    expect(s().loadRepairs).toEqual([repair])
    expect(s().past).toEqual([]) // still no undo across a load
  })

  it('saving clears the repair notice and the dirty flag', () => {
    s().setDocument(pinnedEmpty(), '/tmp/old.json', {
      repairs: [repair],
      migrated: [],
      onDiskDoc: pinnedEmpty()
    })
    s().markSaved('/tmp/old.json')
    expect(s().dirty).toBe(false)
    expect(s().loadRepairs).toEqual([])
  })

  it('dismissLoadRepairs hides the notice without touching the document', () => {
    const repaired = pinnedEmpty()
    s().setDocument(repaired, '/tmp/old.json', { repairs: [repair], migrated: [], onDiskDoc: pinnedEmpty() })
    s().dismissLoadRepairs()
    expect(s().loadRepairs).toEqual([])
    expect(s().doc).toBe(repaired)
    expect(s().dirty).toBe(true) // the file still differs until it is saved
  })

  it('exposes the loader migration notes alongside the repairs', () => {
    s().setDocument(pinnedEmpty(), '/tmp/old.json', {
      repairs: [],
      migrated: ['sheet backfilled from legacy sheets[0]']
    })
    expect(s().loadMigrations).toEqual(['sheet backfilled from legacy sheets[0]'])
    expect(s().loadRepairs).toEqual([])
  })

  it('saving, dismissing and File > New all clear the migration notes too', () => {
    const load = { repairs: [], migrated: ['titleBlock migrated from a free-form record'] }
    s().setDocument(pinnedEmpty(), '/tmp/old.json', load)
    s().markSaved('/tmp/old.json')
    expect(s().loadMigrations).toEqual([])
    s().setDocument(pinnedEmpty(), '/tmp/old.json', load)
    s().dismissLoadRepairs()
    expect(s().loadMigrations).toEqual([])
    s().setDocument(pinnedEmpty(), '/tmp/old.json', load)
    s().newDocument()
    expect(s().loadMigrations).toEqual([])
  })

  it('File > New clears a previous load notice', () => {
    s().setDocument(pinnedEmpty(), '/tmp/old.json', {
      repairs: [repair],
      migrated: [],
      onDiskDoc: pinnedEmpty()
    })
    s().newDocument()
    expect(s().loadRepairs).toEqual([])
    expect(s().dirty).toBe(false)
  })
})

// ─── Fixed sheet: pinning drawing.sheetOrigin (spec §1) ────────────────────────

describe('setDocument pins a missing sheetOrigin once', () => {
  const NOTE = 'drawing.sheetOrigin pinned at the current drawing'

  it('absent → pinned at the framed origin, noted, dirty against the on-disk doc, no undo step', () => {
    const doc = demoDocument()
    expect(doc.drawing.sheetOrigin).toBeUndefined()
    s().setDocument(doc, '/tmp/old.json', { repairs: [], migrated: ['an older note'] })
    expect(s().doc.drawing.sheetOrigin).toEqual(framedSheetOrigin(computeFormboard(doc)))
    expect(s().loadMigrations).toEqual(['an older note', NOTE])
    expect(s().savedDoc).toBe(doc) // the baseline is still what the file holds
    expect(s().dirty).toBe(true) // saving writes the origin — say so
    expect(s().past).toEqual([]) // pinning is not an undoable edit
    expect(doc.drawing.sheetOrigin).toBeUndefined() // the caller's object is not mutated
  })

  it('absent with a repaired load → baseline stays the on-disk doc', () => {
    const onDisk = demoDocument()
    s().setDocument(demoDocument(), '/tmp/old.json', { repairs: [], migrated: [], onDiskDoc: onDisk })
    expect(s().savedDoc).toBe(onDisk)
    expect(s().doc.drawing.sheetOrigin).toBeDefined()
    expect(s().dirty).toBe(true)
  })

  it('present → untouched, same object, no note, not dirty', () => {
    const doc = demoDocument()
    doc.drawing.sheetOrigin = { x: 5, y: 7 }
    s().setDocument(doc, '/tmp/new.json', { repairs: [], migrated: [] })
    expect(s().doc).toBe(doc)
    expect(s().doc.drawing.sheetOrigin).toEqual({ x: 5, y: 7 })
    expect(s().loadMigrations).toEqual([])
    expect(s().dirty).toBe(false)
  })

  it('a reload of the pinned doc does not re-pin even after the harness moved', () => {
    s().setDocument(demoDocument(), '/tmp/old.json', { repairs: [], migrated: [] })
    const pinned = s().doc.drawing.sheetOrigin
    const moved = structuredClone(s().doc)
    moved.placements[0].pos.x -= 500 // the framed origin would now be far to the left
    s().setDocument(moved, '/tmp/old.json', { repairs: [], migrated: [] })
    expect(s().doc.drawing.sheetOrigin).toEqual(pinned)
    expect(s().loadMigrations).toEqual([])
  })

  it('pinSheetOrigin: false (the CLI) leaves a document without one as it is', () => {
    const doc = demoDocument()
    s().setDocument(doc, '/tmp/cli.json', undefined, { pinSheetOrigin: false })
    expect(s().doc).toBe(doc)
    expect(s().doc.drawing.sheetOrigin).toBeUndefined()
    expect(s().dirty).toBe(false)
  })

  it('newDocument has a sheetOrigin and is not dirty', () => {
    s().newDocument()
    expect(s().doc.drawing.sheetOrigin).toEqual(framedSheetOrigin(computeFormboard(emptyDocument())))
    expect(s().dirty).toBe(false)
    expect(s().savedDoc).toBe(s().doc)
    expect(s().loadMigrations).toEqual([])
  })

  it('the demo the app starts on has a sheetOrigin', () => {
    expect(useHarnessStore.getInitialState().doc.drawing.sheetOrigin).toEqual(
      framedSheetOrigin(computeFormboard(demoDocument()))
    )
  })
})

describe('document sheet + title block', () => {
  it('setSheet is undoable and no-ops on an equal value', () => {
    s().newDocument()
    const past0 = s().past.length
    s().setSheet({ paper: 'A2', orientation: 'portrait' })
    expect(s().doc.drawing.sheet).toEqual({ paper: 'A2', orientation: 'portrait' })
    expect(s().past.length).toBe(past0 + 1)
    s().setSheet({ paper: 'A2', orientation: 'portrait' })
    expect(s().past.length).toBe(past0 + 1)
    s().undo()
    expect(s().doc.drawing.sheet).toEqual({ paper: 'A3', orientation: 'landscape' })
  })

  it('setSheet treats a changed plotter length as a change, and never moves the sheet origin', () => {
    s().newDocument()
    const origin = s().doc.drawing.sheetOrigin
    s().setSheet({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2000 })
    const past0 = s().past.length
    s().setSheet({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 })
    expect(s().doc.drawing.sheet.lengthMm).toBe(2600)
    expect(s().past.length).toBe(past0 + 1)
    s().setSheet({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 })
    expect(s().past.length).toBe(past0 + 1)
    expect(s().doc.drawing.sheetOrigin).toEqual(origin)
  })

  it('setTitleBlock merges shallowly and replaces approvals whole', () => {
    s().newDocument()
    s().setTitleBlock({ title: 'Loom', drawnBy: { name: 'A', date: '2026-08-27' } })
    s().setTitleBlock({ partNumber: 'HX-650', drawnBy: { name: 'B' } })
    expect(s().doc.drawing.titleBlock).toEqual({
      title: 'Loom',
      partNumber: 'HX-650',
      drawnBy: { name: 'B' }
    })
    const n = s().past.length
    s().setTitleBlock({ partNumber: 'HX-650' })
    expect(s().past.length).toBe(n)
  })
})

describe('drawing blocks', () => {
  it('setBlockPos pins a pinout table (undoable) and ignores an unknown connector', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    const before = s().past.length
    s().setBlockPos({ kind: 'pinout', id: c1, pos: { x: 12, y: 34 } })
    expect(s().doc.drawing.blocks?.pinout?.[c1]).toEqual({ x: 12, y: 34 })
    expect(s().past.length).toBe(before + 1)
    s().setBlockPos({ kind: 'pinout', id: 'nope', pos: { x: 1, y: 1 } })
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(s().doc.drawing.blocks?.pinout?.[c1]).toBeUndefined()
  })

  it('setBlockPos bom + clearBlockPos; clearing an absent pin pushes no history', () => {
    s().setDocument(demoDocument(), null)
    s().setBlockPos({ kind: 'bom', pos: { x: 1, y: 2 } })
    expect(s().doc.drawing.blocks?.bom).toEqual({ x: 1, y: 2 })
    const n = s().past.length
    s().clearBlockPos('bom')
    expect(s().doc.drawing.blocks).toBeUndefined()
    expect(s().past.length).toBe(n + 1)
    s().clearBlockPos('bom')
    expect(s().past.length).toBe(n + 1)
  })

  it('pins a FREE-TERMINAL pinout table too (connectorPinouts emits one per terminal)', () => {
    s().setDocument(demoDocument(), null)
    const ft = s().doc.freeTerminals[0].id
    const before = s().past.length
    s().setBlockPos({ kind: 'pinout', id: ft, pos: { x: 55, y: 66 } })
    expect(s().doc.drawing.blocks?.pinout?.[ft]).toEqual({ x: 55, y: 66 })
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(s().doc.drawing.blocks?.pinout?.[ft]).toBeUndefined()
  })

  it('setBlockPos pins a PICTURE (undoable), no-ops on an unchanged value and an unknown id', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    const before = s().past.length
    s().setBlockPos({ kind: 'picture', id: c1, pos: { x: 12, y: 34 } })
    expect(s().doc.drawing.blocks?.picture?.[c1]).toEqual({ x: 12, y: 34 })
    expect(s().past.length).toBe(before + 1)
    // Same position again, and an id that is no body at all: no history.
    s().setBlockPos({ kind: 'picture', id: c1, pos: { x: 12, y: 34 } })
    s().setBlockPos({ kind: 'picture', id: 'nope', pos: { x: 1, y: 1 } })
    expect(s().past.length).toBe(before + 1)
    s().undo()
    expect(s().doc.drawing.blocks?.picture?.[c1]).toBeUndefined()
  })

  it('a SPLICE may pin a picture — it owns no pinout table but does own a body', () => {
    const d = demoDocument()
    const sp = 'sp-pic'
    d.splices.push({ id: sp, designator: 'SP1', kind: 'butt' })
    s().setDocument(d, null)
    s().setBlockPos({ kind: 'picture', id: sp, pos: { x: 5, y: 6 } })
    expect(s().doc.drawing.blocks?.picture?.[sp]).toEqual({ x: 5, y: 6 })
    // ...but not a pinout table, which only connectors and free terminals have.
    const n = s().past.length
    s().setBlockPos({ kind: 'pinout', id: sp, pos: { x: 7, y: 8 } })
    expect(s().past.length).toBe(n)
    expect(s().doc.drawing.blocks?.pinout?.[sp]).toBeUndefined()
  })

  it('clearBlockPos removes a pinned picture and drops the empty blocks object', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    s().setBlockPos({ kind: 'picture', id: c1, pos: { x: 3, y: 4 } })
    const n = s().past.length
    s().clearBlockPos('picture', c1)
    expect(s().doc.drawing.blocks).toBeUndefined()
    expect(s().past.length).toBe(n + 1)
    s().clearBlockPos('picture', c1)
    expect(s().past.length).toBe(n + 1)
  })

  it('clearing one pinned picture leaves the other pins alone', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    const c2 = s().doc.connectors[1].id
    s().setBlockPos({ kind: 'picture', id: c1, pos: { x: 1, y: 1 } })
    s().setBlockPos({ kind: 'picture', id: c2, pos: { x: 2, y: 2 } })
    s().setBlockPos({ kind: 'pinout', id: c1, pos: { x: 3, y: 3 } })
    s().clearBlockPos('picture', c1)
    expect(s().doc.drawing.blocks?.picture).toEqual({ [c2]: { x: 2, y: 2 } })
    expect(s().doc.drawing.blocks?.pinout?.[c1]).toEqual({ x: 3, y: 3 })
  })

  it('rotatePicture: four quarter turns come back to nothing stored, four undoable steps', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    const before = s().past.length
    const seen: (number | undefined)[] = []
    for (let i = 0; i < 4; i++) {
      s().rotatePicture(c1, 90)
      seen.push(s().doc.drawing.blocks?.pictureView?.[c1]?.rotationDeg)
    }
    expect(seen).toEqual([90, 180, 270, undefined])
    // Back at the identity the whole map — and `blocks` with it — is gone again.
    expect(s().doc.drawing.blocks).toBeUndefined()
    expect(s().past.length).toBe(before + 4)
    s().undo()
    expect(s().doc.drawing.blocks?.pictureView?.[c1]).toEqual({ rotationDeg: 270 })
  })

  it('rotatePicture takes any angle and wraps it', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    s().rotatePicture(c1, 15)
    s().rotatePicture(c1, -30)
    expect(s().doc.drawing.blocks?.pictureView?.[c1]).toEqual({ rotationDeg: 345 })
  })

  it('flipPicture toggles, and flipping twice stores nothing at all', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    s().flipPicture(c1, 'h')
    expect(s().doc.drawing.blocks?.pictureView?.[c1]).toEqual({ flipH: true })
    s().flipPicture(c1, 'v')
    expect(s().doc.drawing.blocks?.pictureView?.[c1]).toEqual({ flipH: true, flipV: true })
    s().flipPicture(c1, 'h')
    s().flipPicture(c1, 'v')
    expect(s().doc.drawing.blocks).toBeUndefined()
  })

  it('setPictureView normalises the angle it stores and no-ops on an unchanged one', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    s().setPictureView(c1, { rotationDeg: 450 })
    expect(s().doc.drawing.blocks?.pictureView?.[c1]).toEqual({ rotationDeg: 90 })
    const n = s().past.length
    s().setPictureView(c1, { rotationDeg: 90 })
    s().setPictureView(c1, { rotationDeg: -270 })
    expect(s().past.length).toBe(n)
    s().undo()
    expect(s().doc.drawing.blocks).toBeUndefined()
  })

  it('setPictureView ignores a body that is not there (no history, nothing written)', () => {
    s().setDocument(demoDocument(), null)
    const n = s().past.length
    s().setPictureView('nope', { rotationDeg: 90 })
    s().rotatePicture('nope', 90)
    s().flipPicture('nope', 'h')
    expect(s().past.length).toBe(n)
    expect(s().doc.drawing.blocks).toBeUndefined()
  })

  it('a SPLICE may be rotated — every drawn body owns a picture', () => {
    const d = demoDocument()
    d.splices.push({ id: 'sp-rot', designator: 'SP1', kind: 'butt' })
    s().setDocument(d, null)
    s().rotatePicture('sp-rot', 90)
    expect(s().doc.drawing.blocks?.pictureView?.['sp-rot']).toEqual({ rotationDeg: 90 })
  })

  it('resetting one view leaves the other views and the pins alone', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    const c2 = s().doc.connectors[1].id
    s().setBlockPos({ kind: 'picture', id: c1, pos: { x: 1, y: 1 } })
    s().rotatePicture(c1, 90)
    s().flipPicture(c2, 'v')
    s().setPictureView(c1, { rotationDeg: 0, flipH: false, flipV: false })
    expect(s().doc.drawing.blocks?.pictureView).toEqual({ [c2]: { flipV: true } })
    expect(s().doc.drawing.blocks?.picture?.[c1]).toEqual({ x: 1, y: 1 })
  })

  it('a view outlives clearing the pin — the two are independent', () => {
    s().setDocument(demoDocument(), null)
    const c1 = s().doc.connectors[0].id
    s().setBlockPos({ kind: 'picture', id: c1, pos: { x: 1, y: 1 } })
    s().rotatePicture(c1, 90)
    s().clearBlockPos('picture', c1)
    expect(s().doc.drawing.blocks).toEqual({ pictureView: { [c1]: { rotationDeg: 90 } } })
  })

  it('a mixed gesture (connector + table) is ONE history entry', () => {
    s().setDocument(demoDocument(), null)
    const d = s().doc
    const c1 = d.connectors[0].id
    const p = d.placements.find((x) => x.refId === c1)!
    const n = s().past.length
    s().commitGesture({
      nodeMoves: [{ refId: c1, pos: { x: p.pos.x + 10, y: p.pos.y } }],
      target: 'physical',
      labelMoves: [],
      anchorMoves: [],
      blockMoves: [{ kind: 'pinout', id: c1, pos: { x: 0, y: 0 } }]
    })
    expect(s().past.length).toBe(n + 1)
    expect(s().doc.drawing.blocks?.pinout?.[c1]).toEqual({ x: 0, y: 0 })
    // ...and the CONNECTOR half of the same gesture landed too. Without this
    // the test passed on a commit that applied only `blockMoves`.
    expect(s().doc.placements.find((x) => x.refId === c1)!.pos).toEqual({
      x: p.pos.x + 10,
      y: p.pos.y
    })
  })
})

describe('grid view preference', () => {
  beforeEach(reset)

  it('defaults to a visible 20 mm grid', () => {
    expect(s().gridVisible).toBe(true)
    expect(s().gridMm).toBe(20)
  })

  it('toggling / resizing the grid is not an undoable document edit', () => {
    s().setGridVisible(false)
    s().setGridMm(5)
    expect(s().gridVisible).toBe(false)
    expect(s().gridMm).toBe(5)
    expect(s().past).toHaveLength(0)
    expect(s().dirty).toBe(false)
  })

  it('clamps the pitch to 1..1000 mm', () => {
    s().setGridMm(0)
    expect(s().gridMm).toBe(1)
    s().setGridMm(-7)
    expect(s().gridMm).toBe(1)
    s().setGridMm(50000)
    expect(s().gridMm).toBe(1000)
  })
})

describe('library-driven actions', () => {
  beforeEach(() => resetEmpty())

  const pinPart: LibraryPart = { ...newLibraryPart('pin', 'P1'), description: 'Contact', manufacturer: 'TE' }
  const housingPart: LibraryPart = {
    ...newLibraryPart('connector', 'H1'), description: 'Housing', manufacturer: 'TE',
    connector: { gender: 'female', cavities: [{ position: 'A', defaultPin: 'P1' }, { position: 'B' }] }
  }
  const resolve = (pn: string): LibraryPart | undefined => (pn === 'P1' ? pinPart : undefined)

  it('addConnectorFromPart adds one connector + placement in ONE history entry', () => {
    const id = s().addConnectorFromPart({ x: 10, y: 20 }, housingPart, resolve)
    const c = s().doc.connectors.find((x) => x.id === id)!
    expect(c.housing).toEqual({ partNumber: 'H1', manufacturer: 'TE', description: 'Housing' })
    expect(c.gender).toBe('female')
    expect(c.cavities.map((cv) => cv.position)).toEqual(['A', 'B'])
    expect(c.cavities[0].pin).toEqual({ partNumber: 'P1', manufacturer: 'TE', description: 'Contact' })
    expect(s().doc.placements.some((p) => p.refId === id)).toBe(true)
    expect(s().past).toHaveLength(1)
    s().undo()
    expect(s().doc.connectors).toHaveLength(0)
    expect(s().past).toHaveLength(0)
  })

  it('addFreeTerminalFromPart / addSpliceFromPart', () => {
    const t = s().addFreeTerminalFromPart({ x: 0, y: 0 }, { ...newLibraryPart('terminal', 'T1'), description: 'Fork', terminal: { kind: 'fork' } })
    expect(s().doc.freeTerminals.find((x) => x.id === t)).toMatchObject({ kind: 'fork', part: { partNumber: 'T1' } })
    const sp = s().addSpliceFromPart({ x: 0, y: 0 }, { ...newLibraryPart('splice', 'S1'), description: 'Weld', splice: { kind: 'weld' } })
    expect(s().doc.splices.find((x) => x.id === sp)).toMatchObject({ kind: 'weld', part: { partNumber: 'S1' } })
  })

  it('applyCavityTemplate replaces cavities on a wire-free connector, refuses a wired one', () => {
    const id = s().addConnector({ x: 0, y: 0 })
    expect(s().applyCavityTemplate(id, housingPart, resolve)).toBe(true)
    const c = s().doc.connectors.find((x) => x.id === id)!
    expect(c.cavities.map((cv) => cv.position)).toEqual(['A', 'B'])
    expect(c.gender).toBe('female')
    // wire it, then try again
    const other = s().addConnector({ x: 50, y: 0 })
    const cavA = c.cavities[0].id
    const cavO = s().doc.connectors.find((x) => x.id === other)!.cavities[0].id
    s().addWire({ type: 'cavity', cavityId: cavA }, { type: 'cavity', cavityId: cavO })
    const before = s().past.length
    expect(s().applyCavityTemplate(id, housingPart, resolve)).toBe(false)
    expect(s().past.length).toBe(before)
  })

  it('refreshPartRefs rewrites stale descriptions, no-op adds no history entry', () => {
    const id = s().addConnector({ x: 0, y: 0 })
    s().applyEdit((d) => { d.connectors.find((x) => x.id === id)!.housing = { partNumber: 'H1', description: 'old' } })
    const cat = new LibraryCatalog([housingPart, pinPart])
    const before = s().past.length
    expect(s().refreshPartRefs(cat)).toBe(1)
    expect(s().doc.connectors.find((x) => x.id === id)!.housing).toEqual({ partNumber: 'H1', manufacturer: 'TE', description: 'Housing' })
    expect(s().past.length).toBe(before + 1)
    expect(s().refreshPartRefs(cat)).toBe(0)
    expect(s().past.length).toBe(before + 1)
  })
})

describe('pane state', () => {
  beforeEach(() => {
    reset()
    useHarnessStore.setState({ panes: { split: false, left: 'schematic', right: 'formboard' } })
  })

  it('starts single, schematic left, formboard right', () => {
    const s = useHarnessStore.getState()
    expect(s.panes).toEqual({ split: false, left: 'schematic', right: 'formboard' })
  })

  it('sets a pane view per side', () => {
    useHarnessStore.getState().setPaneView('left', 'formboard')
    expect(useHarnessStore.getState().panes.left).toBe('formboard')
    useHarnessStore.getState().setPaneView('right', 'schematic')
    expect(useHarnessStore.getState().panes.right).toBe('schematic')
  })

  it('allows the same view in both panes', () => {
    useHarnessStore.getState().setPaneView('left', 'formboard')
    useHarnessStore.getState().setPaneView('right', 'formboard')
    expect(useHarnessStore.getState().panes).toMatchObject({ left: 'formboard', right: 'formboard' })
  })

  it('toggles split without touching the pane views', () => {
    useHarnessStore.getState().setPaneView('left', 'formboard')
    useHarnessStore.getState().setPaneView('right', 'schematic')
    useHarnessStore.getState().setSplit(true)
    expect(useHarnessStore.getState().panes).toEqual({ split: true, left: 'formboard', right: 'schematic' })
  })

  it('never mutates the document and never lands on the undo stack', () => {
    const before = useHarnessStore.getState().doc
    const past = useHarnessStore.getState().past.length
    useHarnessStore.getState().setSplit(true)
    useHarnessStore.getState().setPaneView('right', 'schematic')
    expect(useHarnessStore.getState().doc).toBe(before)
    expect(useHarnessStore.getState().past.length).toBe(past)
  })
})

describe('addCableFromPart', () => {
  const g = { value: 0.5, unit: 'mm2' as const }
  const can: LibraryPart = {
    ...newLibraryPart('cable', 'MCB-0001'),
    description: 'CAN pair',
    cable: {
      cores: [
        { name: 'CAN_H', color: 'WH', gauge: g, pair: 'A' },
        { name: 'CAN_L', color: 'GN', gauge: g, pair: 'A' }
      ],
      shield: { drain: true },
      jacketColor: 'BK'
    }
  }
  const cav = (c: string) => ({ type: 'cavity' as const, cavityId: c })
  function twoConnectors(): void {
    const doc = emptyDocument()
    for (const id of ['X1', 'X2'])
      doc.connectors.push({
        id,
        designator: id,
        cavities: [
          { id: `${id}-1`, position: '1', status: 'populated' },
          { id: `${id}-2`, position: '2', status: 'populated' }
        ]
      })
    s().setDocument(doc, '/tmp/test.harness.json')
  }
  const both = [
    { core: 'CAN_H', a: cav('X1-1'), b: cav('X2-1') },
    { core: 'CAN_L', a: cav('X1-2'), b: cav('X2-2') }
  ]

  it('builds the cable and its cores in one undo step', () => {
    twoConnectors()
    const id = s().addCableFromPart(can, 'CAN-1', both)
    const d = s().doc
    expect(s().past).toHaveLength(1)
    expect(d.cables).toHaveLength(1)
    const cab = d.cables[0]
    expect(cab).toMatchObject({ id, name: 'CAN-1', jacketColor: 'BK', twistedPair: true, part: { partNumber: 'MCB-0001' } })
    expect(cab.shield).toEqual({ present: true })
    expect(d.wires).toHaveLength(2)
    expect(d.wires.map((w) => w.cableId)).toEqual([id, id])
    expect(d.wires.map((w) => w.color.base)).toEqual(['WH', 'GN'])
    expect(d.wires.every((w) => w.gauge.value === 0.5 && w.spec === undefined)).toBe(true)
    expect(cab.coreWireIds).toEqual(d.wires.map((w) => w.id))
    expect(d.segments).toHaveLength(1)
    expect(d.wireRoutes.map((r) => r.path[0])).toEqual([d.segments[0].id, d.segments[0].id])
    s().undo()
    expect(s().doc.cables).toHaveLength(0)
    expect(s().doc.wires).toHaveLength(0)
    expect(s().doc.segments).toHaveLength(0)
  })

  it('wires the drain from the shield endpoint', () => {
    twoConnectors()
    const t = s().addFreeTerminal({ x: 0, y: 0 })
    const before = s().past.length
    const id = s().addCableFromPart(can, 'CAN-1', both, { end: 'a', to: { type: 'freeTerminal', terminalId: t } })
    expect(s().past.length).toBe(before + 1)
    const cab = s().doc.cables[0]
    const dw = s().doc.wires.find((w) => w.id === cab.shield?.drainWireId)!
    expect(dw.ends[0]).toEqual({ type: 'shield', cableId: id, end: 'a' })
    expect(dw.cableId).toBe(id)
    expect(cab.coreWireIds).not.toContain(dw.id)
  })

  it('refuses bad requests without a history entry', () => {
    twoConnectors()
    const h = s().past.length
    const noShield: LibraryPart = { ...can, cable: { cores: can.cable!.cores } }
    const drainCore: LibraryPart = {
      ...can,
      cable: { cores: [...can.cable!.cores, { name: 'drain', color: 'BK', gauge: g }], shield: { drain: true } }
    }
    const one = [both[0]]
    const cases: (() => unknown)[] = [
      () => s().addCableFromPart({ ...can, kind: 'wire' }, 'C', both),
      () => s().addCableFromPart({ ...can, cable: undefined }, 'C', both),
      () => s().addCableFromPart({ ...can, cable: { cores: [] } }, 'C', both),
      () => s().addCableFromPart(can, 'C', []),
      () => s().addCableFromPart(can, 'C', [{ ...both[0], core: 'NOPE' }]),
      () => s().addCableFromPart(can, 'C', [both[0], both[0]]),
      () => s().addCableFromPart(can, '  ', both),
      () => s().addCableFromPart(noShield, 'C', one, { end: 'b', to: cav('X2-2') }),
      () =>
        s().addCableFromPart(drainCore, 'C', [...one, { core: 'drain', a: cav('X1-2'), b: cav('X2-2') }], {
          end: 'b',
          to: cav('X2-2')
        })
    ]
    for (const c of cases) expect(c()).toBeNull()
    expect(s().past).toHaveLength(h)
    expect(s().doc.cables).toHaveLength(0)
    expect(s().doc.wires).toHaveLength(0)
  })

  it('stores coreName and corePair on each core', () => {
    twoConnectors()
    s().addCableFromPart(can, 'CAN-1', both)
    expect(s().doc.wires.map((w) => [w.coreName, w.corePair])).toEqual([
      ['CAN_H', 'A'],
      ['CAN_L', 'A']
    ])
  })

  it('accepts a drain on a shielded record with drain:false and DRC has no shield-without-drain', () => {
    twoConnectors()
    const t = s().addFreeTerminal({ x: 0, y: 0 })
    const rec: LibraryPart = { ...can, cable: { cores: can.cable!.cores, shield: { drain: false } } }
    const id = s().addCableFromPart(rec, 'CAN-1', both, { end: 'a', to: { type: 'freeTerminal', terminalId: t } })
    expect(id).not.toBeNull()
    expect(runDrc(s().doc).map((f) => f.ruleId)).not.toContain('shield-without-drain')
  })

  it('a drained cable raises no unrouted-wire for the drain', () => {
    twoConnectors()
    const t = s().addFreeTerminal({ x: 0, y: 0 })
    s().addCableFromPart(can, 'CAN-1', both, { end: 'a', to: { type: 'freeTerminal', terminalId: t } })
    const dId = s().doc.cables[0].shield!.drainWireId
    const unrouted = runDrc(s().doc).filter((f) => f.ruleId === 'unrouted-wire')
    expect(unrouted.some((f) => f.refs.some((r) => r.id === dId))).toBe(false)
  })

  it('a record core named drain supplies the drain gauge and colour; undo removes the drain', () => {
    twoConnectors()
    const t = s().addFreeTerminal({ x: 0, y: 0 })
    const rec: LibraryPart = {
      ...can,
      cable: {
        cores: [...can.cable!.cores, { name: 'drain', color: 'YE', gauge: { value: 0.22, unit: 'mm2' } }],
        shield: { drain: true }
      }
    }
    const before = s().doc.wires.length
    s().addCableFromPart(rec, 'CAN-1', both, { end: 'b', to: { type: 'freeTerminal', terminalId: t } })
    const dw = s().doc.wires.find((w) => w.id === s().doc.cables[0].shield!.drainWireId)!
    expect(dw.color.base).toBe('YE')
    expect(dw.gauge.value).toBe(0.22)
    s().undo()
    expect(s().doc.wires).toHaveLength(before)
    expect(s().doc.cables).toHaveLength(0)
  })
})
