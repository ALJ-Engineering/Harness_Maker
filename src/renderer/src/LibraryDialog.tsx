import { useMemo, useState } from 'react'
import { newLibraryPart, PART_KINDS, type LibraryPart, type PartKind } from '@shared/parts/librarySchema'
import { searchParts } from '@shared/parts/search'
import { sanitisePartNumber } from '@shared/parts/images'
import { LibraryPartForm } from './LibraryPartForm'
import type { PartsLibrary } from './usePartsLibrary'
import type { PartImageLibrary } from './usePartImages'

/**
 * The dialog's whole state as `App.tsx` sees it: `null` (closed), a plain
 * browser, or the editor pre-filled from a document entity's
 * `Save to library…` button. Everything past that entry point — which part is
 * selected, whether the form is open, browse vs. edit — is this component's
 * own business (see `View` below); the parent only decides how the dialog
 * gets OPENED, never what it does once it's up.
 */
export type LibraryDlgState = null | { mode: 'browse' } | { mode: 'edit'; part: LibraryPart; isNew?: boolean }

type View = { mode: 'browse' } | { mode: 'edit'; part: LibraryPart; isNew: boolean }

const KIND_FILTER_OPTS: { value: PartKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All kinds' },
  ...PART_KINDS.map((k) => ({ value: k, label: k }))
]

/**
 * The parts library browser + editor. Opened from the toolbar `Library…`
 * button, the `Parts library…` menu item, or a body editor's
 * `Save to library…` (which lands straight in edit mode). This is the ONE
 * place a `LibraryPart` record is authored — the properties panel's
 * `PartPicker` only ever chooses an existing one.
 */
