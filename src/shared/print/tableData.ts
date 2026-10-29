/**
 * Table data adapters: HarnessDocument → display rows for the BOM / Wiring
 * Table / Cutlist pages, the per-connector pinout tables and the sheet's
 * length-tolerance block. Pure data → Row[]
 * mapping; no SVG here (see tables.ts for rendering, drawingSet.ts for layout).
 */
import type {
  HarnessDocument,
  Id,
  Gauge,
  Endpoint,
  Wire,
  Cable,
  LengthToleranceBand,
  ToleranceTable
} from '../model/schema'
import { DEFAULT_TOLERANCE_TITLE } from '../model/schema'
import { fitColumns, tableWidth, TABLE_STYLE_SHEET, type Column, type Row } from './tables'
import { estimateTextWidthMm } from './text'
import { colorName } from '../model/colors'
import {
  computeBom,
  computeCutList,
  sleevePieces,
  wireRefIndex,
  type BomLine,
  type CutRow
} from '../export/bom'
import { describeEndpoint, describeSleeving } from '../model/describe'
import { sortedCavities, natCompare } from '../model/anchors'

export interface TableSpec {
  cols: Column[]
  rows: Row[]
}

export interface ConnectorPinout {
  nodeId: Id
  designator: string
  table: TableSpec
}

// ─────────────────────────────── helpers ────────────────────────────────

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** `${value} mm²` for mm2 gauges (display-superscript), `${value} AWG` otherwise. */
function formatSize(g: Gauge): string {
  return g.unit === 'mm2' ? `${g.value} mm²` : `${g.value} AWG`
}

/** `${round} mm`, `—` if unknown, `*` suffix if the length was a manual override. */
function formatLength(mm: number | null, source: CutRow['lengthSource']): string {
  if (mm == null) return '—'
  const rounded = Math.round(mm)
  return source === 'specified' ? `${rounded} mm*` : `${rounded} mm`
}

/** Cut-list refs (W1, W3, …) of the other wires sharing a Twist with `wireId`. */
function twistedWithRefs(doc: HarnessDocument, wireId: Id, wireIdx: Map<Id, string>): string {
  const otherIds = doc.twists
    .filter((t) => t.wireIds.includes(wireId))
    .flatMap((t) => t.wireIds)
    .filter((id) => id !== wireId)
  return [...new Set(otherIds)].map((id) => wireIdx.get(id) ?? id).join(', ')
}

/** The other cores of `cable` sharing `w.corePair`, as `cable.core`. */
function pairedCores(cable: Cable, w: Wire, wireById: Map<Id, Wire>): string {
  return cable.coreWireIds
    .map((id) => wireById.get(id))
    .filter((o): o is Wire => !!o && o.id !== w.id && o.cableId === cable.id && o.corePair === w.corePair)
    .map((o) => `${cable.name}.${o.coreName ?? colorName(o.color.base)}`)
    .join(', ')
}

// ───────────────────────────────── BOM ──────────────────────────────────

const BOM_PAGE_COLS: Column[] = [
  { key: 'id', title: 'Id', wMm: 12 },
  { key: 'type', title: 'Type', wMm: 28 },
  { key: 'manufacturer', title: 'Manufacturer', wMm: 40 },
  { key: 'partNumber', title: 'Part Number', wMm: 60 },
  { key: 'description', title: 'Description', wMm: 150 },
  { key: 'quantity', title: 'Quantity', wMm: 30, align: 'end' },
  { key: 'usage', title: 'Usage', wMm: 80 }
]

const BOM_SHEET_COLS: Column[] = [
  { key: 'id', title: 'Id', wMm: 10 },
  { key: 'type', title: 'Type', wMm: 22 },
  { key: 'manufacturer', title: 'Manufacturer', wMm: 30 },
  { key: 'partNumber', title: 'Part Number', wMm: 45 },
  { key: 'quantity', title: 'Quantity', wMm: 22, align: 'end' }
]

/**
 * `'2'` for `ea`; `'350 mm'` / `'≥ 350 mm'` (partial) for `m`; `'—'` if length
 * unknown; `'2 × 160 mm'` for sleeving, which is cut pieces.
 */
