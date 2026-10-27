import { useCallback } from 'react'
import { useHarnessStore, type LoadInfo } from './store'
import { serializeDocument, parseDocumentWithNotes } from '@shared/model/serialize'
import { reconcileDocument } from '@shared/model/reconcile'
import { reportToHtml } from '@shared/export/html'
import { computeBom, computeCutList, bomToCsv, cutListToCsv } from '@shared/export/bom'
import { buildDrawingSet, type DrawingSetOutput } from '@shared/print/drawingSet'
import { pageSetToHtml } from '@shared/print/html'
import { sheetMm } from '@shared/print/sheet'
import type { PartImages } from '@shared/print/picture'
import { computeFormboard } from '@shared/model/formboard'
import { primaryPartNumber } from '@shared/model/bodyParts'
import type { HarnessDocument } from '@shared/model/schema'
import type { PrintBranding } from '@shared/print/titleBlock'

const DEFAULT_NAME = 'untitled.harness.json'

/**
 * Build the whole drawing set for a PDF export — pure, no IO. The result is
 * several page sets of DIFFERENT paper sizes (the 1:1 drawing page at the
 * document's own `drawing.sheet`, the fixed sheet the formboard shows — there
 * is no per-export paper choice; document pages at A4 landscape); each becomes
 * one part of the IPC payload,
 * and main merges the rendered parts into one file. Also used by the export
 * dialog to show the page breakdown and the plan warnings before printing.
 *
 * `images` is the part-photo library keyed by part number; empty ⇒ no picture
 * blocks. The export path passes `data:` hrefs (see `withDataUris`), the dialog
 * passes the canvas' `parts-image://` ones — neither is fetched while planning,
 * only `pxW`/`pxH` are, so the page breakdown is the same either way.
 *
 * `branding` carries the title-block logo, read from the parts library
 * (`<library>/branding/logo.*`); empty ⇒ an empty logo cell. The app has no
 * logo of its own.
 */
export function buildExport(
  doc: HarnessDocument,
  images: PartImages = {},
  branding: PrintBranding = {}
): DrawingSetOutput {
  return buildDrawingSet(doc, sheetMm(doc.drawing.sheet), branding, images)
}

/**
 * Re-point every picture at a `data:` URI for the PRINT window. The canvas uses
 * `parts-image://` hrefs, but the hidden `printToPDF` window is a different
 * `BrowserWindow` and Chromium will not fetch a custom scheme from inside the
 * printed document — an unresolvable href prints as a blank frame. A part with
 * no data URL (the file vanished between listing and export) is DROPPED rather
 * than drawn empty, so the planner reserves no block for it.
 *
 * Pure: the IO (`parts:imageDataUrl`) happens in `exportPdf`, this only swaps.
 */
export function withDataUris(images: PartImages, dataUrls: Record<string, string | null>): PartImages {
  const out: PartImages = {}
  for (const [pn, img] of Object.entries(images)) {
    const d = dataUrls[pn]
    if (d) out[pn] = { ...img, href: d }
  }
  return out
}

/**
 * The warning line for pictures the export could not inline, or undefined when
 * none were. Spec §5.3 caps `parts:imageDataUrl` at 5 MB and returns null past
 * it (also for a file that vanished or stopped being readable between the
 * listing and the export) — `withDataUris` then DROPS the picture, so without
 * this line the PDF just silently comes out without a photo the canvas showed.
 */
export function skippedPictureLine(skipped: string[]): string | undefined {
  if (skipped.length === 0) return undefined
  return `⚠ ${skipped.length} picture(s) skipped (over 5 MB or unreadable): ${skipped.join(', ')}`
}

/** Part numbers that actually name a picture in this document, deduped. */
function usedPictureParts(doc: HarnessDocument, images: PartImages): string[] {
  const used = new Set<string>()
  for (const b of computeFormboard(doc).bodies) {
    const pn = primaryPartNumber(doc, b.id)
    if (pn && images[pn]) used.add(pn)
  }
  return [...used]
}

/** `<title>` for the exported PDF: part number (or title) plus revision. */
function pdfTitle(doc: HarnessDocument, base: string): string {
  const tb = doc.drawing.titleBlock
  return [tb?.partNumber ?? tb?.title ?? base, tb?.revision].filter(Boolean).join(' ')
}

/**
 * Parse file text into the document the store should hold: parse, then repair
 * the unambiguous danglers an older file may carry (documents written before
 * the session-11 fixes can hold labels/cables/spans pointing at entities their
 * delete paths failed to prune). When something WAS repaired, the unrepaired
 * document rides along as `onDiskDoc` so the store can mark the load dirty —
 * saving would rewrite the file, and the title's • says so.
 *
 * The loader's own migration notes (legacy `sheets[]`, free-form `titleBlock`,
 * an invalid `drawing.sheet`) ride along as `migrated` and are shown next to
 * the repairs.
 * Throws `DocumentParseError` for a file that isn't a harness document.
 */
