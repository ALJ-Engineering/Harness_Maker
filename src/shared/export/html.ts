import type { HarnessDocument } from '../model/schema'
import {
  computeBom,
  computeCutList,
  computeTreatmentLines,
  computeMarkerList,
  type BomLine,
  type CutRow,
  type TreatmentLine,
  type MarkerRow
} from './bom'

/** A self-contained, printable HTML report: BOM table + cut-list table. */
export function reportToHtml(doc: HarnessDocument): string {
  const title = doc.drawing.titleBlock?.title ?? 'Harness'
  const bom = computeBom(doc)
  const cut = computeCutList(doc)
  const treatments = computeTreatmentLines(doc)
  const markers = computeMarkerList(doc)

  const treatmentsSection =
    treatments.length > 0
      ? `<h2>Treatments</h2>\n${treatmentTable(treatments)}\n`
      : ''

  const markersSection =
    markers.length > 0
      ? `<h2>Wire markers</h2>\n${markerTable(markers)}\n`
      : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title)} — BOM &amp; Cut List</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #222; }
  h1 { font-size: 20px; }
  h2 { font-size: 15px; margin-top: 28px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
  th { background: #eef2f7; }
  tbody tr:nth-child(even) { background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #999; font-style: italic; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<h2>Bill of Materials</h2>
${bomTable(bom)}
<h2>Cut list</h2>
${cutTable(cut)}
${treatmentsSection}${markersSection}</body>
</html>
`
}

function bomTable(lines: BomLine[]): string {
  if (lines.length === 0) return '<p class="empty">No parts.</p>'
  const lengthCell = (l: BomLine): string => {
    if (l.unit === 'ea') return ''
    if (l.lengthMm === null) return '<span class="empty">unknown</span>'
    return `${(l.lengthMm / 1000).toFixed(2)} m${l.partialLength ? ' (partial)' : ''}`
  }
  const rows = lines
    .map(
      (l) =>
        `<tr><td>${esc(l.category)}</td><td>${esc(l.partNumber)}</td><td>${esc(
          l.description ?? ''
        )}</td><td>${esc(l.manufacturer ?? '')}</td><td class="num">${l.quantity}</td><td class="num">${lengthCell(
          l
        )}</td></tr>`
    )
    .join('\n')
  return `<table>
<thead><tr><th>Category</th><th>Part number</th><th>Description</th><th>Manufacturer</th><th>Qty</th><th>Length</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}

function cutTable(rows: CutRow[]): string {
  if (rows.length === 0) return '<p class="empty">No wires.</p>'
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.ref)}</td><td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${esc(
          r.gauge
        )}</td><td>${esc(r.colour)}</td><td class="num">${
          r.lengthMm === null
            ? '<span class="empty">unknown</span>'
            : `${Math.round(r.lengthMm)}` +
              (r.lengthSource === 'specified'
                ? ' (spec)'
                : r.addLengthMm
                  ? ` (incl. ${r.addLengthMm} allow)`
                  : '')
        }</td><td>${esc(r.notes)}</td></tr>`
    )
    .join('\n')
  return `<table>
<thead><tr><th>Ref</th><th>From</th><th>To</th><th>Gauge</th><th>Colour</th><th>Length (mm)</th><th>Notes</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`
}

function treatmentTable(lines: TreatmentLine[]): string {
  const rows = lines
    .map(
      (l) =>
        `<tr><td>${esc(l.kind)}</td><td>${esc(l.ref)}</td><td>${esc(l.description)}</td><td class="num">${
          l.lengthMm === null
            ? '<span class="empty">unknown</span>'
            : `${Math.round(l.lengthMm)}`
        }</td><td>${esc(l.part ?? '')}</td></tr>`
    )
    .join('\n')
  return `<table>
<thead><tr><th>Kind</th><th>Ref</th><th>Description</th><th>Length (mm)</th><th>Part</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}

function markerTable(rows: MarkerRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.wireRef)}</td><td>${esc(r.text)}</td><td>${esc(r.kind)}</td></tr>`
    )
    .join('\n')
  return `<table>
<thead><tr><th>Wire ref</th><th>Text</th><th>Kind</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