export function bomQuantity(l: BomLine): string {
  if (l.unit === 'ea') return String(l.quantity)
  // Sleeving is cut pieces: how many, of what length.
  if (l.pieceLengthMm !== undefined) return `${l.quantity} × ${l.pieceLengthMm == null ? '—' : `${l.pieceLengthMm} mm`}`
  if (l.lengthMm == null) return '—'
  const mm = Math.round(l.lengthMm)
  return l.partialLength ? `≥ ${mm} mm` : `${mm} mm`
}

/** Where a BOM line is consumed, for the page BOM's Usage column. */
function bomUsage(doc: HarnessDocument, line: BomLine, wireIdx: Map<Id, string>): string {
  switch (line.category) {
    case 'connector housing':
      return doc.connectors
        .filter((c) => c.housing?.partNumber === line.partNumber)
        .map((c) => c.designator)
        .join(', ')
    case 'pin':
      return 'See Wiring Table'
    case 'wire':
      return doc.wires
        .filter((w) => w.cableId == null && w.spec?.partNumber === line.partNumber)
        .map((w) => wireIdx.get(w.id) ?? '')
        .join(', ')
    case 'cable':
      return doc.cables
        .filter((c) => c.part?.partNumber === line.partNumber)
        .map((c) => c.name)
        .join(', ')
    case 'splice':
      return doc.splices
        .filter((s) => s.part?.partNumber === line.partNumber)
        .map((s) => s.designator)
        .join(', ')
    case 'free terminal':
      return doc.freeTerminals
        .filter((t) => t.part?.partNumber === line.partNumber)
        .map((t) => t.designator)
        .join(', ')
    case 'sleeving':
      return line.pieceRefs?.join(', ') ?? ''
    case 'loom tape':
    case 'branch tie':
      return 'See Drawing'
    default:
      return ''
  }
}

function bomRows(doc: HarnessDocument): Row[] {
  const lines = computeBom(doc)
  const wireIdx = wireRefIndex(doc)
  return lines.map((l) => ({
    id: String(l.item),
    type: capitalize(l.category),
    manufacturer: l.manufacturer ?? '',
    // A sleeve with no part is listed by its description (`computeBom`); the
    // sheet BOM has no Description column, so the Part Number cell says it.
    partNumber: l.partNumber || (l.description ?? ''),
    description: l.description ?? '',
    quantity: bomQuantity(l),
    usage: bomUsage(doc, l, wireIdx)
  }))
}

/** Sheet-corner BOM: Id | Type | Manufacturer | Part Number | Quantity. */
export function bomSheetTable(doc: HarnessDocument): TableSpec {
  return { cols: BOM_SHEET_COLS, rows: bomRows(doc) }
}

/** Full-page BOM: adds Description and Usage columns to the sheet BOM. */
export function bomPageTable(doc: HarnessDocument): TableSpec {
  return { cols: BOM_PAGE_COLS, rows: bomRows(doc) }
}

// ─────────────────────────────── Wiring ─────────────────────────────────

const WIRING_COLS: Column[] = [
  { key: 'from', title: 'From', wMm: 25 },
  { key: 'to', title: 'To', wMm: 25 },
  { key: 'conductor', title: 'Conductor', wMm: 45 },
  { key: 'conductorPn', title: 'Conductor PN', wMm: 55 },
  { key: 'twistedWith', title: 'Twisted With', wMm: 40 },
  { key: 'size', title: 'Size', wMm: 25 },
  { key: 'length', title: 'Length', wMm: 25, align: 'end' },
  { key: 'fromContactPn', title: 'From Contact PN', wMm: 50 },
  { key: 'notes', title: 'Notes', wMm: 110 }
]

/** The `pin.partNumber` of the cavity at `ends[0]`, if that end is a cavity. */
function fromContactPn(doc: HarnessDocument, end0: Endpoint): string {
  if (end0.type !== 'cavity') return ''
  const owner = doc.connectors.find((c) => c.cavities.some((cv) => cv.id === end0.cavityId))
  const cav = owner?.cavities.find((cv) => cv.id === end0.cavityId)
  return cav?.pin?.partNumber ?? ''
}

