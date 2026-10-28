import { Fragment, useState } from 'react'
import type { FreeTerminalKind, GaugeUnit, SpliceKind } from '@shared/model/schema'
import {
  newLibraryPart,
  type LibraryCableCore,
  type LibraryCavity,
  type LibraryLead,
  type LibraryPart,
  type PartKind
} from '@shared/parts/librarySchema'
import { PART_KINDS } from '@shared/parts/librarySchema'
import { sanitisePartNumber } from '@shared/parts/images'
import { Field, NumberEdit, SelectEdit, TextEdit } from './panel/fields'
import { PictureRow } from './panel/PictureRow'
import type { PartsLibrary } from './usePartsLibrary'
import type { PartImageLibrary } from './usePartImages'

const KIND_OPTS: { value: PartKind; label: string }[] = PART_KINDS.map((k) => ({ value: k, label: k }))

const GENDER_OPTS: { value: '' | 'male' | 'female' | 'hybrid'; label: string }[] = [
  { value: '', label: '(unspecified)' },
  { value: 'male', label: 'male' },
  { value: 'female', label: 'female' },
  { value: 'hybrid', label: 'hybrid' }
]

const TERMINAL_KIND_OPTS: { value: FreeTerminalKind; label: string }[] = [
  { value: 'ring', label: 'ring' },
  { value: 'ferrule', label: 'ferrule' },
  { value: 'eyelet', label: 'eyelet' },
  { value: 'blade', label: 'blade' },
  { value: 'fork', label: 'fork' },
  { value: 'bare', label: 'bare' },
  { value: 'tinned', label: 'tinned' }
]

const SPLICE_KIND_OPTS: { value: SpliceKind; label: string }[] = [
  { value: 'butt', label: 'butt' },
  { value: 'solder_sleeve', label: 'solder sleeve' },
  { value: 'clip', label: 'clip' },
  { value: 'weld', label: 'weld' },
  { value: 'ultrasonic', label: 'ultrasonic' }
]

const GAUGE_UNIT_OPTS: { value: GaugeUnit; label: string }[] = [
  { value: 'mm2', label: 'mm²' },
  { value: 'AWG', label: 'AWG' }
]

/**
 * The cavity template table for a connector library record. `LibraryCavity`
 * carries no id (unlike a document `Cavity`), so rows are addressed by index —
 * fine here since the only reordering operation is append/remove, never a
 * drag-sort. A cavity with a factory lead (an in-line fuse holder's pigtail)
 * has no default pin; its lead's size, colour and length go on a row of its own.
 */
