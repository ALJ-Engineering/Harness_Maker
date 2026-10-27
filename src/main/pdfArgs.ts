/**
 * Pure helpers for the `doc:exportPdf` IPC handler — deliberately free of any
 * `electron` import so they can be unit-tested in the plain node test env.
 */
import { PLOTTER_MAX_LENGTH_MM } from '../shared/model/schema'

/**
 * One page-size run of the export. Chromium prints a single page size per
 * `printToPDF` call, and the drawing set mixes the 1:1 drawing paper with A4
 * document pages — so an export is a LIST of parts, rendered one at a time and
 * merged. Mirrors `PdfPart` in `preload/index.ts`.
 */
export interface PdfPart {
  html: string
  widthMm: number
  heightMm: number
}

/** Args for `doc:exportPdf`. Mirrors `ExportPdfArgs` in `preload/index.ts`. */
export interface ExportPdfArgs {
  parts: PdfPart[]
  defaultPath?: string
  title?: string
}

/**
 * Upper bound (mm) on a page dimension: the longest sheet we emit, a plotter
 * roll at `PLOTTER_MAX_LENGTH_MM` (5000 mm, measured to print exactly 1:1 —
 * under PDF's 200 in / 5080 mm page limit). Anything longer is refused rather
 * than having Chromium try to lay out a page of nonsense size (or exhaust
 * memory doing it).
 */
const MAX_PAGE_MM = PLOTTER_MAX_LENGTH_MM

/**
 * Upper bound on the number of parts. The drawing set is two (drawing page +
 * A4 document pages); 4 leaves room for a third and fourth paper size without
 * letting a malformed payload spawn an unbounded number of hidden windows.
 */
const MAX_PARTS = 4

function isPageDimension(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_PAGE_MM
}

function isPdfPart(v: unknown): v is PdfPart {
  const p = v as Partial<PdfPart> | null | undefined
  return (
    p !== null &&
    typeof p === 'object' &&
    typeof p.html === 'string' &&
    isPageDimension(p.widthMm) &&
    isPageDimension(p.heightMm)
  )
}

/** Optional string field: absent is fine, present-and-not-a-string is not. */
function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

/**
 * Validate an IPC payload before it reaches the save dialog or the renderer
 * window. The renderer is untrusted with respect to the OS, and a bad payload
 * would otherwise surface as a save dialog followed by a crash deep inside
 * `printToPDF`. There must be between 1 and MAX_PARTS parts and EVERY one of
 * them must be well-formed — a bad part in position 2 is found before part 1
 * has opened a window. Page dimensions are bounded (0, MAX_PAGE_MM]; `defaultPath` and
 * `title` reach `dialog.showSaveDialog` and the temp-file namer, so they must
 * be strings when present rather than merely truthy. Returns the payload typed;
 * throws otherwise.
 */
export function validateExportPdfArgs(args: unknown): ExportPdfArgs {
  const a = args as Partial<ExportPdfArgs> | null | undefined
  if (
    a === null ||
    typeof a !== 'object' ||
    !Array.isArray(a.parts) ||
    a.parts.length < 1 ||
    a.parts.length > MAX_PARTS ||
    !a.parts.every(isPdfPart) ||
    !isOptionalString(a.defaultPath) ||
    !isOptionalString(a.title)
  ) {
    throw new Error('exportPdf: invalid arguments')
  }
  return a as ExportPdfArgs
}

/** Longest file name we will hand to `mkdtemp`'s directory — well under any OS limit. */
const MAX_HTML_FILE_NAME = 80

/**
 * Name for the temporary HTML file we print from. Chromium uses the loaded
 * document's file name as the PDF's `/Title`, so this is what shows up in a
 * viewer's title bar — derive it from the PDF being written.
 */
export function htmlFileNameFor(pdfPath: string | undefined): string {
  const base = pdfPath ? pdfPath.split(/[\\/]/).pop() ?? '' : ''
  const stem = base.replace(/\.pdf$/i, '')
  const safe = stem.replace(/[^\w.\- ]+/g, '_').trim()
  const capped = safe.slice(0, MAX_HTML_FILE_NAME - '.html'.length).trim()
  return `${capped || 'harness'}.html`
}