/**
 * Wiring table: one row per non-core wire, then — per cable in `doc.cables`
 * order — one row per core and the drain wire (length `with cable`: cores ship
 * inside the cable and are not cut separately, so the cut list has no row).
 *
 * Rows are joined to the cut list BY ID (`CutRow.sourceId`), not by position:
 * this walk and `computeCutList`'s happen to agree today, but nothing enforced
 * it, and a silently misaligned row would put one wire's length and contact
 * part number against another wire's endpoints.
 */
export function wiringTable(doc: HarnessDocument): TableSpec {
  const wireIdx = wireRefIndex(doc)
  const wires = doc.wires.filter((w) => w.cableId == null)
  const cutById = new Map(computeCutList(doc).map((r) => [r.sourceId, r]))
  const rows: Row[] = wires.flatMap((w) => {
    const cut = cutById.get(w.id)
    if (!cut) return []
    const ref = wireIdx.get(w.id) ?? ''
    return [{
      from: cut.from,
      to: cut.to,
      conductor: { text: `${ref}.${colorName(w.color.base)}`, swatch: w.color.base },
      conductorPn: w.spec?.partNumber ?? '',
      twistedWith: twistedWithRefs(doc, w.id, wireIdx),
      size: formatSize(w.gauge),
      length: formatLength(cut.lengthMm, cut.lengthSource),
      fromContactPn: fromContactPn(doc, w.ends[0]),
      notes: cut.notes
    }]
  })
  const wireById = new Map(doc.wires.map((w) => [w.id, w]))
  for (const cable of doc.cables) {
    const drainId = cable.shield?.drainWireId
    const members: { w: Wire; drain: boolean }[] = []
    // Only wires carrying THIS cable's id: a wire without it already printed as
    // a plain row above (a legacy drain, say) and must not print twice.
    for (const id of cable.coreWireIds) {
      const w = wireById.get(id)
      if (w && w.cableId === cable.id) members.push({ w, drain: false })
    }
    const dw = drainId ? wireById.get(drainId) : undefined
    if (dw && dw.cableId === cable.id && !cable.coreWireIds.includes(dw.id)) {
      members.push({ w: dw, drain: true })
    }
    for (const { w, drain } of members) {
      // The shield side of a drain is `from`, whichever end of the wire it is.
      const [e0, e1] = drain && w.ends[1].type === 'shield' ? [w.ends[1], w.ends[0]] : w.ends
      rows.push({
        from: describeEndpoint(doc, e0),
        to: describeEndpoint(doc, e1),
        conductor: {
          text: `${cable.name}.${drain ? 'drain' : (w.coreName ?? colorName(w.color.base))}`,
          swatch: w.color.base
        },
        conductorPn: cable.part?.partNumber ?? '',
        twistedWith: drain || !w.corePair ? '' : pairedCores(cable, w, wireById),
        size: formatSize(w.gauge),
        length: 'with cable',
        fromContactPn: fromContactPn(doc, e0),
        notes: `${drain ? 'drain' : 'core'} of ${cable.name}`
      })
    }
  }
  return { cols: WIRING_COLS, rows }
}

// ─────────────────────────────── Cutlist ────────────────────────────────

const CUTLIST_COLS: Column[] = [
  { key: 'num', title: '#', wMm: 10 },
  { key: 'type', title: 'Type', wMm: 22 },
  { key: 'ref', title: 'Reference Designator', wMm: 45 },
  { key: 'partNumber', title: 'Part Number', wMm: 60 },
  { key: 'colour', title: 'Color', wMm: 45 },
  { key: 'size', title: 'Size', wMm: 25 },
  { key: 'length', title: 'Length', wMm: 25, align: 'end' },
  { key: 'twistedWith', title: 'Twisted With', wMm: 40 },
  { key: 'notes', title: 'Notes', wMm: 128 }
]

/**
 * Cutlist: wire rows, then cable rows (in `computeCutList` order), then
 * sleeving rows. Each row is resolved from its `CutRow.sourceId` — the row's
 * KIND comes from which collection owns that id, not from where the row sits
 * in the list, so a change to either walk can no longer relabel a cable as a
 * wire (or read a gauge off the wrong entity). `num` stays positional: it is a
 * display line number, not an identity.
 */
