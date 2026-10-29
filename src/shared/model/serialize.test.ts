import { describe, it, expect } from 'vitest'
import {
  serializeDocument,
  parseDocument,
  parseDocumentWithNotes,
  DocumentParseError,
  migrateTitleBlock
} from './serialize'
import { demoDocument, emptyDocument } from './document'
import { SCHEMA_VERSION, DEFAULT_SHEET, IPC_620_LENGTH_TOLERANCE } from './schema'
import { routeConnected } from './geometry'
import { sheetMm } from '../print/sheet'

describe('schematicPos round-trip', () => {
  it('preserves Placement.schematicPos through serialize -> parse', () => {
    const d = emptyDocument()
    d.placements = [{ refId: 'c1', pos: { x: 10, y: 20 }, schematicPos: { x: 99, y: 88 } }]
    const round = parseDocument(serializeDocument(d))
    expect(round.placements[0].pos).toEqual({ x: 10, y: 20 })
    expect(round.placements[0].schematicPos).toEqual({ x: 99, y: 88 })
  })
})

describe('parseDocument structural validation', () => {
  it('backfills a missing array from the empty document', () => {
    const d = parseDocument('{"schemaVersion":"0.1.0"}')
    expect(d.wires).toEqual([])
    expect(d.connectors).toEqual([])
    expect(d.drawing.printScale).toBe(1) // drawing defaults survive
  })

  it('rejects a present-but-mistyped array field instead of crashing downstream', () => {
    expect(() => parseDocument('{"schemaVersion":"0.1.0","wires":42}')).toThrow(DocumentParseError)
    expect(() => parseDocument('{"schemaVersion":"0.1.0","connectors":null}')).toThrow(
      DocumentParseError
    )
    expect(() => parseDocument('{"schemaVersion":"0.1.0","segments":{}}')).toThrow(
      DocumentParseError
    )
  })

  it('rejects a non-object drawing', () => {
    expect(() => parseDocument('{"schemaVersion":"0.1.0","drawing":[]}')).toThrow(DocumentParseError)
    expect(() => parseDocument('{"schemaVersion":"0.1.0","drawing":7}')).toThrow(DocumentParseError)
  })

  it('still rejects a non-harness document (missing schemaVersion)', () => {
    expect(() => parseDocument('{"foo":1}')).toThrow(DocumentParseError)
  })
})

