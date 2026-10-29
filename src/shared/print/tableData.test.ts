import { describe, it, expect } from 'vitest'
import { demoDocument, emptyDocument } from '../model/document'
import {
  bomPageTable,
  bomSheetTable,
  wiringTable,
  cutlistTable,
  connectorPinouts,
  bomQuantity,
  toleranceSheetTable
} from './tableData'
import { computeCutList, cutListToCsv } from '../export/bom'
import type { Wire } from '../model/schema'
import { IPC_620_LENGTH_TOLERANCE } from '../model/schema'
import { colorName } from '../model/colors'
import { estimateTextWidthMm, fitText } from './text'
import { TABLE_STYLE_SHEET, tableWidth } from './tables'

describe('tableData on the demo harness', () => {
  const doc = demoDocument()
  it('wiring table has one row per non-core wire with swatch, size and length', () => {
    const t = wiringTable(doc)
    const wires = doc.wires.filter((w) => w.cableId == null)
    expect(t.rows.length).toBe(wires.length)
    const c = t.rows[0].conductor as { text: string; swatch?: string }
    expect(c.swatch).toBe(wires[0].color.base)
    expect(c.text).toMatch(/^W1\./)
    expect(String(t.rows[0].length)).toMatch(/mm$|^—$/)
  })
  it('cutlist mirrors computeCutList order and adds sleeving rows', () => {
    const t = cutlistTable(doc)
    const cut = computeCutList(doc)
    expect(t.rows.slice(0, cut.length).map((r) => r.ref)).toEqual(cut.map((r) => r.ref))
    expect(t.rows.length).toBe(cut.length + doc.sleeving.length)
  })
  it('connector pinouts: one per connector/terminal with wires, rows per wire (multigraph kept)', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', cavities: [{ id: 'a', position: '1', status: 'populated' }] }]
    d.freeTerminals = [{ id: 't1', designator: 'T1', kind: 'ring', landsOn: 'B+' }, { id: 't2', designator: 'T2', kind: 'ring' }]
    // Brief's snippet types `ends` as a readonly tuple via `as const`, which tsc
    // rejects against `Wire['ends']` ([Endpoint, Endpoint], mutable) — cast to
    // Wire so this compiles under `npm run typecheck` too (Vitest alone doesn't
    // type-check, so this only surfaced there).
    const w = (id: string, to: string): Wire =>
      ({
        id,
        ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'freeTerminal', terminalId: to }],
        gauge: { value: 1.5, unit: 'mm2' },
        color: { base: 'RD' }
      }) as Wire
    d.wires = [w('w1', 't1'), w('w2', 't1')]
    const p = connectorPinouts(d)
    expect(p.map((x) => x.designator)).toEqual(['X1', 'T1 ring → B+'])   // t2 has no wire → omitted
    expect(p[0].table.rows.length).toBe(2)
    expect(p[0].table.rows[0].from).toBe('X1.1')
    const conductor = p[0].table.rows[0].conductor as { text: string; swatch?: string }
    expect(conductor.swatch).toBe('RD')
    expect(conductor.text).toMatch(/^W\d+\./)
  })
  it('pinout From / To columns widen to fit their longest text, never narrower than the default', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c1', designator: 'X1', cavities: [{ id: 'a', position: '1', status: 'populated' }] }]
    d.freeTerminals = [{ id: 't1', designator: 'T1', kind: 'ring', landsOn: 'Battery B+ main stud' }]
    d.wires = [{ id: 'w1', ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'freeTerminal', terminalId: 't1' }], gauge: { value: 1.5, unit: 'mm2' }, color: { base: 'RD' } } as Wire]
    const [x1, t1] = connectorPinouts(d)
    const width = (p: typeof x1, key: string): number => p.table.cols.find((c) => c.key === key)!.wMm
    const need = (text: string): number => estimateTextWidthMm(text, TABLE_STYLE_SHEET.fontMm) + 2 * TABLE_STYLE_SHEET.pad
    const long = x1.table.rows[0].to as string
    expect(long.length).toBeGreaterThan(12)
    // X1's To cell is the long terminal name; T1's From cell is the same text.
    expect(width(x1, 'to')).toBeGreaterThanOrEqual(need(long))
    expect(width(t1, 'from')).toBeGreaterThanOrEqual(need(long))
    expect(fitText(long, TABLE_STYLE_SHEET.fontMm, width(x1, 'to') - 2 * TABLE_STYLE_SHEET.pad)).toBe(long)
    // A short column keeps its default width.
    expect(width(x1, 'from')).toBe(16)
    // Only From / To move.
    expect(width(x1, 'conductor')).toBe(34)
  })
  it('connector pinouts are ordered by designator naturally (X1, X2, X10 — not X1, X10, X2)', () => {
    const d = emptyDocument()
    const conn = (id: string, designator: string): (typeof d.connectors)[number] => ({
      id,
      designator,
      cavities: [{ id: `${id}-a`, position: '1', status: 'populated' }]
    })
    d.connectors = [conn('c10', 'X10'), conn('c2', 'X2'), conn('c1', 'X1')]
    d.wires = ['c10', 'c2', 'c1'].map(
      (id) =>
        ({
          id: `w-${id}`,
          ends: [{ type: 'cavity', cavityId: `${id}-a` }, { type: 'freeTerminal', terminalId: 'nowhere' }],
          gauge: { value: 1.5, unit: 'mm2' },
          color: { base: 'RD' }
        }) as Wire
    )
    const p = connectorPinouts(d)
    expect(p.map((x) => x.designator)).toEqual(['X1', 'X2', 'X10'])
  })
  it('bomQuantity formats ea / m / partial / unknown', () => {
    const base = { item: 1, category: 'wire' as const, partNumber: 'p', quantity: 2 }
    expect(bomQuantity({ ...base, unit: 'ea', lengthMm: null, partialLength: false })).toBe('2')
    expect(bomQuantity({ ...base, unit: 'm', lengthMm: 349.6, partialLength: false })).toBe('350 mm')
    expect(bomQuantity({ ...base, unit: 'm', lengthMm: 100, partialLength: true })).toBe('≥ 100 mm')
    expect(bomQuantity({ ...base, unit: 'm', lengthMm: null, partialLength: false })).toBe('—')
  })
  it('BOM page has Usage and Description columns, sheet BOM does not', () => {
    expect(bomPageTable(doc).cols.map((c) => c.key)).toEqual(['id', 'type', 'manufacturer', 'partNumber', 'description', 'quantity', 'usage'])
    expect(bomSheetTable(doc).cols.map((c) => c.key)).toEqual(['id', 'type', 'manufacturer', 'partNumber', 'quantity'])
    // NOTE: the brief's fixture assumption `bomPageTable(doc).rows[0].id === '1'`
    // does not hold against the real demoDocument() — none of its connectors,
    // cavities, or wires carry a PartRef, so computeBom(doc) is []. Covered
    // instead below against a doc that actually has parts (when a
    // fixture assumption is wrong, fix the test, not the adapter).
    expect(bomPageTable(doc).rows).toEqual([])
  })
  it('BOM row numbering, Type capitalisation, and Usage are 1-based / derived', () => {
    const d = emptyDocument()
    d.connectors = [
      {
        id: 'c1',
        designator: 'X1',
        housing: { partNumber: 'HSG-1' },
        cavities: [{ id: 'a', position: '1', status: 'populated' }]
      }
    ]
    d.wires = [
      {
        id: 'w1',
        ends: [{ type: 'cavity', cavityId: 'a' }, { type: 'freeTerminal', terminalId: 't1' }],
        gauge: { value: 1.5, unit: 'mm2' },
        color: { base: 'RD' },
        spec: { partNumber: 'WIRE-1' }
      }
    ]
    d.freeTerminals = [{ id: 't1', designator: 'T1', kind: 'ring' }]
    const rows = bomPageTable(d).rows
    expect(rows.map((r) => r.id)).toEqual(['1', '2'])
    expect(rows[0].type).toBe('Connector housing')
    expect(rows[0].usage).toBe('X1')
    expect(rows[1].type).toBe('Wire')
    expect(rows[1].usage).toBe('W1')
  })
})

