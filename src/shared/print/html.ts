/**
 * Wraps a rendered `PageSet` in a standalone HTML document for the Electron
 * main process to feed to `printToPDF`: one `.page` div per page, each sized
 * to exactly the sheet dimensions with hard page breaks between them.
 *
 * The `<title>` is what Chromium writes into the PDF's `/Title` metadata — a
 * PDF with no title shows up in a viewer's tab and in a file manager's
 * properties as the temp file name, so the caller passes the document's
 * part number / revision and it is required, not optional.
 */
import type { PageSet } from './pageModel'
import { escapeXml } from './text'

export function pageSetToHtml(set: PageSet, title: string): string {
  const { sheet, pages } = set
  const w = sheet.wMm
  const h = sheet.hMm
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>
@page { size: ${w}mm ${h}mm; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.page { width: ${w}mm; height: ${h}mm; overflow: hidden; page-break-after: always; break-after: page; position: relative }
.page:last-child { page-break-after: auto; break-after: auto }
.page svg { display: block; width: ${w}mm; height: ${h}mm }
</style></head><body>${pages.map((p) => `<div class="page" data-page="${p.id}">${p.svg}</div>`).join('')}</body></html>`
}