describe('Bundle.part (loom tape) persistence', () => {
  it('loads an older file whose bundles have no part field', () => {
    const doc = emptyDocument()
    const raw = JSON.parse(serializeDocument(doc))
    raw.bundles = [{ id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'] }]
    const parsed = parseDocument(JSON.stringify(raw))
    expect(parsed.bundles).toHaveLength(1)
    expect(parsed.bundles[0].part).toBeUndefined()
  })

  it('round-trips a bundle part reference', () => {
    const doc = emptyDocument()
    doc.bundles = [
      { id: 'bn1', segmentIds: ['seg1'], memberWireIds: ['w1'], part: { partNumber: 'TAPE-19' } }
    ]
    const parsed = parseDocument(serializeDocument(doc))
    expect(parsed.bundles[0].part).toEqual({ partNumber: 'TAPE-19' })
  })
})

describe('drawing.sheet migration', () => {
  it('backfills sheet from legacy sheets[0]', () => {
    const d = parseDocument('{"schemaVersion":"0.1.0","drawing":{"sheets":[{"paper":"A4","orientation":"portrait"}]}}')
    expect(d.drawing.sheet).toEqual({ paper: 'A4', orientation: 'portrait' })
  })
  it('defaults sheet to A3 landscape when neither is present', () => {
    const d = parseDocument('{"schemaVersion":"0.1.0","drawing":{}}')
    expect(d.drawing.sheet).toEqual({ paper: 'A3', orientation: 'landscape' })
  })
  it('never writes the deprecated sheets[] back', () => {
    const d = parseDocument('{"schemaVersion":"0.1.0","drawing":{"sheets":[{"paper":"A4","orientation":"portrait"}]}}')
    expect(JSON.parse(serializeDocument(d)).drawing.sheets).toBeUndefined()
    expect(JSON.parse(serializeDocument(d)).schemaVersion).toBe(SCHEMA_VERSION)
  })
  it('emptyDocument has a sheet and no sheets', () => {
    const d = emptyDocument()
    expect(d.drawing.sheet).toEqual({ paper: 'A3', orientation: 'landscape' })
    expect('sheets' in d.drawing).toBe(false)
  })
})

describe('titleBlock migration', () => {
  it('maps a legacy free-form record onto typed fields (case-insensitive, aliases)', () => {
    const tb = migrateTitleBlock({ Title: 'Loom A', part_number: 'HX-650-000', Rev: 'V5', Description: 'DCDC' })
    expect(tb).toEqual({ title: 'Loom A', partNumber: 'HX-650-000', revision: 'V5', description: 'DCDC' })
  })
  it('folds unknown legacy keys into description only when description is empty', () => {
    expect(migrateTitleBlock({ Project: 'Alpha', Customer: 'X' })).toEqual({ description: 'Project: Alpha\nCustomer: X' })
    expect(migrateTitleBlock({ Description: 'kept', Project: 'dropped' })).toEqual({ description: 'kept' })
  })
  it('passes a typed block through untouched', () => {
    const typed = { title: 'T', drawnBy: { name: 'A', date: '2026-08-27' } }
    expect(migrateTitleBlock(typed)).toEqual(typed)
  })
  it('returns undefined for absent / non-object input', () => {
    expect(migrateTitleBlock(undefined)).toBeUndefined()
    expect(migrateTitleBlock(3)).toBeUndefined()
  })
  it('round-trips a typed title block through parseDocument', () => {
    const d = emptyDocument()
    d.drawing.titleBlock = { title: 'T', qa: { name: 'Q' } }
    expect(parseDocument(serializeDocument(d)).drawing.titleBlock).toEqual({ title: 'T', qa: { name: 'Q' } })
  })
})

describe('drawing.sheet validation (item 4)', () => {
  it('resets an out-of-range paper/orientation to the default rather than trusting it', () => {
    const { doc, migrated } = parseDocumentWithNotes(
      '{"schemaVersion":"0.2.0","drawing":{"sheet":{"paper":"A9","orientation":"sideways"}}}'
    )
    expect(doc.drawing.sheet).toEqual(DEFAULT_SHEET)
    expect(migrated).toContain('drawing.sheet invalid — reset to default')
    // The whole point: sheetMm indexes a fixed table, so a bad paper size
    // used to come back `undefined` and blow up inside the print pipeline.
    expect(() => sheetMm(doc.drawing.sheet)).not.toThrow()
    expect(sheetMm(doc.drawing.sheet)).toEqual({
      wMm: 420,
      hMm: 297
    })
  })

  it('falls back per field — a good orientation survives a bad paper', () => {
    const d = parseDocument('{"schemaVersion":"0.2.0","drawing":{"sheet":{"paper":"A9","orientation":"portrait"}}}')
    expect(d.drawing.sheet).toEqual({ paper: DEFAULT_SHEET.paper, orientation: 'portrait' })
  })

  it('a sheet that is not an object at all falls back wholesale', () => {
    expect(parseDocument('{"schemaVersion":"0.2.0","drawing":{"sheet":"A3"}}').drawing.sheet).toEqual(
      DEFAULT_SHEET
    )
    expect(parseDocument('{"schemaVersion":"0.2.0","drawing":{"sheet":null}}').drawing.sheet).toEqual(
      DEFAULT_SHEET
    )
  })

  it('a valid sheet is kept verbatim and reported as nothing changed', () => {
    const { doc, migrated } = parseDocumentWithNotes(
      '{"schemaVersion":"0.2.0","drawing":{"sheet":{"paper":"A1","orientation":"portrait"}}}'
    )
    expect(doc.drawing.sheet).toEqual({ paper: 'A1', orientation: 'portrait' })
    expect(migrated).toEqual([])
  })
})

describe('A0 / plotter sheet and drawing.sheetOrigin (0.6.0)', () => {
  const load = (sheet: unknown, extra = '') =>
    parseDocumentWithNotes(JSON.stringify({ schemaVersion: '0.5.2', drawing: { sheet }, ...JSON.parse(extra || '{}') }))

  it('validateSheet repairs a bad plotter length', () => {
    for (const bad of [undefined, 0, -5, NaN, 1, 913, 5001, '2000']) {
      const { doc, migrated } = load({ paper: 'Plotter', orientation: 'landscape', lengthMm: bad })
      expect(doc.drawing.sheet).toEqual({ paper: 'Plotter', orientation: 'landscape', lengthMm: 2000 })
      expect(migrated).toContain('drawing.sheet invalid — reset to default')
    }
  })

  it('accepts A0, and Plotter at the 5000 mm limit', () => {
    expect(load({ paper: 'A0', orientation: 'portrait' }).doc.drawing.sheet).toEqual({ paper: 'A0', orientation: 'portrait' })
    const p = load({ paper: 'Plotter', orientation: 'landscape', lengthMm: 5000 })
    expect(p.doc.drawing.sheet.lengthMm).toBe(5000)
    expect(p.migrated).not.toContain('drawing.sheet invalid — reset to default')
  })

  it('accepts Plotter at the 914 mm minimum (PLOTTER_MIN_LENGTH_MM)', () => {
    const p = load({ paper: 'Plotter', orientation: 'landscape', lengthMm: 914 })
    expect(p.doc.drawing.sheet.lengthMm).toBe(914)
    expect(p.migrated).not.toContain('drawing.sheet invalid — reset to default')
  })

  it('drops lengthMm from a non-plotter sheet', () => {
    expect(load({ paper: 'A3', orientation: 'landscape', lengthMm: 3000 }).doc.drawing.sheet).toEqual({
      paper: 'A3',
      orientation: 'landscape'
    })
  })

  it('round-trips sheetOrigin, drops a malformed one, leaves an absent one absent', () => {
    const d = emptyDocument()
    d.drawing.sheetOrigin = { x: 10, y: -20 }
    expect(parseDocument(serializeDocument(d)).drawing.sheetOrigin).toEqual({ x: 10, y: -20 })

    const bad = parseDocumentWithNotes(
      '{"schemaVersion":"0.5.2","drawing":{"sheetOrigin":{"x":"a","y":1}}}'
    )
    expect(bad.doc.drawing.sheetOrigin).toBeUndefined()
    expect(bad.migrated).toContain('invalid drawing.sheetOrigin dropped')

    const none = parseDocumentWithNotes('{"schemaVersion":"0.5.2"}')
    expect('sheetOrigin' in none.doc.drawing).toBe(false)
    expect(none.migrated).not.toContain('invalid drawing.sheetOrigin dropped')
  })
})

describe('schema-version gate (item 5)', () => {
  it('refuses a file written by a FUTURE major version', () => {
    expect(() => parseDocument('{"schemaVersion":"1.0.0"}')).toThrow(DocumentParseError)
    expect(() => parseDocument('{"schemaVersion":"2.7.3"}')).toThrow(/newer/i)
  })

  it('migrates an older minor version and stamps the current one', () => {
    expect(parseDocument('{"schemaVersion":"0.1.0"}').schemaVersion).toBe('0.6.2')
    expect(SCHEMA_VERSION).toBe('0.6.2')
  })
})

describe('parseDocumentWithNotes migration notes (item 6)', () => {
  it('reports a sheet backfilled from the legacy sheets[] array', () => {
    const { doc, migrated } = parseDocumentWithNotes(
      '{"schemaVersion":"0.1.0","drawing":{"sheets":[{"paper":"A2","orientation":"portrait"}]}}'
    )
    expect(doc.drawing.sheet).toEqual({ paper: 'A2', orientation: 'portrait' })
    expect(migrated).toContain('sheet backfilled from legacy sheets[0]')
  })

  it('reports a titleBlock migrated out of a free-form record', () => {
    const { doc, migrated } = parseDocumentWithNotes(
      '{"schemaVersion":"0.1.0","drawing":{"titleBlock":{"Part number":"MH-1","Rev":"B","Customer":"Acme"}}}'
    )
    expect(doc.drawing.titleBlock?.partNumber).toBe('MH-1')
    expect(doc.drawing.titleBlock?.revision).toBe('B')
    expect(migrated).toContain('titleBlock migrated from a free-form record')
  })

  it('a typed titleBlock is not reported as migrated', () => {
    const { migrated } = parseDocumentWithNotes(
      '{"schemaVersion":"0.2.0","drawing":{"titleBlock":{"title":"T","revision":"A"}}}'
    )
    expect(migrated).toEqual([])
  })

  it('a current, clean document reports no notes at all', () => {
    expect(parseDocumentWithNotes(serializeDocument(emptyDocument())).migrated).toEqual([])
  })

  it('parseDocument stays a thin wrapper returning just the document', () => {
    const text = '{"schemaVersion":"0.1.0","drawing":{"sheets":[{"paper":"A2","orientation":"portrait"}]}}'
    expect(parseDocument(text)).toEqual(parseDocumentWithNotes(text).doc)
  })
})

describe('drawing.blocks', () => {
  it('a 0.2.0 file loads, is stamped 0.6.0 and reports no migration for blocks', () => {
    const d = emptyDocument()
    const text = serializeDocument({ ...d, schemaVersion: '0.2.0' })
    const { doc, migrated } = parseDocumentWithNotes(text)
    expect(doc.schemaVersion).toBe('0.6.2')
    expect(doc.drawing.blocks).toBeUndefined()
    expect(migrated).toEqual([])
  })
  it('keeps a valid pin and drops a stale / non-finite one with a note', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', cavities: [] }]
    d.drawing.blocks = { pinout: { c1: { x: 10, y: 20 }, ghost: { x: 1, y: 1 } }, bom: { x: 5, y: 5 } }
    const text = serializeDocument(d)
    const { doc, migrated } = parseDocumentWithNotes(text)
    expect(doc.drawing.blocks).toEqual({ pinout: { c1: { x: 10, y: 20 } }, bom: { x: 5, y: 5 } })
    expect(migrated).toContain('invalid drawing-block position dropped')
  })

  it('a FREE-TERMINAL pinout pin survives load with no migration note', () => {
    const d = demoDocument()
    const ft = d.freeTerminals[0].id
    d.drawing.blocks = { pinout: { [ft]: { x: 3, y: 4 } } }
    const { doc, migrated } = parseDocumentWithNotes(serializeDocument(d))
    expect(doc.drawing.blocks?.pinout?.[ft]).toEqual({ x: 3, y: 4 })
    expect(migrated).not.toContain('invalid drawing-block position dropped')
  })
  it('drops a bom pin with a NaN coordinate and an empty pinout map entirely', () => {
    // serializeDocument pretty-prints with a space after the colon.
    const text = serializeDocument(emptyDocument()).replace(
      '"drawing": {',
      '"drawing": {"blocks":{"bom":{"x":null,"y":3},"pinout":{}},'
    )
    const { doc, migrated } = parseDocumentWithNotes(text)
    expect(doc.drawing.blocks).toBeUndefined()
    expect(migrated).toContain('invalid drawing-block position dropped')
  })
})

describe('0.3 → 0.4 migration: body-keyed route nodes', () => {
  /** A 0.3.0 file: X1 (2 cavities, right exit) at (0,0) with two wires to lug FT at (300,0), each on its own segment. */
  function legacy(): string {
    return JSON.stringify({
      schemaVersion: '0.3.0',
      connectors: [{ id: 'x1', designator: 'X1', cavities: [{ id: 'a', position: '1', status: 'populated' }, { id: 'b', position: '2', status: 'populated' }] }],
      freeTerminals: [{ id: 'ft', kind: 'ring' }],
      splices: [], cables: [],
      wires: [
        { id: 'w1', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'freeTerminal', terminalId: 'ft' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'RD' } },
        { id: 'w2', ends: [{ type: 'freeTerminal', terminalId: 'ft' }, { type: 'cavity', cavityId: 'b' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'BK' } }
      ],
      drawing: { units: 'mm', printScale: 1, sheet: { paper: 'A3', orientation: 'landscape' } },
      placements: [{ refId: 'x1', pos: { x: 0, y: 0 }, cavityExitSide: 'right' }, { refId: 'ft', pos: { x: 300, y: 0 } }],
      branchPoints: [],
      segments: [
        { id: 's1', from: { type: 'endpoint', endpoint: { type: 'cavity', cavityId: 'a' } }, to: { type: 'endpoint', endpoint: { type: 'freeTerminal', terminalId: 'ft' } } },
        { id: 's2', from: { type: 'endpoint', endpoint: { type: 'freeTerminal', terminalId: 'ft' } }, to: { type: 'endpoint', endpoint: { type: 'cavity', cavityId: 'b' } } }
      ],
      wireRoutes: [{ wireId: 'w1', path: ['s1'] }, { wireId: 'w2', path: ['s2'] }],
      bundles: [{ id: 'bn', segmentIds: ['s1', 's2'], memberWireIds: ['w1', 'w2'] }],
      sleeving: [{ id: 'sl', target: { type: 'wire', wireId: 'w2' }, span: { segmentIds: ['s2'], startFraction: 0.2, endFraction: 0.9 }, sleevingType: 'braided' }],
      twists: [],
      labels: [{ id: 'lb', target: { type: 'branch', segmentId: 's2' }, kind: 'flag', text: 'L', pos: { x: 0, y: 0 }, anchor: { segmentId: 's2', fraction: 0.25 } }]
    })
  }

  it('re-keys segment ends to bodies and coalesces the coincident pair', () => {
    const { doc, migrated } = parseDocumentWithNotes(legacy())
    expect(doc.schemaVersion).toBe('0.6.2')
    expect(doc.segments).toEqual([{ id: 's1', from: { type: 'body', refId: 'x1' }, to: { type: 'body', refId: 'ft' } }])
    expect(doc.wireRoutes).toEqual([{ wireId: 'w1', path: ['s1'] }, { wireId: 'w2', path: ['s1'] }])
    expect(doc.bundles[0].segmentIds).toEqual(['s1'])
    expect(migrated).toContain('route nodes migrated to body keys')
    expect(migrated).toContain('coincident segments coalesced (2 → 1)')
    expect(routeConnected(doc, 'w1')).toBe(true)
    expect(routeConnected(doc, 'w2')).toBe(true)
  })

  it('mirrors fractions on a REVERSED duplicate: single-segment span and label anchor', () => {
    const { doc } = parseDocumentWithNotes(legacy())
    // s2 ran ft → x1; the survivor s1 runs x1 → ft, so f becomes 1 − f (and start/end swap).
    expect(doc.sleeving[0].span).toEqual({ segmentIds: ['s1'], startFraction: 0.1, endFraction: 0.8 })
    expect(doc.labels[0].anchor).toEqual({ segmentId: 's1', fraction: 0.75 })
    expect(doc.labels[0].target).toEqual({ type: 'branch', segmentId: 's1' })
  })

  it('leaves a MULTI-segment span alone: only a single-segment span rides its own direction', () => {
    const raw = JSON.parse(legacy())
    raw.branchPoints = [{ id: 'bp', pos: { x: 150, y: 60 } }]
    raw.segments.push({ id: 's4', from: { type: 'endpoint', endpoint: { type: 'freeTerminal', terminalId: 'ft' } }, to: { type: 'branch', branchId: 'bp' } })
    raw.twists = [{ id: 'tw', wireIds: ['w1', 'w2'], span: { segmentIds: ['s2', 's4'], startFraction: 0.2, endFraction: 0.9 } }]
    const { doc } = parseDocumentWithNotes(JSON.stringify(raw))
    // s2 collapses into the reversed survivor s1, but a span of two segments is
    // oriented by its neighbours, so its fractions must NOT be mirrored.
    expect(doc.twists[0].span).toEqual({ segmentIds: ['s1', 's4'], startFraction: 0.2, endFraction: 0.9 })
  })

  it('moves placements to the old body anchor and strips cavityExitSide', () => {
    const { doc, migrated } = parseDocumentWithNotes(legacy())
    const x1 = doc.placements.find((p) => p.refId === 'x1')!
    // Right-exit, 2 cavities: body side = max(25, 2*10+8, textW+9+8) = 28 → anchor (28, 14)
    expect(x1.pos).toEqual({ x: 28, y: 14 })
    expect('cavityExitSide' in x1).toBe(false)
    const ft = doc.placements.find((p) => p.refId === 'ft')!
    expect(ft.pos.x).toBe(300) // terminal anchor: (pos.x, pos.y + dia/2)
    expect(ft.pos.y).toBe(12.5)
    expect(migrated).toContain('placement moved to body dot centre')
    expect(migrated).toContain('cavityExitSide dropped (formboard bodies are dots)')
  })

  it('drops a segment that becomes a self-loop (two cavities of one connector)', () => {
    const raw = JSON.parse(legacy())
    raw.segments.push({ id: 's3', from: { type: 'endpoint', endpoint: { type: 'cavity', cavityId: 'a' } }, to: { type: 'endpoint', endpoint: { type: 'cavity', cavityId: 'b' } } })
    raw.wires.push({ id: 'w3', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'cavity', cavityId: 'b' }], gauge: { value: 1, unit: 'mm2' }, color: { base: 'GN' } })
    raw.wireRoutes.push({ wireId: 'w3', path: ['s3'] })
    const { doc, migrated } = parseDocumentWithNotes(JSON.stringify(raw))
    expect(doc.segments.map((s) => s.id)).toEqual(['s1'])
    expect(doc.wireRoutes.find((r) => r.wireId === 'w3')!.path).toEqual([])
    expect(migrated).toContain('self-loop segment dropped')
  })

  it('a 0.4.0 file is not touched', () => {
    const { doc } = parseDocumentWithNotes(legacy())
    const text = serializeDocument(doc)
    const again = parseDocumentWithNotes(text)
    expect(again.migrated).toEqual([])
    expect(again.doc).toEqual(doc)
  })

  it('validates blocks.picture like blocks.pinout (connector, terminal OR splice ids)', () => {
    const raw = JSON.parse(legacy())
    raw.schemaVersion = '0.4.0'
    raw.segments = []; raw.wireRoutes = []; raw.bundles = []; raw.sleeving = []; raw.labels = []
    raw.splices = [{ id: 'sp', kind: 'butt' }]
    raw.drawing.blocks = { picture: { x1: { x: 1, y: 2 }, sp: { x: 3, y: 4 }, ghost: { x: 0, y: 0 }, ft: { x: NaN, y: 1 } } }
    const { doc, migrated } = parseDocumentWithNotes(JSON.stringify(raw))
    expect(doc.drawing.blocks).toEqual({ picture: { x1: { x: 1, y: 2 }, sp: { x: 3, y: 4 } } })
    expect(migrated).toContain('invalid drawing-block position dropped')
  })
})

