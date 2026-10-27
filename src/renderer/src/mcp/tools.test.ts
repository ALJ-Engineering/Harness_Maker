import { describe, it, expect, beforeEach, vi } from 'vitest'
import { emptyDocument } from '@shared/model/document'
import type { HarnessDocument } from '@shared/model/schema'
import { parseDocument } from '@shared/model/serialize'
import { newLibraryPart, type LibraryPart } from '@shared/parts/librarySchema'
import { LibraryCatalog } from '@shared/parts/catalog'
import { sanitisePartNumber } from '@shared/parts/images'
import type { EntityRef } from '@shared/drc'
import type { ToolOutcome } from '@shared/mcp'
import { useHarnessStore } from '../store'
import { full } from '../../../cli/testLibrary'
import type { LibraryContext } from '../../../cli/libraryContext'
import { runTool, type ToolContext } from './tools'

const s = () => useHarnessStore.getState()
const mm05 = { value: 0.5, unit: 'mm2' as const }

function connector(pn: string, positions: string[]): LibraryPart {
  const c = full(newLibraryPart('connector', pn))
  c.connector = { cavities: positions.map((position) => ({ position, defaultPin: 'PIN-1' })) }
  return c
}

/** An in-memory library: every part complete, every one with a datasheet. */
function memLibrary(parts: LibraryPart[]): LibraryContext {
  return {
    dir: 'mem',
    catalog: new LibraryCatalog(parts),
    datasheets: new Set(parts.map((p) => sanitisePartNumber(p.partNumber))),
    errors: []
  }
}

const wire = full(newLibraryPart('wire', 'W-05'))
wire.wire = { gauge: mm05 }
const LIB = memLibrary([connector('HSG-4', ['1', '2', '3', '4']), full(newLibraryPart('pin', 'PIN-1')), wire])

let selected: EntityRef[]
let saved: { path: string; text: string }[]
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    library: async () => LIB,
    placeAt: () => ({ x: 100, y: 50 }),
    select: (ref) => (selected.push(ref), true),
    save: async (path, text) => (saved.push({ path, text }), path),
    ...over
  }
}

function pinnedEmpty(): HarnessDocument {
  const doc = emptyDocument()
  doc.drawing.sheetOrigin = { x: 0, y: 0 }
  return doc
}

beforeEach(() => {
  s().setDocument(pinnedEmpty(), '/tmp/t.harness.json')
  selected = []
  saved = []
})

const call = (name: string, args?: unknown, c = ctx()) => runTool(name, args, c)
function ok(r: ToolOutcome): any {
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join('; ')}`)
  return r.result
}
function errors(r: ToolOutcome): string[] {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.result)}`)
  return r.errors
}

const twoWired = [
  { op: 'place', kind: 'connector', partNumber: 'HSG-4' },
  { op: 'place', kind: 'connector', partNumber: 'HSG-4' },
  { op: 'wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-05', color: 'GN' }
]

describe('apply_ops', () => {
  it('runs the CLI grammar on the open document as ONE undo step', async () => {
    const before = s().doc
    const r = ok(await call('apply_ops', { ops: twoWired }))
    expect(r.summary).toEqual([
      'placed connector X1 (HSG-4)',
      'placed connector X2 (HSG-4)',
      'wired X1:1 → X2:1 GN 0.5 mm2 (W-05)'
    ])
    expect(s().doc.connectors.map((c) => c.designator)).toEqual(['X1', 'X2'])
    expect(s().past).toEqual([before])
    expect(s().dirty).toBe(true)
    expect(s().filePath).toBe('/tmp/t.harness.json')
    s().undo()
    expect(s().doc).toBe(before)
  })

  it('places new bodies at the context position', async () => {
    ok(await call('apply_ops', { ops: twoWired.slice(0, 1) }))
    const p = s().doc.placements.find((x) => x.refId === s().doc.connectors[0].id)!
    expect(p.pos.x).toBeCloseTo(100, -2)
    expect(p.pos.y).toBeCloseTo(50, -2)
  })

  it('a refusal leaves doc, history and dirty exactly as they were (unlike the CLI, never an empty doc)', async () => {
    ok(await call('apply_ops', { ops: twoWired }))
    const snap = s()
    const e = errors(
      await call('apply_ops', {
        ops: [
          { op: 'place', kind: 'connector', partNumber: 'HSG-4' },
          { op: 'wire', from: 'X1:9', to: 'X2:1', partNumber: 'W-05', color: 'GN' }
        ]
      })
    )
    expect(e).toEqual(["op #2 (wire): X1 has no cavity '9' (positions: 1, 2, 3, 4)"])
    expect(s().doc).toBe(snap.doc)
    expect(s().past).toBe(snap.past)
    expect(s().future).toBe(snap.future)
    expect(s().dirty).toBe(snap.dirty)
  })

  it('passes the grammar shape errors through', async () => {
    expect(errors(await call('apply_ops', { ops: [{ op: 'place', kind: 'connector' }] }))).toEqual([
      "op #1 (place): missing 'partNumber'"
    ])
    expect(errors(await call('apply_ops', { ops: 'nope' }))).toEqual(["arguments: 'ops' must be an array"])
  })

  it('refuses without a parts library, and changes nothing', async () => {
    const before = s().doc
    expect(errors(await call('apply_ops', { ops: twoWired }, ctx({ library: async () => null })))[0]).toMatch(
      /no parts library folder/
    )
    expect(s().doc).toBe(before)
  })
})

