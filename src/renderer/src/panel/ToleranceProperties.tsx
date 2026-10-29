import { useHarnessStore } from '../store'
import { Field, TextEdit, SelectEdit, NumberEdit } from './fields'
import type { LengthToleranceBand, ToleranceTable } from '@shared/model/schema'
import { DEFAULT_TOLERANCE_TITLE } from '@shared/model/schema'
import { ipcToleranceTable, withBand, withNewBand, withoutBand } from './toleranceEdit'

const UNIT_OPTS: { value: LengthToleranceBand['unit']; label: string }[] = [
  { value: 'mm', label: 'mm' },
  { value: '%', label: '%' }
]

/**
 * The drawing's length-tolerance table, under the title block in the Document
 * properties. **+ Add** puts it on the sheet with the IPC/WHMA-A-620 bands;
 * each band is "up to" a length (blank = everything longer), how much longer
 * (+) and shorter (−) a wire may be, and whether those are mm or %. Every
 * commit goes through `setToleranceTable`, one undo step each.
 */
export function ToleranceProperties({ table }: { table: ToleranceTable | undefined }): React.JSX.Element {
  const setToleranceTable = useHarnessStore((s) => s.setToleranceTable)

  return (
    <>
      <div className="panel__subhead">
        Length tolerance
        {table ? (
          <button className="panel__add" title="Take the table off the drawing" onClick={() => setToleranceTable(undefined)}>
            Remove
          </button>
        ) : (
          <button
            className="panel__add"
            title="Put a length-tolerance table on the drawing, starting from IPC/WHMA-A-620"
            onClick={() => setToleranceTable(ipcToleranceTable())}
          >
            + Add
          </button>
        )}
      </div>
      {table && (
        <>
          <Field label="Title">
            <TextEdit
              value={table.title ?? ''}
              placeholder={DEFAULT_TOLERANCE_TITLE}
              onCommit={(v) => setToleranceTable(v.trim() ? { ...table, title: v } : { bands: table.bands })}
            />
          </Field>
          <table className="cavtable cavtable--tolerance">
            <thead>
              <tr>
                <th title="Wires up to this length, mm. Blank: everything longer.">Up to mm</th>
                <th title="How much longer than drawn">+</th>
                <th title="How much shorter than drawn">−</th>
                <th>Unit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {table.bands.map((b, i) => (
                <tr key={i}>
                  <td>
                    <NumberEdit
                      optional
                      value={b.upToMm}
                      min={0}
                      minExclusive
                      placeholder="longer"
                      onCommit={(v) => setToleranceTable(withBand(table, i, { upToMm: v }))}
                    />
                  </td>
                  <td>
                    <NumberEdit
                      value={b.plus}
                      min={0}
                      onCommit={(v) => {
                        if (v !== undefined) setToleranceTable(withBand(table, i, { plus: v }))
                      }}
                    />
                  </td>
                  <td>
                    <NumberEdit
                      value={b.minus}
                      min={0}
                      onCommit={(v) => {
                        if (v !== undefined) setToleranceTable(withBand(table, i, { minus: v }))
                      }}
                    />
                  </td>
                  <td>
                    <SelectEdit
                      value={b.unit}
                      options={UNIT_OPTS}
                      onCommit={(unit) => setToleranceTable(withBand(table, i, { unit }))}
                    />
                  </td>
                  <td>
                    <button
                      className="cavtable__del"
                      title="Remove band"
                      onClick={() => setToleranceTable(withoutBand(table, i))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pf-actions tol__actions">
            <button onClick={() => setToleranceTable(withNewBand(table))}>+ Band</button>
            <button
              title="Replace the bands with IPC/WHMA-A-620's (the title is kept)"
              onClick={() => setToleranceTable({ ...table, bands: ipcToleranceTable().bands })}
            >
              Reset to IPC/WHMA-A-620
            </button>
          </div>
        </>
      )}
    </>
  )
}