describe('drawing.blocks.pictureView', () => {
  /** A 0.4.x document with one connector, one free terminal and one splice. */
  function withBodies(): ReturnType<typeof emptyDocument> {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', cavities: [] }]
    d.freeTerminals = [{ id: 'ft', designator: 'T1', kind: 'ring' }]
    d.splices = [{ id: 'sp', designator: 'SP1', kind: 'butt' }]
    return d
  }

  it('round-trips a rotated + flipped picture with no migration note', () => {
    const d = withBodies()
    d.drawing.blocks = { pictureView: { c1: { rotationDeg: 90, flipH: true }, sp: { flipV: true } } }
    const { doc, migrated } = parseDocumentWithNotes(serializeDocument(d))
    expect(doc.drawing.blocks).toEqual({
      pictureView: { c1: { rotationDeg: 90, flipH: true }, sp: { flipV: true } }
    })
    expect(migrated).toEqual([])
  })

  it('normalises a stored rotation into [0, 360) without calling it a drop', () => {
    const d = withBodies()
    d.drawing.blocks = { pictureView: { ft: { rotationDeg: 450 } } }
    const { doc, migrated } = parseDocumentWithNotes(serializeDocument(d))
    expect(doc.drawing.blocks?.pictureView?.ft).toEqual({ rotationDeg: 90 })
    expect(migrated).toEqual([])
  })

  it('omits an entry that says nothing — identity is stored as absent', () => {
    const d = withBodies()
    d.drawing.blocks = { pictureView: { c1: { rotationDeg: 0, flipH: false } }, bom: { x: 1, y: 2 } }
    const { doc, migrated } = parseDocumentWithNotes(serializeDocument(d))
    expect(doc.drawing.blocks).toEqual({ bom: { x: 1, y: 2 } })
    expect(migrated).toEqual([])
  })

  it('drops an unknown body, a non-object entry and non-finite / non-boolean fields, with the note', () => {
    const d = withBodies()
    const text = serializeDocument(d).replace(
      '"drawing": {',
      '"drawing": {"blocks":{"pictureView":{' +
        '"c1":{"rotationDeg":90,"flipH":"yes"},' + // bad flip dropped, rotation kept
        '"ft":{"rotationDeg":null},' + // whole entry becomes identity ⇒ omitted
        '"sp":7,' + // not an object at all
        '"ghost":{"rotationDeg":45}' + // no such body
        '}},'
    )
    const { doc, migrated } = parseDocumentWithNotes(text)
    expect(doc.drawing.blocks).toEqual({ pictureView: { c1: { rotationDeg: 90 } } })
    expect(migrated).toContain('invalid drawing-block position dropped')
  })

  it('drops a pictureView that is not an object at all, blocks and all', () => {
    const text = serializeDocument(emptyDocument()).replace(
      '"drawing": {',
      '"drawing": {"blocks":{"pictureView":[1,2]},'
    )
    const { doc, migrated } = parseDocumentWithNotes(text)
    expect(doc.drawing.blocks).toBeUndefined()
    expect(migrated).toContain('invalid drawing-block position dropped')
  })
})