export function cutlistTable(doc: HarnessDocument): TableSpec {
  const wireIdx = wireRefIndex(doc)
  const wireById = new Map(doc.wires.filter((w) => w.cableId == null).map((w) => [w.id, w]))
  const cableById = new Map(doc.cables.map((c) => [c.id, c]))
  const cutRows = computeCutList(doc)

  const rows: Row[] = cutRows.map((cut, i) => {
    const w = wireById.get(cut.sourceId)
    if (w) {
      return {
        num: String(i + 1),
        type: 'Wire',
        ref: cut.ref,
        partNumber: w.spec?.partNumber ?? '',
        colour: cut.colour,
        size: formatSize(w.gauge),
        length: formatLength(cut.lengthMm, cut.lengthSource),
        twistedWith: twistedWithRefs(doc, w.id, wireIdx),
        notes: cut.notes
      }
    }
    const cab = cableById.get(cut.sourceId)
    return {
      num: String(i + 1),
      type: 'Cable',
      ref: cut.ref,
      partNumber: cab?.part?.partNumber ?? '',
      colour: cut.colour,
      size: cut.gauge,
      length: formatLength(cut.lengthMm, cut.lengthSource),
      twistedWith: '',
      notes: cut.notes
    }
  })

  // One row per cut piece: a sleeve over three limbs is three pieces to cut.
  sleevePieces(doc).forEach((p, i) => {
    rows.push({
      num: String(cutRows.length + i + 1),
      type: 'Sleeving',
      ref: p.ref,
      partNumber: p.sleeve.part?.partNumber || describeSleeving(p.sleeve),
      colour: p.sleeve.color ?? '',
      size: p.sleeve.size ?? '',
      length: formatLength(p.lengthMm, 'derived'),
      twistedWith: '',
      notes: ''
    })
  })

  return { cols: CUTLIST_COLS, rows }
}

// ────────────────────────────── Pinouts ─────────────────────────────────

const PINOUT_COLS: Column[] = [
  { key: 'from', title: 'From', wMm: 16 },
  { key: 'to', title: 'To', wMm: 16 },
  { key: 'conductor', title: 'Conductor', wMm: 34 },
  { key: 'colour', title: 'Color', wMm: 16 },
  { key: 'size', title: 'Size', wMm: 16 }
]

function pinoutRow(doc: HarnessDocument, wireIdx: Map<Id, string>, w: Wire, otherEnd: Endpoint, from: string): Row {
  const ref = wireIdx.get(w.id) ?? ''
  return {
    from,
    to: describeEndpoint(doc, otherEnd),
    conductor: { text: `${ref}.${colorName(w.color.base)}`, swatch: w.color.base },
    colour: { text: colorName(w.color.base), swatch: w.color.base },
    size: formatSize(w.gauge)
  }
}

/**
 * A pinout table on the formboard sheet: the From / To columns grow to fit
 * their longest endpoint name, so no designator is cut off with an ellipsis.
 */
const pinoutTable = (rows: Row[]): TableSpec => ({
  cols: fitColumns(PINOUT_COLS, rows, TABLE_STYLE_SHEET, ['from', 'to']),
  rows
})

/**
 * Per-connector (then per-free-terminal) pinout tables, one row per wire
 * touching each cavity/terminal — a multigraph, so a cavity with N wires
 * gets N rows, never collapsed. Only connectors/terminals with ≥1 wire
 * are included. Connectors are ordered by designator, free terminals by
 * their `describeEndpoint` label, both natural/numeric-aware (X1, X2, X10 —
 * not X1, X10, X2) via the same `natCompare` used for cavity display order.
 */
