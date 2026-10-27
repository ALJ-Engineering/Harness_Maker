import type { SheetConfig } from '@shared/model/schema'
import { sheetDescription } from './panel/sheetEdit'

/** What the caller reports back about the export the document's sheet produces. */
export interface ExportSummary {
  /** Total pages across every part. */
  pages: number
  /** One-line plan warning (blocks overlapping, over a wire, outside the sheet, …), if any. */
  warning?: string
  /** Informational note — currently "n bodies have no picture". Never printed. */
  info?: string
}

/**
 * Confirmation for the one PDF export. There is a single export kind — the
 * drawing set is the one 1:1 drawing page plus the A4 document pages — and the
 * drawing page is ALWAYS the document's own sheet (`drawing.sheet`): the
 * formboard shows that sheet fixed in place, so printing on any other paper
 * would cut off something different from what the user laid out against. The
 * sheet is therefore shown read-only here and changed in Document Properties.
 *
 * The warning line is there so a table sitting on a wire, or anything outside
 * the sheet, is seen BEFORE printing rather than after.
 */
export function ExportDialog({
  sheet,
  summary,
  onExport,
  onClose
}: {
  /** The document's drawing sheet — what the drawing page prints at. */
  sheet: SheetConfig
  /** Page breakdown + warnings for that sheet. */
  summary: ExportSummary
  onExport: () => void
  onClose: () => void
}): React.JSX.Element {
  const docPages = summary.pages - 1

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Export PDF" onClick={(e) => e.stopPropagation()}>
        <h3>Export drawing set (PDF)</h3>
        <div className="modal__row" data-testid="export-sheet">
          {`Drawing: ${sheetDescription(sheet)} — change in Document Properties`}
        </div>
        <div className="modal__row modal__hint">
          {`1 drawing sheet + ${docPages} A4 document page${docPages === 1 ? '' : 's'} = ${summary.pages} pages`}
        </div>
        {summary.warning && <div className="modal__row modal__warn">{summary.warning}</div>}
        {summary.info && <div className="modal__row modal__info">{summary.info}</div>}
        <div className="modal__actions">
          <button className="panel__add" onClick={onClose}>
            Cancel
          </button>
          <button className="panel__add panel__add--primary" onClick={onExport}>
            Export…
          </button>
        </div>
      </div>
    </div>
  )
}