describe('designator backfill', () => {
  const file = (version: string, splices: object[], terminals: object[]) =>
    JSON.stringify({ schemaVersion: version, splices, freeTerminals: terminals })
  const NOTE = (n: number) => `designators assigned to ${n} terminals/splices`

  it('a 0.4.1 file gains designators, is stamped 0.6.0 and reports one note', () => {
    const { doc, migrated } = parseDocumentWithNotes(
      file('0.4.1', [{ id: 's1', kind: 'butt' }, { id: 's2', kind: 'butt' }], [{ id: 't1', kind: 'ring' }])
    )
    expect(doc.freeTerminals[0].designator).toBe('T1')
    expect(doc.splices.map((s) => s.designator)).toEqual(['SP1', 'SP2'])
    expect(doc.schemaVersion).toBe('0.6.2')
    expect(migrated.filter((m) => m.startsWith('designators'))).toEqual([NOTE(3)])
  })
  it('a blank designator in a 0.5.0 file is backfilled', () => {
    const { doc, migrated } = parseDocumentWithNotes(file('0.5.0', [{ id: 's1', kind: 'butt', designator: '' }], []))
    expect(doc.splices[0].designator).toBe('SP1')
    expect(migrated.filter((m) => m.startsWith('designators'))).toEqual([NOTE(1)])
  })
  it('a fully designated file reports no designator note', () => {
    const { migrated } = parseDocumentWithNotes(file('0.5.0', [{ id: 's1', kind: 'butt', designator: 'SP1' }], []))
    expect(migrated.some((m) => m.startsWith('designators'))).toBe(false)
  })
})