describe('BOM Usage lists splice and terminal designators like connectors', () => {
  it('splice and free-terminal lines name their designators', () => {
    const d = emptyDocument()
    d.splices = [
      { id: 's1', designator: 'SP1', kind: 'butt', part: { partNumber: 'SPL-A' } },
      { id: 's2', designator: 'SP2', kind: 'butt', part: { partNumber: 'SPL-A' } }
    ]
    d.freeTerminals = [
      { id: 't1', designator: 'T1', kind: 'ring', part: { partNumber: 'RING-A' } },
      { id: 't2', designator: 'T2', kind: 'ring', part: { partNumber: 'RING-A' } }
    ]
    const rows = bomPageTable(d).rows
    expect(rows.find((r) => r.type === 'Splice')?.usage).toBe('SP1, SP2')
    expect(rows.find((r) => r.type === 'Free terminal')?.usage).toBe('T1, T2')
  })
})

describe('table adapters are keyed by id, not by cut-list position', () => {
  // The adapters used to walk `doc.wires` themselves and index into
  // `computeCutList`'s output by position. Those two walks agreed, but nothing
  // made them agree; a misalignment would silently print one wire's length and
  // contact PN against another wire's endpoints. Rows now join on
  // `CutRow.sourceId`, so this holds for ANY document order.
  const reversed = (): ReturnType<typeof demoDocument> => {
    const d = demoDocument()
    d.wires = [...d.wires].reverse()
    return d
  }

  it('every cut row carries the id of the wire or cable it was cut from', () => {
    const d = demoDocument()
    const ids = new Set([...d.wires.map((w) => w.id), ...d.cables.map((c) => c.id)])
    const rows = computeCutList(d)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect({ ref: r.ref, known: ids.has(r.sourceId) }).toEqual({ ref: r.ref, known: true })
  })

  it('each wiring row keeps its OWN wire size and conductor PN when doc.wires is reversed', () => {
    const d = reversed()
    const wires = d.wires.filter((w) => w.cableId == null)
    const rows = wiringTable(d).rows
    expect(rows.length).toBe(wires.length)
    wires.forEach((w, i) => {
      const expected = w.gauge.unit === 'mm2' ? `${w.gauge.value} mm²` : `${w.gauge.value} AWG`
      expect({ id: w.id, size: rows[i].size, pn: rows[i].conductorPn }).toEqual({
        id: w.id,
        size: expected,
        pn: w.spec?.partNumber ?? ''
      })
    })
  })

  it('cutlist row kind and size follow the row\'s own entity, not its index', () => {
    const d = reversed()
    const byId = new Map(d.wires.map((w) => [w.id, w]))
    const cut = computeCutList(d)
    const rows = cutlistTable(d).rows
    cut.forEach((c, i) => {
      const w = byId.get(c.sourceId)
      expect({ ref: c.ref, type: rows[i].type }).toEqual({ ref: c.ref, type: w ? 'Wire' : 'Cable' })
      if (w) {
        const expected = w.gauge.unit === 'mm2' ? `${w.gauge.value} mm²` : `${w.gauge.value} AWG`
        expect({ ref: c.ref, size: rows[i].size }).toEqual({ ref: c.ref, size: expected })
      }
    })
  })

  it('the CSV columns are unchanged — sourceId is an in-memory join key only', () => {
    const header = cutListToCsv(computeCutList(demoDocument())).split('\n')[0]
    expect(header).toBe('ref,from,to,gauge,colour,lengthMm,lengthSource,notes,addLengthMm')
    expect(header).not.toContain('sourceId')
  })
})