function CavityTemplateTable({
  cavities,
  onChange
}: {
  cavities: LibraryCavity[]
  onChange: (next: LibraryCavity[]) => void
}): React.JSX.Element {
  const addCavity = (): void => {
    const used = new Set(cavities.map((c) => c.position))
    let n = 1
    while (used.has(String(n))) n++
    onChange([...cavities, { position: String(n) }])
  }

  const addN = (): void => {
    const raw = window.prompt('How many cavities to add?')
    if (raw === null) return
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n <= 0) return
    let maxNum = 0
    for (const c of cavities) {
      const v = Number(c.position)
      if (Number.isFinite(v) && v > maxNum) maxNum = v
    }
    const added: LibraryCavity[] = []
    for (let i = 1; i <= n; i++) added.push({ position: String(maxNum + i) })
    onChange([...cavities, ...added])
  }

  const update = (i: number, patch: Partial<LibraryCavity>): void => {
    const next = cavities.slice()
    const merged: LibraryCavity = { ...next[i], ...patch }
    if (merged.defaultPin === '') delete merged.defaultPin
    if (merged.defaultSeal === '') delete merged.defaultSeal
    if (merged.lead === undefined) delete merged.lead
    next[i] = merged
    onChange(next)
  }
  const updateLead = (i: number, patch: Partial<LibraryLead>): void => update(i, { lead: { ...cavities[i].lead, ...patch } })

  const remove = (i: number): void => onChange(cavities.filter((_, idx) => idx !== i))

  return (
    <>
      <div className="panel__subhead">
        Cavities ({cavities.length})
        <span className="pf-actions">
          <button className="panel__add" onClick={addCavity}>
            + Cavity
          </button>
          <button className="panel__add" onClick={addN}>
            Add N&hellip;
          </button>
        </span>
      </div>
      <table className="cavtable">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Default pin</th>
            <th>Default seal</th>
            <th>Lead</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {cavities.map((c, i) => (
            <Fragment key={i}>
              <tr>
                <td>
                  <TextEdit value={c.position} onCommit={(v) => update(i, { position: v })} />
                </td>
                <td>
                  {c.lead ? (
                    <span className="cavtable__lead">factory lead</span>
                  ) : (
                    <TextEdit
                      value={c.defaultPin ?? ''}
                      onCommit={(v) => update(i, { defaultPin: v.trim() || undefined })}
                    />
                  )}
                </td>
                <td>
                  <TextEdit
                    value={c.defaultSeal ?? ''}
                    onCommit={(v) => update(i, { defaultSeal: v.trim() || undefined })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    title="The maker fitted a wire lead here, so no contact goes in"
                    checked={c.lead !== undefined}
                    onChange={(e) =>
                      update(i, e.target.checked ? { lead: {}, defaultPin: undefined } : { lead: undefined })
                    }
                  />
                </td>
                <td>
                  <button className="cavtable__del" title="Remove cavity" onClick={() => remove(i)}>
                    &#x2715;
                  </button>
                </td>
              </tr>
              {c.lead && (
                <tr>
                  <td></td>
                  <td colSpan={4}>
                    <span className="pf__lead">
                      <NumberEdit
                        value={c.lead.gaugeMm2}
                        optional
                        min={0}
                        minExclusive
                        placeholder="size"
                        onCommit={(v) => updateLead(i, { gaugeMm2: v })}
                      />
                      mm²
                      <TextEdit
                        value={c.lead.color ?? ''}
                        placeholder="colour"
                        onCommit={(v) => updateLead(i, { color: v.trim().toUpperCase() || undefined })}
                      />
                      <NumberEdit
                        value={c.lead.lengthMm}
                        optional
                        min={0}
                        minExclusive
                        placeholder="length"
                        onCommit={(v) => updateLead(i, { lengthMm: v })}
                      />
                      mm
                    </span>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Read-only core list of a cable record — the CLI writes cores, the app only shows them. */
function CoresTable({ cores }: { cores: LibraryCableCore[] }): React.JSX.Element {
  return (
    <>
      <div className="panel__subhead">Cores ({cores.length})</div>
      <table className="cavtable">
        <thead>
          <tr>
            <th>Name</th>
            <th>Colour</th>
            <th>Gauge</th>
            <th>Pair</th>
          </tr>
        </thead>
        <tbody>
          {cores.map((c, i) => (
            <tr key={i}>
              <td>{c.name}</td>
              <td>{[c.color, ...(c.stripes ?? [])].join('/')}</td>
              <td>
                {c.gauge.value} {c.gauge.unit === 'mm2' ? 'mm\u00b2' : 'AWG'}
              </td>
              <td>{c.pair ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cores.length === 0 && (
        <div className="panel__hint">Cable cores are written by the harness CLI from the datasheet.</div>
      )}
    </>
  )
}

/**
 * The library record editor — the one place a `LibraryPart` is authored.
 * Holds the whole record as a single draft; only `Save` writes it back
 * (via `onSave`, which is `library.write` wrapped by `LibraryDialog` with the
 * duplicate/empty-part-number checks). `Cancel` discards every edit.
 *
 * NB: the design brief for this step also lists an "MPN" field alongside
 * description/manufacturer/datasheet URL, but `LibraryPart` (the schema that
 * is the source of truth, `src/shared/parts/librarySchema.ts`) has no such
 * field — only `manufacturer`. Per the artefacts-win rule, that field is
 * omitted here rather than invented.
 */
export function LibraryPartForm({
  part,
  library,
  parts,
  isNew,
  onSave,
  onCancel
}: {
  part: LibraryPart
  library: PartsLibrary
  parts: PartImageLibrary
  isNew: boolean
  onSave: (p: LibraryPart) => Promise<string | null>
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<LibraryPart>(part)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const onKindChange = (k: PartKind): void => {
    const seeded = newLibraryPart(k, draft.partNumber)
    seeded.description = draft.description
    if (draft.manufacturer) seeded.manufacturer = draft.manufacturer
    if (draft.datasheetUrl) seeded.datasheetUrl = draft.datasheetUrl
    if (draft.notes) seeded.notes = draft.notes
    setDraft(seeded)
    setError(null)
  }

  const handleSave = async (): Promise<void> => {
    setError(null)
    setSaving(true)
    const toSave: LibraryPart = { ...draft, partNumber: draft.partNumber.trim() }
    const err = await onSave(toSave)
    setSaving(false)
    if (err) setError(err)
  }

  const pn = draft.partNumber
  const image = pn ? parts.byStem[sanitisePartNumber(pn)] : undefined
  const hasDatasheet = pn ? library.hasDatasheet(pn) : false

  return (
    <div className="pf-form">
      <Field label="Part number">
        {isNew ? (
          <TextEdit
            value={draft.partNumber}
            placeholder="PN-0001"
            onCommit={(v) => setDraft((d) => ({ ...d, partNumber: v }))}
          />
        ) : (
          <span className="pf__ro">{draft.partNumber}</span>
        )}
      </Field>
      <Field label="Kind">
        <SelectEdit value={draft.kind} options={KIND_OPTS} onCommit={onKindChange} />
      </Field>
      <Field label="Description">
        <TextEdit
          value={draft.description}
          onCommit={(v) => setDraft((d) => ({ ...d, description: v }))}
        />
      </Field>
      <Field label="Manufacturer">
        <TextEdit
          value={draft.manufacturer ?? ''}
          onCommit={(v) => setDraft((d) => ({ ...d, manufacturer: v.trim() || undefined }))}
        />
      </Field>
      <Field label="Datasheet URL">
        <TextEdit
          value={draft.datasheetUrl ?? ''}
          placeholder="https://…"
          onCommit={(v) => setDraft((d) => ({ ...d, datasheetUrl: v.trim() || undefined }))}
        />
      </Field>
      <Field label="Notes">
        <TextEdit
          multiline
          value={draft.notes ?? ''}
          onCommit={(v) => setDraft((d) => ({ ...d, notes: v.trim() || undefined }))}
        />
      </Field>

      {draft.kind === 'connector' && (
        <>
          <Field label="Gender">
            <SelectEdit
              value={draft.connector?.gender ?? ''}
              options={GENDER_OPTS}
              onCommit={(v) =>
                setDraft((d) => ({
                  ...d,
                  connector: { ...(d.connector ?? { cavities: [] }), gender: v === '' ? undefined : v }
                }))
              }
            />
          </Field>
          <Field label="Mates with">
            <TextEdit
              value={draft.connector?.matesWith ?? ''}
              onCommit={(v) =>
                setDraft((d) => ({
                  ...d,
                  connector: { ...(d.connector ?? { cavities: [] }), matesWith: v.trim() || undefined }
                }))
              }
            />
          </Field>
          <CavityTemplateTable
            cavities={draft.connector?.cavities ?? []}
            onChange={(cavities) =>
              setDraft((d) => ({ ...d, connector: { ...(d.connector ?? { cavities: [] }), cavities } }))
            }
          />
        </>
      )}

      {draft.kind === 'cable' && <CoresTable cores={draft.cable?.cores ?? []} />}

      {draft.kind === 'terminal' && (
        <>
          <Field label="Kind">
            <SelectEdit
              value={draft.terminal?.kind ?? 'ring'}
              options={TERMINAL_KIND_OPTS}
              onCommit={(k) =>
                setDraft((d) => ({ ...d, terminal: { ...(d.terminal ?? { kind: 'ring' }), kind: k } }))
              }
            />
          </Field>
          <Field label="Stud (mm)">
            <NumberEdit
              value={draft.terminal?.studMm}
              optional
              min={0}
              onCommit={(v) =>
                setDraft((d) => ({ ...d, terminal: { ...(d.terminal ?? { kind: 'ring' }), studMm: v } }))
              }
            />
          </Field>
        </>
      )}

      {draft.kind === 'splice' && (
        <Field label="Kind">
          <SelectEdit
            value={draft.splice?.kind ?? 'butt'}
            options={SPLICE_KIND_OPTS}
            onCommit={(k) => setDraft((d) => ({ ...d, splice: { ...(d.splice ?? { kind: 'butt' }), kind: k } }))}
          />
        </Field>
      )}

      {draft.kind === 'wire' && (
        <>
          <Field label="Gauge">
            <div className="pf__gauge">
              <NumberEdit
                value={draft.wire?.gauge.value}
                min={0}
                onCommit={(v) =>
                  setDraft((d) => ({
                    ...d,
                    wire: { gauge: { value: v ?? 0, unit: d.wire?.gauge.unit ?? 'mm2' }, color: d.wire?.color }
                  }))
                }
              />
              <SelectEdit
                value={draft.wire?.gauge.unit ?? 'mm2'}
                options={GAUGE_UNIT_OPTS}
                onCommit={(u) =>
                  setDraft((d) => ({
                    ...d,
                    wire: { gauge: { value: d.wire?.gauge.value ?? 0, unit: u }, color: d.wire?.color }
                  }))
                }
              />
            </div>
          </Field>
          <Field label="Colour">
            <TextEdit
              value={draft.wire?.color ?? ''}
              onCommit={(v) =>
                setDraft((d) => ({
                  ...d,
                  wire: { gauge: d.wire?.gauge ?? { value: 0, unit: 'mm2' }, color: v.trim() || undefined }
                }))
              }
            />
          </Field>
        </>
      )}

      <PictureRow
        partNumber={pn}
        image={image}
        dir={parts.dir}
        onChoose={() => pn && void parts.importFor(pn)}
        onRemove={() => pn && void parts.remove(pn)}
        onChooseDir={() => void library.chooseDir()}
      />

      <Field label="Datasheet">
        <span className="pf-actions">
          <button
            className="panel__add"
            disabled={!hasDatasheet}
            onClick={() => pn && void library.openDatasheet(pn)}
          >
            Open
          </button>
          <button className="panel__add" onClick={() => pn && void library.importDatasheet(pn)}>
            Set PDF&hellip;
          </button>
          <button
            className="panel__add"
            disabled={!hasDatasheet}
            onClick={() => {
              if (pn && window.confirm(`Remove the datasheet for ${pn}?`)) void library.removeDatasheet(pn)
            }}
          >
            Remove
          </button>
        </span>
      </Field>

      {error && <p className="pf-error">{error}</p>}
      <div className="modal__actions">
        <button onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button onClick={() => void handleSave()} disabled={saving}>
          Save
        </button>
      </div>
    </div>
  )
}