describe('Segment.specifiedLengthMm load validation', () => {
  const load = (v: unknown) =>
    parseDocumentWithNotes(
      JSON.stringify({
        schemaVersion: '0.6.0',
        segments: [{ id: 's', from: { type: 'body', refId: 'a' }, to: { type: 'body', refId: 'b' }, specifiedLengthMm: v }]
      })
    )
  it.each([-1, 0, 'x', null])('drops %j with a note', (bad) => {
    const { doc, migrated } = load(bad)
    expect('specifiedLengthMm' in doc.segments[0]).toBe(false)
    expect(migrated).toContain('invalid segment specifiedLengthMm dropped')
  })
  it('keeps 850', () => {
    const { doc, migrated } = load(850)
    expect(doc.segments[0].specifiedLengthMm).toBe(850)
    expect(migrated).not.toContain('invalid segment specifiedLengthMm dropped')
  })
})

describe('Segment.specifiedLengthMm persistence', () => {
  it('round-trips a typed limb length with no migration note', () => {
    const d = demoDocument()
    d.segments[0].specifiedLengthMm = 370
    const { doc, migrated } = parseDocumentWithNotes(serializeDocument(d))
    expect(doc.segments[0].specifiedLengthMm).toBe(370)
    expect(migrated).toEqual([])
  })
})

