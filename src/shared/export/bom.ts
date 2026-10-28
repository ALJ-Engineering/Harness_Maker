import type { HarnessDocument, PartRef, LabelKind, Id } from '../model/schema'
import { describeEndpoint } from '../model/describe'
import { wireLength, spanLengthMm, bundleLengthMm, type LengthSource } from '../model/geometry'
import { sortedCavities } from '../model/anchors'
import { wireLead } from '../model/leads'

/** A part category in the BOM, used to group otherwise-equal part numbers. */
export type BomCategory =
  | 'connector housing'
  | 'pin'
  | 'seal'
  | 'plug'
  | 'free terminal'
  | 'splice'
  | 'wire'
  | 'cable'
  | 'sleeving' // length-based (unit 'm')
  | 'loom tape' // bundle wrap — length-based (unit 'm')
  | 'branch tie' // discrete (unit 'ea')

/** One aggregated BOM line: a part number within a category, with a quantity. */
export interface BomLine {
  /** 1-based position in `computeBom`'s output — the BOM table's `Id` column and the
   *  `[14, 15]` in a formboard body label. Derived each time; never stored. */
  item: number
  category: BomCategory
  partNumber: string
  description?: string
  manufacturer?: string
  quantity: number // piece/occurrence count
  unit: 'ea' | 'm' // procurement unit: discrete vs sold-by-length
  lengthMm: number | null // 'ea' → null; 'm' → Σ of KNOWN contributors in mm, or null if NONE known
  partialLength: boolean // true iff lengthMm is non-null AND ≥1 contributor was unknown (Σ undercounts)
}

/** One cut-list row: a single wire (or whole cable) and its build data. */
export interface CutRow {
  /**
   * Id of the entity this row was cut from — the `Wire.id` for a wire row, the
   * `Cable.id` for a cable row. The display adapters in `print/tableData.ts`
   * key off this instead of assuming their own `doc.wires` walk lines up index-
   * for-index with `computeCutList`'s. Deliberately NOT emitted in the CSV:
   * that is a human/spreadsheet artefact, and `ref` is its identity there.
   */
  sourceId: Id
  ref: string
  from: string
  to: string
  gauge: string
  colour: string
  lengthMm: number | null
  lengthSource: LengthSource
  notes: string
  addLengthMm?: number // allowance PORTION already included in lengthMm; set only on derived rows
}

/**
 * Aggregate every PartRef in the document into BOM lines. Discrete parts carry a
 * piece/occurrence `quantity` (`unit:'ea'`); length-based parts (wire, cable,
 * sleeving) additionally aggregate a total `lengthMm` (`unit:'m'`) and flag
 * `partialLength` when some contributor's length is unknown (the shown Σ is an
 * undercount). Lines are keyed by `category|partNumber`; insertion order is
 * preserved; entities without a part reference contribute nothing.
 */