export function LibraryDialog({
  state,
  library,
  parts,
  onClose,
  onPlace
}: {
  state: Exclude<LibraryDlgState, null>
  library: PartsLibrary
  parts: PartImageLibrary
  onClose: () => void
  onPlace: (part: LibraryPart) => void
}): React.JSX.Element {
  const [view, setView] = useState<View>(
    state.mode === 'edit' ? { mode: 'edit', part: state.part, isNew: !!state.isNew } : { mode: 'browse' }
  )
  const [selectedPn, setSelectedPn] = useState<string | null>(
    state.mode === 'edit' ? state.part.partNumber : null
  )
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<PartKind | 'all'>('all')

  const results = useMemo(
    () => searchParts(library.parts, query, kindFilter === 'all' ? {} : { kinds: [kindFilter] }),
    [library.parts, query, kindFilter]
  )
  const selected = selectedPn ? library.byPn.get(selectedPn) : undefined

  const startEdit = (part: LibraryPart, isNew: boolean): void => setView({ mode: 'edit', part, isNew })

  const handleFormSave = async (p: LibraryPart): Promise<string | null> => {
    if (!p.partNumber.trim()) return 'a part number is required'
    if (view.mode === 'edit' && view.isNew && library.byPn.has(p.partNumber)) {
      return 'a part with this number already exists'
    }
    const err = await library.write(p)
    if (!err) {
      setSelectedPn(p.partNumber)
      setView({ mode: 'browse' })
    }
    return err
  }

  const handleDelete = (part: LibraryPart): void => {
    if (!window.confirm(`Delete ${part.partNumber} from the library?`)) return
    const withFiles = window.confirm('Also delete its picture and datasheet?')
    void library.remove(part.partNumber, withFiles)
    setSelectedPn(null)
  }

  if (!library.dir) {
    return (
      <div className="modal__backdrop" onClick={onClose}>
        <div className="modal" role="dialog" aria-label="Parts library" onClick={(e) => e.stopPropagation()}>
          <h3>Parts library</h3>
          <button className="panel__add" onClick={() => void library.chooseDir()}>
            Set the parts library folder&hellip;
          </button>
          <div className="modal__actions">
            <button className="panel__add" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal libdlg" role="dialog" aria-label="Parts library" onClick={(e) => e.stopPropagation()}>
        {view.mode === 'edit' ? (
          <>
            <h3>{view.isNew ? 'New part' : `Edit ${view.part.partNumber}`}</h3>
            <LibraryPartForm
              part={view.part}
              library={library}
              parts={parts}
              isNew={view.isNew}
              onSave={handleFormSave}
              onCancel={() => setView({ mode: 'browse' })}
            />
          </>
        ) : (
          <>
            <h3>Parts library</h3>
            <div className="libdlg__toolbar">
              <input
                className="pf__input"
                type="text"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="pf__input"
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value as PartKind | 'all')}
              >
                {KIND_FILTER_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                className="panel__add"
                title="Refresh"
                onClick={() => {
                  void library.refresh()
                  void parts.refresh()
                }}
              >
                &#x21bb;
              </button>
            </div>
            <div className="libdlg__body">
              <div className="libdlg__list">
                {results.length === 0 && <p className="panel__hint">No parts found.</p>}
                {results.map((p) => (
                  <button
                    key={p.partNumber}
                    className={
                      p.partNumber === selectedPn ? 'libdlg__row libdlg__row--sel' : 'libdlg__row'
                    }
                    onClick={() => setSelectedPn(p.partNumber)}
                  >
                    <span className="libdlg__row-pn">{p.partNumber}</span>
                    <span className="libdlg__row-desc">{p.description}</span>
                    <span className="libdlg__row-glyphs">
                      {parts.byStem[sanitisePartNumber(p.partNumber)] && <span title="Has picture">📷</span>}
                      {library.hasDatasheet(p.partNumber) && <span title="Has datasheet">📄</span>}
                    </span>
                  </button>
                ))}
              </div>
              <div className="libdlg__detail">
                {selected ? (
                  <LibraryPartDetail
                    part={selected}
                    library={library}
                    parts={parts}
                    onEdit={() => startEdit(selected, false)}
                    onDuplicate={() => startEdit({ ...selected, partNumber: '' }, true)}
                    onDelete={() => handleDelete(selected)}
                    onPlace={() => onPlace(selected)}
                  />
                ) : (
                  <p className="panel__hint">Select a part to see details.</p>
                )}
              </div>
            </div>
            {library.errors.length > 0 && (
              <details className="libdlg__errors">
                <summary>{library.errors.length} file(s) could not be read</summary>
                <ul>
                  {library.errors.map((e, i) => (
                    <li key={i}>
                      {e.file} — {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="modal__actions">
              <button className="panel__add" onClick={() => startEdit(newLibraryPart('connector', ''), true)}>
                New part&hellip;
              </button>
              <button className="panel__add" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Read-only detail pane for the selected part in browse mode. */
function LibraryPartDetail({
  part,
  library,
  parts,
  onEdit,
  onDuplicate,
  onDelete,
  onPlace
}: {
  part: LibraryPart
  library: PartsLibrary
  parts: PartImageLibrary
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onPlace: () => void
}): React.JSX.Element {
  const image = parts.byStem[sanitisePartNumber(part.partNumber)]
  const canPlace = part.kind === 'connector' || part.kind === 'terminal' || part.kind === 'splice'

  return (
    <div className="libdlg__detail-body">
      <div className="libdlg__detail-head">
        <strong>{part.partNumber}</strong> <span className="panel__hint">{part.kind}</span>
      </div>
      {image && <img className="picture-row__thumb" src={image.href} alt="" />}
      <div>{part.description}</div>
      {part.manufacturer && <div className="panel__hint">{part.manufacturer}</div>}
      {part.notes && <div className="panel__hint">{part.notes}</div>}

      {part.kind === 'connector' && part.connector && (
        <>
          {part.connector.gender && <div className="panel__hint">Gender: {part.connector.gender}</div>}
          {part.connector.matesWith && <div className="panel__hint">Mates with: {part.connector.matesWith}</div>}
          <table className="cavtable">
            <thead>
              <tr>
                <th>Pos</th>
                <th>Default pin</th>
                <th>Default seal</th>
              </tr>
            </thead>
            <tbody>
              {part.connector.cavities.map((c, i) => (
                <tr key={i}>
                  <td>{c.position}</td>
                  <td>{c.defaultPin ?? ''}</td>
                  <td>{c.defaultSeal ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {part.kind === 'terminal' && part.terminal && (
        <div className="panel__hint">
          {part.terminal.kind}
          {part.terminal.studMm !== undefined ? ` · stud ${part.terminal.studMm} mm` : ''}
        </div>
      )}
      {part.kind === 'splice' && part.splice && <div className="panel__hint">{part.splice.kind}</div>}
      {part.kind === 'wire' && part.wire && (
        <div className="panel__hint">
          {part.wire.gauge.value} {part.wire.gauge.unit}
          {part.wire.color ? ` · ${part.wire.color}` : ''}
        </div>
      )}

      <div className="libdlg__detail-actions">
        <button className="panel__add" onClick={onEdit}>
          Edit
        </button>
        <button className="panel__add" onClick={onDuplicate}>
          Duplicate
        </button>
        <button className="panel__add" onClick={onDelete}>
          Delete
        </button>
        <button
          className="panel__add"
          disabled={!library.hasDatasheet(part.partNumber)}
          onClick={() => void library.openDatasheet(part.partNumber)}
        >
          Open datasheet
        </button>
        {canPlace && (
          <button className="libdlg__place" onClick={onPlace}>
            Place on board
          </button>
        )}
      </div>
    </div>
  )
}
