import { useHarnessStore } from '../store'
import { Field, TextEdit, SelectEdit, NumberEdit } from './fields'
import type { HarnessDocument, PaperSize, Approval } from '@shared/model/schema'
import { DEFAULT_CONFIDENTIALITY, PLOTTER_MAX_LENGTH_MM, PLOTTER_MIN_LENGTH_MM, PLOTTER_ROLL_WIDTH_MM } from '@shared/model/schema'
import { plotterLengthMm, withPaper } from './sheetEdit'
import { ToleranceProperties } from './ToleranceProperties'

const PAPER_OPTS: { value: PaperSize; label: string }[] = [
  { value: 'A4', label: 'A4' },
  { value: 'A3', label: 'A3' },
  { value: 'A2', label: 'A2' },
  { value: 'A1', label: 'A1' },
  { value: 'A0', label: 'A0' },
  { value: 'Plotter', label: `Plotter (${PLOTTER_ROLL_WIDTH_MM} mm roll)` }
]

const ORIENTATION_OPTS: { value: 'portrait' | 'landscape'; label: string }[] = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' }
]

type ApprovalKey = 'drawnBy' | 'engApproved' | 'mfgApproved' | 'qa'

const APPROVAL_ROWS: { key: ApprovalKey; label: string }[] = [
  { key: 'drawnBy', label: 'Drawn by' },
  { key: 'engApproved', label: 'Eng approved' },
  { key: 'mfgApproved', label: 'Mfg approved' },
  { key: 'qa', label: 'QA' }
]

/**
 * Document-level properties shown when nothing is selected: the drawing sheet
 * (paper + orientation, and the roll length for the plotter — the one sheet the
 * formboard shows and the PDF prints; it grows right and down from its pinned
 * top-left, `drawing.sheetOrigin`, which nothing here touches) and the
 * title-block form, then the length-tolerance table (`ToleranceProperties`).
 * All fields go through `setSheet`/`setTitleBlock` — a committed empty string
 * clears the field (stored as `undefined`) rather than persisting `""`, so the
 * block stays clean for export/print.
 */
export function DocumentProperties({ doc }: { doc: HarnessDocument }): React.JSX.Element {
  const setSheet = useHarnessStore((s) => s.setSheet)
  const setTitleBlock = useHarnessStore((s) => s.setTitleBlock)
  const gridVisible = useHarnessStore((s) => s.gridVisible)
  const gridMm = useHarnessStore((s) => s.gridMm)
  const setGridVisible = useHarnessStore((s) => s.setGridVisible)
  const setGridMm = useHarnessStore((s) => s.setGridMm)
  const tb = doc.drawing.titleBlock ?? {}

  const setField =
    (field: 'title' | 'partNumber' | 'description' | 'revision' | 'confidentiality') =>
    (v: string): void =>
      setTitleBlock({ [field]: v === '' ? undefined : v })

  const setApproval =
    (key: ApprovalKey, part: keyof Approval) =>
    (v: string): void => {
      const cur = tb[key]
      setTitleBlock({ [key]: { ...cur, [part]: v === '' ? undefined : v } })
    }

  return (
    <div className="panel__section">
      <div className="panel__kind">Document</div>

      <div className="panel__subhead">Sheet</div>
      <Field label="Paper">
        <SelectEdit
          value={doc.drawing.sheet.paper}
          options={PAPER_OPTS}
          onCommit={(paper) => setSheet(withPaper(doc.drawing.sheet, paper))}
        />
      </Field>
      {doc.drawing.sheet.paper === 'Plotter' && (
        <Field label="Roll length (mm)">
          <NumberEdit
            value={doc.drawing.sheet.lengthMm}
            min={PLOTTER_MIN_LENGTH_MM}
            max={PLOTTER_MAX_LENGTH_MM}
            step={1}
            onCommit={(v) => {
              const lengthMm = plotterLengthMm(v)
              if (lengthMm !== undefined) setSheet({ ...doc.drawing.sheet, lengthMm })
            }}
          />
        </Field>
      )}
      <Field label="Orientation">
        <SelectEdit
          value={doc.drawing.sheet.orientation}
          options={ORIENTATION_OPTS}
          onCommit={(orientation) => setSheet({ ...doc.drawing.sheet, orientation })}
        />
      </Field>

      <div className="panel__subhead">Grid (view only)</div>
      <Field label="Show grid">
        <input type="checkbox" checked={gridVisible} onChange={(e) => setGridVisible(e.target.checked)} />
      </Field>
      <Field label="Spacing (mm)">
        <NumberEdit
          value={gridMm}
          min={1}
          max={1000}
          step={1}
          onCommit={(v) => {
            if (v !== undefined) setGridMm(v)
          }}
        />
      </Field>

      <div className="panel__subhead">Title block</div>
      <Field label="Title">
        <TextEdit value={tb.title ?? ''} onCommit={setField('title')} />
      </Field>
      <Field label="Part number">
        <TextEdit value={tb.partNumber ?? ''} onCommit={setField('partNumber')} />
      </Field>
      <Field label="Description">
        <TextEdit multiline value={tb.description ?? ''} onCommit={setField('description')} />
      </Field>
      <Field label="Revision">
        <TextEdit value={tb.revision ?? ''} onCommit={setField('revision')} />
      </Field>

      {APPROVAL_ROWS.map(({ key, label }) => (
        <Field key={key} label={label}>
          <span className="pf__colorrow">
            <TextEdit
              value={tb[key]?.name ?? ''}
              placeholder="name"
              onCommit={setApproval(key, 'name')}
            />
            <TextEdit
              value={tb[key]?.date ?? ''}
              placeholder="YYYY-MM-DD"
              onCommit={setApproval(key, 'date')}
            />
          </span>
        </Field>
      ))}

      <Field label="Confidentiality">
        <TextEdit
          multiline
          value={tb.confidentiality ?? ''}
          placeholder={DEFAULT_CONFIDENTIALITY}
          onCommit={setField('confidentiality')}
        />
      </Field>

      <ToleranceProperties table={doc.drawing.toleranceTable} />
    </div>
  )
}