export function connectorPinouts(doc: HarnessDocument): ConnectorPinout[] {
  const wireIdx = wireRefIndex(doc)
  const result: ConnectorPinout[] = []

  const connectors = [...doc.connectors].sort((a, b) => natCompare(a.designator, b.designator))
  for (const c of connectors) {
    const rows: Row[] = []
    for (const cav of sortedCavities(c)) {
      for (const w of doc.wires) {
        const [e0, e1] = w.ends
        if (e0.type === 'cavity' && e0.cavityId === cav.id) {
          rows.push(pinoutRow(doc, wireIdx, w, e1, `${c.designator}.${cav.position}`))
        } else if (e1.type === 'cavity' && e1.cavityId === cav.id) {
          rows.push(pinoutRow(doc, wireIdx, w, e0, `${c.designator}.${cav.position}`))
        }
      }
    }
    if (rows.length > 0) {
      result.push({ nodeId: c.id, designator: c.designator, table: pinoutTable(rows) })
    }
  }

  const terminals = doc.freeTerminals
    .map((ft) => ({ ft, designator: describeEndpoint(doc, { type: 'freeTerminal' as const, terminalId: ft.id }) }))
    .sort((a, b) => natCompare(a.designator, b.designator))
  for (const { ft, designator } of terminals) {
    const rows: Row[] = []
    for (const w of doc.wires) {
      const [e0, e1] = w.ends
      if (e0.type === 'freeTerminal' && e0.terminalId === ft.id) {
        rows.push(pinoutRow(doc, wireIdx, w, e1, designator))
      } else if (e1.type === 'freeTerminal' && e1.terminalId === ft.id) {
        rows.push(pinoutRow(doc, wireIdx, w, e0, designator))
      }
    }
    if (rows.length > 0) {
      result.push({ nodeId: ft.id, designator, table: pinoutTable(rows) })
    }
  }

  return result
}

// ──────────────────────────── Length tolerance ──────────────────────────────

const TOLERANCE_COLS: Column[] = [
  { key: 'length', title: 'Length', wMm: 22 },
  { key: 'tolerance', title: 'Tolerance', wMm: 22 }
]

/** The bands shortest first; a band with no upper end (everything longer) goes last. */
export function sortedToleranceBands(bands: LengthToleranceBand[]): LengthToleranceBand[] {
  return [...bands].sort((a, b) => (a.upToMm ?? Infinity) - (b.upToMm ?? Infinity))
}

/** A tolerance or length figure, to 2 decimals at most: `25`, `0.5`. */
const figure = (v: number): string => String(Math.round(v * 100) / 100)

/** `± 5 mm` when both ways are equal, else `+25 / −0 mm`. */
export function formatTolerance(b: LengthToleranceBand): string {
  return b.plus === b.minus
    ? `± ${figure(b.plus)} ${b.unit}`
    : `+${figure(b.plus)} / −${figure(b.minus)} ${b.unit}`
}

/** The length range a band covers, given the upper end of the band before it. */
function bandRange(b: LengthToleranceBand, from: number | undefined): string {
  if (b.upToMm === undefined) return from === undefined ? 'All lengths' : `> ${figure(from)} mm`
  return from === undefined ? `≤ ${figure(b.upToMm)} mm` : `> ${figure(from)} to ${figure(b.upToMm)} mm`
}

/**
 * The sheet's length-tolerance block: Length | Tolerance, one row per band,
 * shortest first. The Tolerance column also widens until the banner title
 * fits, since `renderTable` draws the title unclipped across the table.
 */
export function toleranceSheetTable(table: ToleranceTable): TableSpec {
  let from: number | undefined
  const rows: Row[] = sortedToleranceBands(table.bands).map((b) => {
    const row = { length: bandRange(b, from), tolerance: formatTolerance(b) }
    from = b.upToMm ?? from
    return row
  })
  const style = TABLE_STYLE_SHEET
  const cols = fitColumns(TOLERANCE_COLS, rows, style, ['length', 'tolerance'])
  // The banner is bold at 1.15× the body size; +10 % for the bold glyphs, +1 mm slack as in fitColumns.
  const title = table.title ?? DEFAULT_TOLERANCE_TITLE
  const short = estimateTextWidthMm(title, style.fontMm * 1.15) * 1.1 + 2 * style.pad + 1 - tableWidth(cols)
  if (short <= 0) return { cols, rows }
  return {
    cols: cols.map((c) => (c.key === 'tolerance' ? { ...c, wMm: Math.ceil((c.wMm + short) * 2) / 2 } : c)),
    rows
  }
}