export function computeBom(doc: HarnessDocument): BomLine[] {
  const byKey = new Map<string, BomLine>()
  const unknownSeen = new Map<string, boolean>()

  // Pass `contrib` for length-based parts (sold by the metre); omit it for
  // discrete parts. A `contrib.mm` of null = an unknown-length contributor.
  const add = (category: BomCategory, ref?: PartRef, contrib?: { mm: number | null }): void => {
    if (!ref?.partNumber) return
    const key = `${category}|${ref.partNumber}`
    let line = byKey.get(key)
    if (!line) {
      line = {
        item: 0,
        category,
        partNumber: ref.partNumber,
        description: ref.description,
        manufacturer: ref.manufacturer,
        quantity: 0,
        unit: contrib === undefined ? 'ea' : 'm',
        lengthMm: null,
        partialLength: false
      }
      byKey.set(key, line)
    }
    line.quantity += 1
    if (contrib !== undefined) {
      line.unit = 'm'
      if (contrib.mm == null) unknownSeen.set(key, true)
      else line.lengthMm = (line.lengthMm ?? 0) + contrib.mm
    }
  }

  for (const c of doc.connectors) {
    add('connector housing', c.housing)
    for (const cv of sortedCavities(c)) {
      add('pin', cv.pin)
      add('seal', cv.seal)
      add('plug', cv.plug)
    }
  }
  for (const ft of doc.freeTerminals) {
    add('free terminal', ft.part)
    add('seal', ft.seal)
  }
  for (const sp of doc.splices) add('splice', sp.part)
  // Wire is sold by length; cable cores ship inside the cable, and a part's
  // factory lead ships with the part, so skip them here.
  for (const w of doc.wires) {
    if (w.cableId != null || wireLead(doc, w)) continue
    add('wire', w.spec, { mm: wireLength(doc, w.id).mm })
  }
  // A cable is one purchased assembly; its jacket cut length is the buyable length.
  for (const cab of doc.cables) add('cable', cab.part, { mm: cab.specifiedLengthMm ?? null })
  // Sleeving is length-based; branch ties are discrete consumables.
  for (const sl of doc.sleeving) add('sleeving', sl.part, { mm: spanLengthMm(doc, sl.span) })
  // Loom tape over a bundle: consumed along the bundle's whole run.
  for (const bn of doc.bundles) add('loom tape', bn.part, { mm: bundleLengthMm(doc, bn) })
  for (const bp of doc.branchPoints) add('branch tie', bp.tie)

  for (const [key, line] of byKey) {
    line.partialLength = (unknownSeen.get(key) ?? false) && line.lengthMm !== null
  }
  return [...byKey.values()].map((line, i) => ({ ...line, item: i + 1 }))
}

/**
 * BOM item numbers of every line whose part number is in `partNumbers` —
 * sorted, deduped, any category. Feeds the `C2 [14, 15]` body label: a body
 * lists its housing/part plus its contacts and seals, so several lines.
 */
export function bomItemsForParts(lines: BomLine[], partNumbers: readonly string[]): number[] {
  const wanted = new Set(partNumbers)
  const items = new Set<number>()
  for (const l of lines) if (wanted.has(l.partNumber)) items.add(l.item)
  return [...items].sort((a, b) => a - b)
}

/** Build a map from (non-core) wire id → cut-list reference string (W1, W2, …).
 *  Cable cores are excluded so the W-numbers stay contiguous with no gaps. */
export function wireRefIndex(doc: HarnessDocument): Map<Id, string> {
  const index = new Map<Id, string>()
  doc.wires.filter((w) => w.cableId == null).forEach((w, i) => index.set(w.id, `W${i + 1}`))
  return index
}

/**
 * Cut list: one row per non-core wire, plus one row per cable (its jacket cut as
 * a single piece). Cable cores are NOT separate rows — you cut the cable, not its
 * cores. A wire/cable length is null until geometry (or a manual override) gives
 * it one. For derived wire rows, `addLengthMm` shows how much of `lengthMm` is the
 * strip/termination/service-loop allowance (0 = bare routed centreline).
 */
export function computeCutList(doc: HarnessDocument): CutRow[] {
  const wireIdx = wireRefIndex(doc)
  const rows: CutRow[] = doc.wires
    .filter((w) => w.cableId == null)
    .map((w) => {
      const stripes = w.color.stripes?.length ? `/${w.color.stripes.join('/')}` : ''
      const len = wireLength(doc, w.id)
      // A factory lead is cut down from the part's own lead, not off a reel.
      const lead = wireLead(doc, w)
      const leadNote = lead
        ? `factory lead of ${lead.label}${lead.lead.lengthMm != null ? ` (${lead.lead.lengthMm} mm)` : ''}`
        : ''
      return {
        sourceId: w.id,
        ref: wireIdx.get(w.id) ?? '',
        from: describeEndpoint(doc, w.ends[0]),
        to: describeEndpoint(doc, w.ends[1]),
        gauge: `${w.gauge.value} ${w.gauge.unit}`,
        colour: `${w.color.base}${stripes}`,
        lengthMm: len.mm,
        lengthSource: len.source,
        notes: [leadNote, w.notes ?? ''].filter(Boolean).join('; '),
        addLengthMm: len.source === 'derived' ? Math.max(0, w.addLengthMm ?? 0) : undefined
      }
    })
  for (const cab of doc.cables) {
    const cores = cab.coreWireIds.length
    rows.push({
      sourceId: cab.id,
      ref: cab.name, // named entity → readable; no W-number scheme
      from: '', // jacket endpoints unmodelled (deferred) — not fabricated
      to: '',
      gauge: '', // a cable has no single Gauge
      colour: cab.jacketColor ?? '',
      lengthMm: cab.specifiedLengthMm ?? null,
      lengthSource: cab.specifiedLengthMm != null ? 'specified' : 'unknown',
      notes: `jacket: ${cores} core${cores === 1 ? '' : 's'}${cab.shield?.present ? ', shielded' : ''}`
    })
  }
  return rows
}

