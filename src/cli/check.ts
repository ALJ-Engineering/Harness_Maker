import type { HarnessDocument } from '@shared/model/schema'
import { runDrc, type Finding } from '@shared/drc'
import { planBoard } from '@shared/print/board'
import { sheetMm } from '@shared/print/sheet'
import { outsideSheetFindings } from '@shared/print/sheetFindings'
import { wiringTable, connectorPinouts, type ConnectorPinout } from '@shared/print/tableData'
import type { Cell, Row } from '@shared/print/tables'
import type { LibraryContext } from './session'
import { incompleteReasons } from './rails'

export interface WiringRow {
  from: string
  to: string
  conductor: string
  size: string
  conductorPn: string
  twistedWith: string
  notes: string
}

export interface CheckResult {
  findings: Finding[]
  wiring: WiringRow[]
  pinouts: ConnectorPinout[]
  /** `null` when no parts library folder resolved (the list cannot be computed). */
  incompleteParts: { partNumber: string; reasons: string[] }[] | null
  /** What the editor would repair on open (message per repair) and migration notes; empty for a clean file. */
  repairs?: string[]
  migrated?: string[]
  /** Other notes from the command (e.g. the library folder does not exist). */
  notes?: string[]
}

const cellText = (c: Cell | undefined): string => (c === undefined ? '' : typeof c === 'string' ? c : c.text)

/** Every part number the document names (housings, pins, seals, plugs, terminals, splices, wires, cables, bundles, sleeving). */
export function documentPartNumbers(doc: HarnessDocument): string[] {
  const pns = new Set<string>()
  const add = (p?: { partNumber: string }) => {
    if (p?.partNumber) pns.add(p.partNumber)
  }
  for (const c of doc.connectors) {
    add(c.housing)
    for (const cv of c.cavities) [cv.pin, cv.seal, cv.plug].forEach(add)
  }
  for (const t of doc.freeTerminals) [t.part, t.seal].forEach(add)
  for (const s of doc.splices) add(s.part)
  for (const w of doc.wires) add(w.spec)
  for (const c of doc.cables) add(c.part)
  for (const b of doc.bundles) add(b.part)
  for (const s of doc.sleeving) add(s.part)
  return [...pns].sort()
}

export function checkDocument(doc: HarnessDocument, lib: LibraryContext | null): CheckResult {
  const wiring = wiringTable(doc).rows.map((r: Row) => ({
    from: cellText(r.from),
    to: cellText(r.to),
    conductor: cellText(r.conductor),
    size: cellText(r.size),
    conductorPn: cellText(r.conductorPn),
    twistedWith: cellText(r.twistedWith),
    notes: cellText(r.notes)
  }))
  const incompleteParts = lib
    ? documentPartNumbers(doc)
        .map((partNumber) => ({ partNumber, reasons: incompleteReasons(partNumber, lib) }))
        .filter((p) => p.reasons.length > 0)
    : null
  return {
    // Same finding set as the app's DRC panel: rule findings, then whatever the
    // one fixed drawing sheet would cut off. Part pictures are not loaded here,
    // so picture blocks are not planned (and cannot be flagged) by the CLI.
    findings: [
      ...runDrc(doc, lib?.catalog),
      ...outsideSheetFindings(planBoard(doc, sheetMm(doc.drawing.sheet)).warnings, doc)
    ],
    wiring,
    pinouts: connectorPinouts(doc),
    incompleteParts
  }
}

const SEVERITY_ORDER = ['error', 'warning', 'info']

function pad(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows.map((r) => '  ' + r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd())
}

export function formatCheck(r: CheckResult): string {
  const lines: string[] = []
  for (const n of r.notes ?? []) lines.push(`note: ${n}`)
  for (const m of r.migrated ?? []) lines.push(`note: migrated on load: ${m}`)
  for (const m of r.repairs ?? []) lines.push(`note: the editor would repair this file on open: ${m}`)
  const sevs = [...new Set([...SEVERITY_ORDER, ...r.findings.map((f) => f.severity)])]
  lines.push(`DRC: ${r.findings.length} finding(s)`)
  for (const sev of sevs) {
    const fs = r.findings.filter((f) => f.severity === sev)
    if (!fs.length) continue
    lines.push(`${sev} (${fs.length}):`)
    for (const f of fs) lines.push(`  [${f.ruleId}] ${f.message}`)
  }
  lines.push('', `Wiring table (${r.wiring.length} row(s)):`)
  if (r.wiring.length)
    lines.push(
      ...pad([
        ['FROM', 'TO', 'CONDUCTOR', 'SIZE', 'CONDUCTOR PN', 'TWISTED WITH', 'NOTES'],
        ...r.wiring.map((w) => [w.from, w.to, w.conductor, w.size, w.conductorPn, w.twistedWith, w.notes])
      ])
    )
  for (const p of r.pinouts) {
    lines.push('', `Pinout ${p.designator}:`)
    const cols = p.table.cols
    lines.push(...pad([cols.map((c) => c.title), ...p.table.rows.map((row) => cols.map((c) => cellText(row[c.key])))]))
  }
  lines.push('')
  if (r.incompleteParts === null) {
    lines.push('incomplete parts: unavailable (no usable parts library folder — pass --library or set HARNESS_LIBRARY)')
  } else if (r.incompleteParts.length === 0) {
    lines.push('incomplete parts: none')
  } else {
    lines.push(`incomplete parts (${r.incompleteParts.length}):`)
    for (const p of r.incompleteParts) for (const why of p.reasons) lines.push(`  ${why}`)
  }
  return lines.join('\n')
}