describe('arguments', () => {
  it('refuses an unknown tool and unknown fields', async () => {
    expect(errors(await call('open_document'))).toEqual(["unknown tool 'open_document'"])
    expect(errors(await call('get_document', { verbose: true }))).toEqual(["arguments: unknown field 'verbose'"])
    expect(errors(await call('get_document', 'x'))).toEqual(['arguments: must be an object'])
  })
})

describe('reads', () => {
  it('get_document: file, dirty, sheet and the CLI show summary', async () => {
    ok(await call('apply_ops', { ops: twoWired }))
    const r = ok(await call('get_document'))
    expect(r).toMatchObject({
      filePath: '/tmp/t.harness.json',
      dirty: true,
      sheet: { paper: 'A3', orientation: 'landscape' },
      wireCount: 1,
      cables: [],
      bodies: [
        { designator: 'X1', kind: 'connector', partNumber: 'HSG-4' },
        { designator: 'X2', kind: 'connector', partNumber: 'HSG-4' }
      ]
    })
  })

  it('get_layout: bodies by designator, segments by id with lengths in mm', async () => {
    ok(await call('apply_ops', { ops: twoWired }))
    ok(await call('edit_layout', { ops: [{ op: 'move', node: 'X1', x: 0, y: 0 }, { op: 'move', node: 'X2', x: 300, y: 400 }] }))
    const r = ok(await call('get_layout'))
    expect(r.bodies).toEqual([
      { designator: 'X1', kind: 'connector', x: 0, y: 0 },
      { designator: 'X2', kind: 'connector', x: 300, y: 400 }
    ])
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]).toMatchObject({ wires: 1, drawnLengthMm: 500, lengthMm: 500, specifiedLengthMm: null, broken: false })
    expect([r.segments[0].from, r.segments[0].to].sort()).toEqual(['X1', 'X2'])
  })

  it('check: the CLI check result plus load notes', async () => {
    ok(await call('apply_ops', { ops: twoWired }))
    const r = ok(await call('check'))
    expect(r.wiring).toHaveLength(1)
    expect(r.incompleteParts).toEqual([])
    expect(r.notes).toEqual([])
    const noLib = ok(await call('check', {}, ctx({ library: async () => null })))
    expect(noLib.incompleteParts).toBeNull()
    expect(noLib.notes[0]).toMatch(/no parts library folder/)
  })
})