describe('drawing.toleranceTable (0.6.2)', () => {
  it('round-trips, with its pinned position, and a file without one loads without one', () => {
    const d = emptyDocument()
    d.drawing.toleranceTable = { title: 'Lengths', bands: IPC_620_LENGTH_TOLERANCE.map((b) => ({ ...b })) }
    d.drawing.blocks = { tolerance: { x: 12, y: 34 } }
    const { doc, migrated } = parseDocumentWithNotes(serializeDocument(d))
    expect(doc.drawing.toleranceTable).toEqual(d.drawing.toleranceTable)
    expect(doc.drawing.blocks).toEqual({ tolerance: { x: 12, y: 34 } })
    expect(migrated).toEqual([])
    expect(parseDocument(serializeDocument(emptyDocument())).drawing.toleranceTable).toBeUndefined()
  })

  it('drops a bad band and a blank title, not the table, with one note', () => {
    const d = emptyDocument()
    d.drawing.toleranceTable = {
      title: '  ',
      bands: [
        { upToMm: 300, plus: 25, minus: 0, unit: 'mm' },
        { upToMm: -1, plus: 5, minus: 0, unit: 'mm' },
        { plus: 5, minus: 0, unit: 'in' as 'mm' },
        { plus: 5, minus: 0, unit: '%' }
      ]
    }
    const { doc, migrated } = parseDocumentWithNotes(serializeDocument(d))
    expect(doc.drawing.toleranceTable).toEqual({
      bands: [
        { upToMm: 300, plus: 25, minus: 0, unit: 'mm' },
        { plus: 5, minus: 0, unit: '%' }
      ]
    })
    expect(migrated).toEqual(['invalid length-tolerance entry dropped'])
  })

  it('drops a table that is not an object or has no bands array, and a non-finite pin', () => {
    const text = serializeDocument(emptyDocument()).replace(
      '"drawing": {',
      '"drawing": {"toleranceTable":{"bands":"none"},"blocks":{"tolerance":{"x":null,"y":1}},'
    )
    const { doc, migrated } = parseDocumentWithNotes(text)
    expect(doc.drawing.toleranceTable).toBeUndefined()
    expect(doc.drawing.blocks).toBeUndefined()
    expect(migrated).toContain('invalid length-tolerance entry dropped')
    expect(migrated).toContain('invalid drawing-block position dropped')
  })
})