export function loadFromText(content: string): { doc: HarnessDocument; load: LoadInfo } {
  const { doc: onDisk, migrated } = parseDocumentWithNotes(content)
  const { doc, repairs } = reconcileDocument(onDisk)
  return {
    doc,
    load: repairs.length > 0 ? { repairs, migrated, onDiskDoc: onDisk } : { repairs, migrated }
  }
}

/** Basename of a path, for titles/dialogs. */
export function baseName(path: string | null): string {
  if (!path) return 'Untitled'
  return path.split(/[\\/]/).pop() ?? path
}

/** A clean base for export filenames, derived from the open document. */
function exportBase(path: string | null): string {
  if (!path) return 'harness'
  const file = path.split(/[\\/]/).pop() ?? path
  return file.replace(/\.harness\.json$/i, '').replace(/\.[^.]+$/, '') || 'harness'
}

/**
 * File operations that bridge the store to the main process via window.api.
 * Reads live state with getState() so callbacks never close over stale values.
 */
export function useFileOps(): {
  open: () => Promise<void>
  save: () => Promise<void>
  saveAs: () => Promise<void>
  newDoc: () => void
  exportPdf: (images?: PartImages) => Promise<void>
  exportBom: () => Promise<void>
} {
  const saveAs = useCallback(async () => {
    const { doc, filePath, markSaved } = useHarnessStore.getState()
    const path = await window.api.saveDocumentAs(
      serializeDocument(doc),
      filePath ?? DEFAULT_NAME
    )
    // `doc`, not the store's current one: an agent edit during the await is not on disk.
    if (path) markSaved(path, doc)
  }, [])

  const save = useCallback(async () => {
    const { doc, filePath, markSaved } = useHarnessStore.getState()
    if (!filePath) return saveAs()
    const written = await window.api.saveDocument(filePath, serializeDocument(doc))
    markSaved(written, doc)
  }, [saveAs])

  const open = useCallback(async () => {
    const { dirty, setDocument } = useHarnessStore.getState()
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    const res = await window.api.openDocument()
    if (!res) return
    try {
      // Reconcile BEFORE the document becomes store state; the repairs then
      // surface as `repaired-on-load` notices in the DRC panel.
      const { doc, load } = loadFromText(res.content)
      setDocument(doc, res.path, load)
    } catch (e) {
      window.alert(`Could not open file:\n${(e as Error).message}`)
    }
  }, [])

  const newDoc = useCallback(() => {
    const { dirty, newDocument } = useHarnessStore.getState()
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    newDocument()
  }, [])

  const exportPdf = useCallback(async (images: PartImages = {}) => {
    const { doc, filePath } = useHarnessStore.getState()
    const base = exportBase(filePath)
    // Pagination happens inside the try as well: a builder throwing on an odd
    // document must surface as the same alert, not an unhandled rejection.
    try {
      // Only the parts this document actually shows are read back as data URIs;
      // a shared library can hold hundreds of photos.
      const dataUrls = Object.fromEntries(
        await Promise.all(
          usedPictureParts(doc, images).map(
            async (pn) => [pn, await window.api.partsImageDataUrl(pn)] as const
          )
        )
      )
      const skipped = Object.entries(dataUrls)
        .filter(([, url]) => !url)
        .map(([pn]) => pn)
      const logo = await window.api.libraryLogoDataUrl()
      const out = buildExport(doc, withDataUris(images, dataUrls), { logoDataUri: logo ?? undefined })
      const title = pdfTitle(doc, base)
      const written = await window.api.exportPdf({
        parts: out.parts.map((p) => ({
          html: pageSetToHtml(p, title),
          widthMm: p.sheet.wMm,
          heightMm: p.sheet.hMm
        })),
        defaultPath: `${base}-drawing-set.pdf`,
        title: 'Export drawing set (PDF)'
      })
      // The export dialog's summary is built synchronously from the plan and
      // cannot know a file's size, so the skipped-picture warning rides on the
      // post-export alert instead.
      if (written)
        window.alert(['Exported:', written, skippedPictureLine(skipped)].filter(Boolean).join('\n'))
    } catch (e) {
      window.alert(`PDF export failed:\n${(e as Error).message}`)
    }
  }, [])

  const exportBom = useCallback(async () => {
    const { doc, filePath } = useHarnessStore.getState()
    const base = exportBase(filePath)
    const written = await window.api.exportFiles(
      [
        { suffix: '.html', content: reportToHtml(doc) },
        { suffix: '-bom.csv', content: bomToCsv(computeBom(doc)) },
        { suffix: '-cutlist.csv', content: cutListToCsv(computeCutList(doc)) }
      ],
      `${base}.html`,
      'Export BOM & cut list'
    )
    if (written) window.alert(`Exported:\n${written.join('\n')}`)
  }, [])

  return { open, save, saveAs, newDoc, exportPdf, exportBom }
}