describe('wiringTable: cable cores and drains', () => {
  function cabled() {
    const d = emptyDocument()
    for (const id of ['X1', 'X2'])
      d.connectors.push({
        id,
        designator: id,
        cavities: [
          { id: `${id}-1`, position: '1', status: 'populated' },
          { id: `${id}-2`, position: '2', status: 'populated' },
          { id: `${id}-3`, position: '3', status: 'populated' }
        ]
      })
    const cav = (c: string) => ({ type: 'cavity' as const, cavityId: c })
    const g = { value: 0.5, unit: 'mm2' as const }
    const plain = {
      id: 'wp',
      ends: [cav('X1-3'), cav('X2-3')],
      gauge: g,
      color: { base: 'RD' }
    } as Wire
    const core = (id: string, a: string, b: string, color: string) =>
      ({ id, ends: [cav(a), cav(b)], gauge: g, color: { base: color }, cableId: 'cab' }) as Wire
    const drain = {
      id: 'wd',
      ends: [cav('X2-3'), { type: 'shield', cableId: 'cab', end: 'b' }],
      gauge: g,
      color: { base: 'BK' },
      cableId: 'cab'
    } as Wire
    d.wires = [core('w1', 'X1-1', 'X2-1', 'WH'), plain, core('w2', 'X1-2', 'X2-2', 'GN'), drain]
    d.cables = [
      {
        id: 'cab',
        name: 'CAN-1',
        part: { partNumber: 'MCB-0001' },
        coreWireIds: ['w1', 'w2'],
        shield: { present: true, drainWireId: 'wd' }
      }
    ]
    return d
  }

  it('appends core rows then the drain after the plain-wire rows, cut list unchanged', () => {
    const d = cabled()
    const t = wiringTable(d)
    expect(t.rows).toHaveLength(4)
    expect(t.rows[0].from).toBe('X1.3')
    const [c1, c2, dr] = t.rows.slice(1)
    expect(c1).toMatchObject({
      from: 'X1.1', to: 'X2.1', conductorPn: 'MCB-0001', size: '0.5 mm²',
      length: 'with cable', twistedWith: '', fromContactPn: '', notes: 'core of CAN-1'
    })
    expect(c1.conductor).toEqual({ text: `CAN-1.${colorName('WH')}`, swatch: 'WH' })
    expect(c2.conductor).toEqual({ text: `CAN-1.${colorName('GN')}`, swatch: 'GN' })
    // drain: shield side is always `from`, even though the shield is ends[1]
    expect(dr).toMatchObject({ from: 'CAN-1 shield b', to: 'X2.3', length: 'with cable', notes: 'drain of CAN-1' })
    expect(computeCutList(d).map((r) => r.sourceId)).not.toContain('w1')
  })

  it('removing one core wire drops exactly that row', () => {
    const d = cabled()
    d.wires = d.wires.filter((w) => w.id !== 'w2')
    d.cables[0].coreWireIds = ['w1']
    const t = wiringTable(d)
    expect(t.rows.map((r) => r.notes)).toEqual([expect.anything(), 'core of CAN-1', 'drain of CAN-1'])
  })

  it('a document without cables is unchanged', () => {
    const d = cabled()
    d.wires = d.wires.filter((w) => w.cableId == null)
    d.cables = []
    expect(wiringTable(d).rows).toEqual([
      {
        from: 'X1.3',
        to: 'X2.3',
        conductor: { text: `W1.${colorName('RD')}`, swatch: 'RD' },
        conductorPn: '',
        twistedWith: '',
        size: '0.5 mm²',
        length: expect.any(String),
        fromContactPn: '',
        notes: ''
      }
    ])
  })

  it('a legacy drain (no cableId) prints once, as its plain row', () => {
    const d = cabled()
    delete d.wires.find((w) => w.id === 'wd')!.cableId
    const t = wiringTable(d)
    expect(t.rows).toHaveLength(4)
    expect(t.rows.filter((r) => r.notes === 'drain of CAN-1')).toHaveLength(0)
    expect(t.rows.filter((r) => r.to === 'X2.3' || r.from === 'X2.3')).toHaveLength(2) // plain + legacy drain
  })

  it('a coreWireIds entry whose wire lacks cableId is not duplicated', () => {
    const d = cabled()
    delete d.wires.find((w) => w.id === 'w2')!.cableId
    d.cables[0].coreWireIds = ['w1', 'w2']
    const t = wiringTable(d)
    expect(t.rows.filter((r) => r.notes === 'core of CAN-1')).toHaveLength(1)
    expect(t.rows.filter((r) => r.from === 'X1.2')).toHaveLength(1)
  })

  it('names cores by coreName and lists same-pair cores in twistedWith', () => {
    const d = cabled()
    d.wires = d.wires.filter((w) => w.id !== 'wp')
    const set = (id: string, color: string, name: string, pair?: string) => {
      const w = d.wires.find((x) => x.id === id)!
      w.color = { base: color }
      w.coreName = name
      if (pair) w.corePair = pair
    }
    set('w1', 'BK', '1', 'A')
    set('w2', 'BK', '2', 'B')
    let [c1, c2, dr] = wiringTable(d).rows
    expect(c1.conductor).toEqual({ text: 'CAN-1.1', swatch: 'BK' })
    expect(c2.conductor).toEqual({ text: 'CAN-1.2', swatch: 'BK' })
    expect(c1.twistedWith).toBe('')
    expect(c2.twistedWith).toBe('')
    expect(dr.conductor).toMatchObject({ text: 'CAN-1.drain' })
    d.wires.find((x) => x.id === 'w2')!.corePair = 'A'
    ;[c1, c2] = wiringTable(d).rows
    expect(c1.twistedWith).toBe('CAN-1.2')
    expect(c2.twistedWith).toBe('CAN-1.1')
  })
})

