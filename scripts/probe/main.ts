/**
 * Headless export of the demo document through the REAL main-process path.
 *
 * This is a measurement instrument, not a feature: it drives
 * `renderExportToPdf` — the same function the `doc:exportPdf` IPC handler uses —
 * so what comes out is byte-for-byte what a user's "Export PDF" produces, minus
 * the save dialog. `scripts/probe-pdf-export.mjs` bundles it, runs it under
 * Electron, and then measures the result with `pdfinfo` + the 100 mm scale bar.
 *
 * Usage (under Electron):  probe.cjs <out.pdf> [paper] [orientation]
 * `paper` is A4 (default) | A3 | A2 | A1 | A0 | `Plotter:<lengthMm>` (a
 * 914 mm roll of that length) and applies to the 1:1 DRAWING page only — the BOM /
 * Wiring Table / Cutlist pages are always A4 landscape by design
 * (`DOCUMENT_PAGE_SHEET`), which is exactly what the mixed-page-size merge
 * needs to be proven against.
 */
import { app } from 'electron'
import { writeFile } from 'fs/promises'
import { demoDocument } from '@shared/model/document'
import { buildDrawingSet } from '@shared/print/drawingSet'
import { pageSetToHtml } from '@shared/print/html'
import type { PartImages } from '@shared/print/picture'
import { sheetMm } from '@shared/print/sheet'
import { PLOTTER_MAX_LENGTH_MM, type PaperSize, type SheetConfig } from '@shared/model/schema'
import { renderExportToPdf } from '../../src/main/pdf'

const PAPERS: PaperSize[] = ['A4', 'A3', 'A2', 'A1', 'A0']

/**
 * The picture fixture. A **real, decodable** 2x2 RGB PNG (76 bytes, generated
 * once with zlib + CRC32 and pasted here), not the header-only stub the unit
 * tests use: the point of this probe is that Chromium actually DECODES the
 * image and embeds it in the PDF, which `pdfimages -list` then confirms. A
 * header-only PNG would still produce an `<image>` tag and no embedded image.
 *
 * It is handed to `buildDrawingSet` as a `data:` URI because the print window
 * has no `parts-image://` protocol registered — exactly what the real export
 * does (`fileOps.withDataUris` converts every href before the IPC call).
 */
const FIXTURE_PART = 'PROBE-HSG'
const FIXTURE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR42mP4zwAEQGIBw///DAAdFASd1dC4YAAAAABJRU5ErkJggg=='
const FIXTURE_IMAGES: PartImages = {
  [FIXTURE_PART]: {
    href: `data:image/png;base64,${FIXTURE_PNG_B64}`,
    pxW: 2,
    pxH: 2
  }
}

function parseArgs(argv: string[]): { out: string; sheet: SheetConfig } {
  const [out, paper = 'A4', orientation = 'landscape'] = argv
  if (!out) throw new Error('usage: probe.cjs <out.pdf> [paper] [orientation]')
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw new Error(`unknown orientation ${orientation}`)
  }
  // `Plotter:<lengthMm>` — deliberately NOT clamped to PLOTTER_MAX_LENGTH_MM, so
  // the probe can measure where Chromium's page size stops being exact; it only
  // warns when the length is past the validated cap.
  const plot = /^Plotter:(\d+(?:\.\d+)?)$/.exec(paper)
  if (plot) {
    const lengthMm = Number(plot[1])
    if (lengthMm > PLOTTER_MAX_LENGTH_MM) {
      console.warn(`plotter length ${lengthMm} mm is past PLOTTER_MAX_LENGTH_MM (${PLOTTER_MAX_LENGTH_MM})`)
    }
    return { out, sheet: { paper: 'Plotter', orientation, lengthMm } }
  }
  if (!PAPERS.includes(paper as PaperSize)) {
    throw new Error(`unknown paper ${paper} (expected one of ${PAPERS.join(', ')}, Plotter:<lengthMm>)`)
  }
  return { out, sheet: { paper: paper as PaperSize, orientation } }
}

// `renderPartToPdf` closes its hidden BrowserWindow between parts, and with no
// window left Electron's DEFAULT `window-all-closed` handler quits the app —
// killing the export mid-await, silently, with exit code 0. The real app has
// its own handler (src/main/index.ts); the probe needs one too.
app.on('window-all-closed', () => {})

app
  .whenReady()
  .then(async () => {
    const { out, sheet } = parseArgs(process.argv.slice(2))
    const doc = demoDocument()
    // Give the first connector a housing part number the fixture library has a
    // photo for, so exactly ONE picture block is planned and printed. The demo
    // document carries no part numbers of its own.
    doc.connectors[0].housing = { partNumber: FIXTURE_PART }
    const title = `${doc.drawing.titleBlock?.partNumber ?? 'Harness'} probe`
    // No logo: the probe measures geometry, and a data-URI logo would only add
    // megabytes to the HTML. `PrintBranding.logoDataUri` is optional; without
    // it the logo cell is left empty.
    const set = buildDrawingSet(doc, sheetMm(sheet), {}, FIXTURE_IMAGES)
    const htmls = set.parts.map((p) => pageSetToHtml(p, title))
    const pdf = await renderExportToPdf({
      parts: set.parts.map((p, i) => ({
        html: htmls[i],
        widthMm: p.sheet.wMm,
        heightMm: p.sheet.hMm
      })),
      defaultPath: out,
      title
    })
    await writeFile(out, Buffer.from(pdf))
    // Part 0 (the drawing page) is dumped beside the PDF so the runner can
    // count its `<image>` tags — the cheap half of the picture gate. The
    // expensive half is `pdfimages -list` on the PDF itself, which only passes
    // if Chromium actually decoded and embedded the bytes.
    await writeFile(out.replace(/\.pdf$/, '-part0.html'), htmls[0])
    console.log(
      `wrote ${out}: drawing sheet ${sheet.paper}${sheet.lengthMm ? ` ${sheet.lengthMm} mm` : ''} ` +
        `${sheet.orientation} (${set.parts[0].sheet.wMm} × ${set.parts[0].sheet.hMm} mm), ` +
        `1 drawing page + ${set.pageCount - 1} document pages = ${set.pageCount} pages` +
        (set.warnings.length ? ` (warnings: ${set.warnings.join(', ')})` : '')
    )
    app.exit(0)
  })
  .catch((e) => {
    console.error(e)
    app.exit(1)
  })
