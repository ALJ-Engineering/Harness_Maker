import React, { useMemo } from 'react'
import type { HarnessDocument } from '@shared/model/schema'
import type { PrintBranding } from '@shared/print/titleBlock'
import type { PartImages } from '@shared/print/picture'
import { buildDrawingSet } from '@shared/print/drawingSet'
import { sheetMm } from '@shared/print/sheet'

export interface DrawingSetPreviewProps {
  /** The harness whose drawing set is rendered. */
  doc: HarnessDocument
  /** Title-block logo; omit for an unbranded title block. */
  branding?: PrintBranding
  /** Part photos keyed by part number (picture block on the drawing). */
  images?: PartImages
  /** Which pages to show: the 1:1 drawing page, the A4 BOM/Wiring/Cutlist pages, or all. Default `all`. */
  pages?: 'all' | 'drawing' | 'documents'
  /** Page scale — `1` prints at true size, `0.5` shows an A4 page at half size. Default `0.5`. */
  scale?: number
}

/**
 * The exported PDF drawing set, on screen: every page the export would print,
 * built by the same pure `buildDrawingSet` the PDF pipeline uses (the 1:1
 * drawing page at the document's own fixed `drawing.sheet`, then the A4-landscape Bill of Materials, Wiring Table and
 * Cutlist pages). Each page is the real SVG at its true millimetre size, then
 * scaled as a whole — never re-laid out.
 */
export function DrawingSetPreview({
  doc,
  branding = {},
  images = {},
  pages = 'all',
  scale = 0.5
}: DrawingSetPreviewProps): React.JSX.Element {
  const set = useMemo(
    () => buildDrawingSet(doc, sheetMm(doc.drawing.sheet), branding, images),
    [doc, branding, images]
  )
  const parts = pages === 'drawing' ? [set.parts[0]] : pages === 'documents' ? set.parts.slice(1) : set.parts
  return (
    <div className="drawing-set" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      {parts.map((part) =>
        part.pages.map((p) => (
          <div
            key={p.id}
            className="drawing-set__page"
            data-section={p.section}
            style={{
              width: `${part.sheet.wMm * scale}mm`,
              height: `${part.sheet.hMm * scale}mm`,
              overflow: 'hidden',
              background: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.25)'
            }}
          >
            <div
              style={{
                width: `${part.sheet.wMm}mm`,
                height: `${part.sheet.hMm}mm`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left'
              }}
              // The page builders emit trusted, self-generated SVG for this document.
              dangerouslySetInnerHTML={{ __html: p.svg }}
            />
          </div>
        ))
      )}
    </div>
  )
}
