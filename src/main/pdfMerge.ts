/**
 * Concatenate several PDFs (one per `printToPDF` call — Chromium prints one
 * page size per call, and the drawing set mixes the drawing paper with A4
 * document pages) into one. Pure `pdf-lib`, no Electron import, so it is
 * unit-testable in the node test env. Page boxes are copied verbatim:
 * `copyPages` clones the page dictionaries, MediaBox included — the 1:1 drawing page
 * must come out exactly the size Chromium produced them. What it does NOT clone
 * is the Info dictionary, so the first part's `/Title` is handed over by hand:
 * every real export takes the multi-part path, and without this the document
 * title a viewer shows (`pdfTitle` → the HTML `<title>` → Chromium) would be
 * lost on every single one.
 */
import { PDFDocument } from 'pdf-lib'

export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  if (parts.length === 0) throw new Error('mergePdfs: at least one part is required')
  const out = await PDFDocument.create()
  for (const [i, bytes] of parts.entries()) {
    const src = await PDFDocument.load(bytes)
    if (i === 0) {
      // The parts are the same document at different paper sizes, so part 0's
      // title is the document's title; the rest carry the same string anyway.
      const title = src.getTitle()
      if (title) out.setTitle(title)
    }
    const pages = await out.copyPages(src, src.getPageIndices())
    for (const p of pages) out.addPage(p)
  }
  return out.save({ useObjectStreams: false })
}