describe('toleranceSheetTable', () => {
  it('lists the IPC/WHMA-A-620 bands shortest first, each with the range it covers', () => {
    const spec = toleranceSheetTable({ bands: IPC_620_LENGTH_TOLERANCE })
    expect(spec.cols.map((c) => c.key)).toEqual(['length', 'tolerance'])
    expect(spec.rows).toEqual([
      { length: '≤ 300 mm', tolerance: '+25 / −0 mm' },
      { length: '> 300 to 1500 mm', tolerance: '+50 / −0 mm' },
      { length: '> 1500 to 3000 mm', tolerance: '+100 / −0 mm' },
      { length: '> 3000 to 7500 mm', tolerance: '+150 / −0 mm' },
      { length: '> 7500 mm', tolerance: '+5 / −0 %' }
    ])
  })

  it('sorts the bands, writes ± for an even tolerance, and names a lone open band "All lengths"', () => {
    const spec = toleranceSheetTable({
      bands: [
        { plus: 2.5, minus: 2.5, unit: '%' },
        { upToMm: 500, plus: 10, minus: 10, unit: 'mm' }
      ]
    })
    expect(spec.rows).toEqual([
      { length: '≤ 500 mm', tolerance: '± 10 mm' },
      { length: '> 500 mm', tolerance: '± 2.5 %' }
    ])
    expect(toleranceSheetTable({ bands: [{ plus: 1, minus: 0, unit: '%' }] }).rows[0].length).toBe('All lengths')
  })

  it('widens the Tolerance column until the banner title fits', () => {
    const bands = [{ upToMm: 500, plus: 10, minus: 10, unit: 'mm' as const }]
    const title = 'Length tolerance, all wires and cables, unless the drawing says otherwise'
    const narrow = tableWidth(toleranceSheetTable({ title: 'T', bands }).cols)
    const wide = toleranceSheetTable({ title, bands }).cols
    expect(tableWidth(wide)).toBeGreaterThan(narrow)
    expect(tableWidth(wide)).toBeGreaterThan(estimateTextWidthMm(title, TABLE_STYLE_SHEET.fontMm * 1.15))
    expect(wide[0].wMm).toBe(toleranceSheetTable({ title: 'T', bands }).cols[0].wMm)
  })
})