// ─────────────────── Treatment lines + wire marker list ─────────────────────

/** One row in the treatments section of the report. */
export interface TreatmentLine {
  kind: 'sleeving' | 'twist'
  ref: Id
  description: string
  lengthMm: number | null
  part?: string
}

/** One row in the wire-marker print list. */
export interface MarkerRow {
  wireRef: string
  text: string
  kind: LabelKind
}

/**
 * Compute treatment lines from all sleeving and twist entries in the document.
 * Length is derived from the span geometry (null if any segment is unplaced).
 */
export function computeTreatmentLines(doc: HarnessDocument): TreatmentLine[] {
  const lines: TreatmentLine[] = []

  for (const sl of doc.sleeving) {
    const description = sl.size ? `${sl.sleevingType} ${sl.size}` : sl.sleevingType
    lines.push({
      kind: 'sleeving',
      ref: sl.id,
      description,
      lengthMm: spanLengthMm(doc, sl.span),
      ...(sl.part?.partNumber ? { part: sl.part.partNumber } : {})
    })
  }

  for (const tw of doc.twists) {
    lines.push({
      kind: 'twist',
      ref: tw.id,
      description: tw.layLengthMm != null ? `twist (lay ${tw.layLengthMm} mm)` : 'twist',
      lengthMm: spanLengthMm(doc, tw.span)
    })
  }

  return lines
}

/**
 * Compute the wire-marker print list: only labels whose kind is 'wireMarker' or
 * 'heatshrinkPrint'. For wire-targeted labels, wireRef is the cut-list ref (W1,
 * W2, …); otherwise wireRef is ''.
 */
export function computeMarkerList(doc: HarnessDocument): MarkerRow[] {
  const rows: MarkerRow[] = []
  const wireIndex = wireRefIndex(doc)

  for (const lbl of doc.labels) {
    if (lbl.kind !== 'wireMarker' && lbl.kind !== 'heatshrinkPrint') continue
    const wireRef =
      lbl.target.type === 'wire' ? (wireIndex.get(lbl.target.wireId) ?? '') : ''
    rows.push({ wireRef, text: lbl.text, kind: lbl.kind })
  }

  return rows
}

// ─────────────────────────────── CSV ───────────────────────────────

/** Quote a CSV field if it contains a comma, quote, CR, or LF (RFC 4180). */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header, ...rows].map((cols) => cols.map(csvField).join(','))
  return lines.join('\n') + '\n'
}

export function bomToCsv(lines: BomLine[]): string {
  return toCsv(
    ['category', 'partNumber', 'description', 'manufacturer', 'quantity', 'unit', 'lengthMm', 'partial'],
    lines.map((l) => [
      l.category,
      l.partNumber,
      l.description,
      l.manufacturer,
      l.quantity,
      l.unit,
      l.lengthMm,
      l.partialLength ? 'partial' : ''
    ])
  )
}

export function cutListToCsv(rows: CutRow[]): string {
  return toCsv(
    ['ref', 'from', 'to', 'gauge', 'colour', 'lengthMm', 'lengthSource', 'notes', 'addLengthMm'],
    rows.map((r) => [
      r.ref,
      r.from,
      r.to,
      r.gauge,
      r.colour,
      r.lengthMm,
      r.lengthSource,
      r.notes,
      r.addLengthMm ?? ''
    ])
  )
}