describe('edit_layout', () => {
  beforeEach(async () => {
    ok(await call('apply_ops', { ops: twoWired }))
    ok(await call('edit_layout', { ops: [{ op: 'move', node: 'X1', x: 0, y: 0 }, { op: 'move', node: 'X2', x: 400, y: 0 }] }))
  })
  const layout = async () => ok(await call('get_layout'))

  it('segment-length with fit redraws the limb, as one undo step', async () => {
    const seg = (await layout()).segments[0].id
    const before = s().past.length
    const r = ok(await call('edit_layout', { ops: [{ op: 'segment-length', segment: seg, mm: 450, fit: 'to' }] }))
    expect(r.summary[0]).toMatch(/is 450 mm; redrawn/)
    expect((await layout()).segments[0]).toMatchObject({ specifiedLengthMm: 450, drawnLengthMm: 450, broken: false })
    expect(s().past.length).toBe(before + 1)
  })

  it('branch splits a limb at its midpoint; merge needs branch points', async () => {
    const seg = (await layout()).segments[0].id
    const r = ok(await call('edit_layout', { ops: [{ op: 'branch', segment: seg }] }))
    const l = await layout()
    expect(l.branchPoints).toHaveLength(1)
    expect(l.branchPoints[0]).toMatchObject({ x: 200, y: 0 })
    expect(r.summary[0]).toContain(l.branchPoints[0].id)
    expect(l.segments).toHaveLength(2)
    expect(errors(await call('edit_layout', { ops: [{ op: 'merge', from: l.branchPoints[0].id, into: 'nope' }] }))).toEqual([
      "op #1 (merge): no branch point 'nope' (get_layout lists them)"
    ])
  })

  it('a refused op undoes the ops before it', async () => {
    const snap = s()
    const e = errors(
      await call('edit_layout', { ops: [{ op: 'move', node: 'X1', x: 10, y: 10 }, { op: 'move', node: 'X9', x: 0, y: 0 }] })
    )
    expect(e[0]).toMatch(/^op #2 \(move\): no body or branch point 'X9'/)
    expect(s().doc).toBe(snap.doc)
    expect(s().past).toBe(snap.past)
  })

  it('shape-checks like the op grammar', async () => {
    expect(errors(await call('edit_layout', { ops: [{ op: 'move', node: 'X1', x: '1', y: 0 }] }))).toEqual([
      "op #1 (move): 'x' must be a finite number"
    ])
    expect(errors(await call('edit_layout', { ops: [{ op: 'spin' }] }))[0]).toMatch(/'op' must be one of move, branch, merge, segment-length/)
    expect(errors(await call('edit_layout', { ops: [{ op: 'segment-length', segment: 's', mm: 0 }] }))[0]).toMatch(/above 0/)
  })
})

describe('set_drawing', () => {
  it('sets the sheet and patches the title block in one undo step', async () => {
    const before = s().past.length
    const r = ok(
      await call('set_drawing', {
        sheet: { paper: 'A2', orientation: 'landscape' },
        titleBlock: { title: 'Main loom', revision: 'B', drawnBy: { name: 'Agent', date: '2026-10-27' } }
      })
    )
    expect(r.summary).toEqual(['sheet A2 landscape', 'title block: title, revision, drawnBy'])
    expect(s().doc.drawing.sheet).toEqual({ paper: 'A2', orientation: 'landscape' })
    expect(s().doc.drawing.titleBlock).toMatchObject({ title: 'Main loom', revision: 'B', drawnBy: { name: 'Agent' } })
    expect(s().past.length).toBe(before + 1)
  })

  it('validates a plotter roll and refuses a length on cut paper', async () => {
    expect(errors(await call('set_drawing', { sheet: { paper: 'Plotter', orientation: 'landscape', lengthMm: 10 } }))[0]).toMatch(
      /lengthMm must be/
    )
    expect(errors(await call('set_drawing', { sheet: { paper: 'A3', orientation: 'landscape', lengthMm: 2000 } }))).toEqual([
      "sheet: lengthMm is only for paper 'Plotter'"
    ])
    expect(errors(await call('set_drawing', {}))).toEqual(['nothing to set (give sheet and/or titleBlock)'])
  })
})

describe('select', () => {
  it('resolves a designator and hands the ref to the shell', async () => {
    ok(await call('apply_ops', { ops: twoWired }))
    expect(ok(await call('select', { ref: 'X2' }))).toEqual({ selected: 'X2', kind: 'connector' })
    expect(selected).toEqual([{ kind: 'connector', id: s().doc.connectors[1].id }])
  })

  it('refuses an unknown name, and one no visible pane can draw', async () => {
    expect(errors(await call('select', { ref: 'X1' }))[0]).toMatch(/nothing named 'X1'/)
    ok(await call('apply_ops', { ops: twoWired }))
    expect(errors(await call('select', { ref: 'X1' }, ctx({ select: () => false })))[0]).toMatch(/not drawn in the visible view/)
  })
})

describe('save_document', () => {
  it('writes the document to its own path and marks it saved', async () => {
    ok(await call('apply_ops', { ops: twoWired }))
    expect(ok(await call('save_document'))).toEqual({ path: '/tmp/t.harness.json' })
    expect(saved).toHaveLength(1)
    expect(parseDocument(saved[0].text).connectors).toHaveLength(2)
    expect(s().dirty).toBe(false)
  })

  it('refuses a document that was never saved', async () => {
    s().setDocument(pinnedEmpty(), null)
    const save = vi.fn()
    expect(errors(await call('save_document', {}, ctx({ save })))[0]).toMatch(/never been saved/)
    expect(save).not.toHaveBeenCalled()
  })
})