describe('sleeving in the BOM and cut list', () => {
  /** The demo with two PVC 5mm BK sleeves on its first wire's run and one with a library part. */
  function sleeved(): ReturnType<typeof demoDocument> {
    const d = demoDocument()
    const span = { segmentIds: [d.segments[0].id] }
    const target = { type: 'wire' as const, wireId: d.wires[0].id }
    d.sleeving = [
      { id: 'a', target, span, sleevingType: 'pvc', size: '5mm', color: 'BK' },
      { id: 'b', target, span, sleevingType: 'heatshrink', part: { partNumber: 'HS-6', manufacturer: 'TE' } },
      { id: 'c', target, span, sleevingType: 'pvc', size: '5mm', color: 'BK' }
    ]
    return d
  }

  it('the sheet BOM lists pieces as count × length, naming one with no part by its description; Usage names them', () => {
    const d = sleeved()
    const sheet = bomSheetTable(d).rows.filter((r) => r.type === 'Sleeving')
    expect(sheet.map((r) => [r.partNumber, r.manufacturer, r.quantity])).toEqual([
      ['PVC tube 5mm BK', '', '2 × 320 mm'],
      ['HS-6', 'TE', '1 × 320 mm']
    ])
    const page = bomPageTable(d).rows.filter((r) => r.type === 'Sleeving')
    expect(page.map((r) => r.usage)).toEqual(['SL1, SL3', 'SL2'])
    expect(page[0].description).toBe('PVC tube 5mm BK')
  })

  it('the cut list describes a sleeve the same way', () => {
    const rows = cutlistTable(sleeved()).rows.filter((r) => r.type === 'Sleeving')
    expect(rows.map((r) => [r.ref, r.partNumber])).toEqual([
      ['SL1', 'PVC tube 5mm BK'],
      ['SL2', 'HS-6'],
      ['SL3', 'PVC tube 5mm BK']
    ])
  })
})
