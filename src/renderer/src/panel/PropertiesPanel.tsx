import { useState } from 'react'
import type { Draft } from 'immer'
import { useHarnessStore, wiresOnBodies } from '../store'
import { describeEndpoint } from '../flow/toFlow'
import { screenStroke } from '../flow/screenColors'
import type { ThemeName } from '../useTheme'
import { newId } from '@shared/model/ids'
import type {
  HarnessDocument,
  Connector,
  Wire,
  FreeTerminal,
  Splice,
  Segment,
  Bundle,
  Sleeving,
  SleevingType,
  Twist,
  Label,
  LabelKind,
  CavityStatus,
  GaugeUnit,
  FreeTerminalKind,
  SpliceKind
} from '@shared/model/schema'
import { Field, TextEdit, NumberEdit, SelectEdit } from './fields'
import { PictureRow } from './PictureRow'
import { PartPicker } from './PartPicker'
import { ColorPicker } from './ColorPicker'
import { DocumentProperties } from './DocumentProperties'
import { primaryPartNumber } from '@shared/model/bodyParts'
import type { PartImageLibrary } from '../usePartImages'
import type { PartsLibrary } from '../usePartsLibrary'
import type { LibraryPart } from '@shared/parts/librarySchema'
import { partFromConnector, partFromFreeTerminal, partFromSplice } from '@shared/parts/instantiate'
import {
  wireLength,
  segmentLengthMm,
  effectiveSegmentLengthMm,
  segmentLengthBroken,
  spanLengthMm,
  bundleLengthMm
} from '@shared/model/geometry'
import {
  twistSpanSegments,
  sleevingFromSegments,
  sleevingBundleFromSegments,
  wireRoutePath,
  labelDefaultPos,
  anchorMmFromNearestEnd,
  anchorFractionFromNearestEnd
} from '@shared/model/treatments'
import { LABEL_KIND_LABELS } from '@shared/model/formboard'
import { sortedCavities, natCompare } from '@shared/model/anchors'
import { colorName } from '@shared/model/colors'

export type Selection =
  | { kind: 'none' }
  | { kind: 'multi'; count: number; nodeIds: string[]; edgeIds: string[] }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'sleeving'; id: string }
  | { kind: 'twist'; id: string }
  | { kind: 'label'; id: string }

type Edit = (recipe: (d: Draft<HarnessDocument>) => void) => void

/** A designator field's commit value: trimmed, or null when blank (not committed). */
export function commitDesignator(value: string): string | null {
  const v = value.trim()
  return v === '' ? null : v
}

/**
 * The inspector card's header line: WHAT is selected on top, what kind of thing
 * it is underneath. Purely presentational — each editor below keeps its own
 * `.panel__kind` heading, which is the section label for its fields.
 *
 * Nothing selected is a real state with real editors behind it (the document's
 * sheet, grid and title block), so it gets a header of its own rather than
 * hiding the card.
 */
export function inspectorHeader(
  doc: HarnessDocument,
  selection: Selection
): { title: string; subtitle: string } {
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

  if (selection.kind === 'none') {
    return {
      title: doc.drawing.titleBlock?.partNumber || 'Document',
      subtitle: doc.drawing.titleBlock?.title || 'Nothing selected'
    }
  }
  if (selection.kind === 'multi') {
    return {
      title: plural(selection.count, 'item') + ' selected',
      subtitle: `${plural(selection.nodeIds.length, 'node')} · ${plural(selection.edgeIds.length, 'edge')}`
    }
  }
  if (selection.kind === 'sleeving') {
    const sl = doc.sleeving.find((x) => x.id === selection.id)
    return sl
      ? { title: sl.sleevingType, subtitle: `Sleeving · ${plural(sl.span.segmentIds.length, 'segment')}` }
      : { title: 'Sleeving', subtitle: 'not found' }
  }
  if (selection.kind === 'twist') {
    const tw = doc.twists.find((x) => x.id === selection.id)
    return tw
      ? { title: 'Twist', subtitle: plural(tw.wireIds.length, 'wire') }
      : { title: 'Twist', subtitle: 'not found' }
  }
  if (selection.kind === 'label' || doc.labels.some((l) => l.id === selection.id)) {
    const lb = doc.labels.find((x) => x.id === selection.id)
    return lb
      ? { title: lb.text || LABEL_KIND_LABELS[lb.kind], subtitle: `Label · ${LABEL_KIND_LABELS[lb.kind]}` }
      : { title: 'Label', subtitle: 'not found' }
  }
  if (selection.kind === 'edge') {
    const i = doc.wires.findIndex((w) => w.id === selection.id)
    const wire = doc.wires[i]
    if (wire) {
      const stripes = wire.color.stripes?.length ? '/' + wire.color.stripes.join('/') : ''
      return {
        title: `W${i + 1}`,
        subtitle: `Wire · ${wire.color.base}${stripes} ${wire.gauge.value} ${wire.gauge.unit}`
      }
    }
    const seg = doc.segments.find((s) => s.id === selection.id)
    if (seg) {
      const len = effectiveSegmentLengthMm(doc, seg.id)
      return { title: 'Limb', subtitle: `Segment${len == null ? '' : ` · ${Math.round(len)} mm`}` }
    }
    return { title: 'Properties', subtitle: 'not found' }
  }
  // kind === 'node': one of the three body types (or a label, handled above).
  const conn = doc.connectors.find((c) => c.id === selection.id)
  if (conn) {
    return {
      title: conn.designator || 'Connector',
      subtitle: `Connector${conn.housing?.partNumber ? ` · ${conn.housing.partNumber}` : ''}`
    }
  }
  const ft = doc.freeTerminals.find((f) => f.id === selection.id)
  if (ft) {
    return {
      title: ft.designator,
      subtitle: `Free terminal · ${ft.kind}${ft.landsOn ? ` · ${ft.landsOn}` : ''}`
    }
  }
  const sp = doc.splices.find((s) => s.id === selection.id)
  if (sp) return { title: sp.designator, subtitle: `Splice · ${sp.kind}` }
  return { title: 'Properties', subtitle: 'not found' }
}

/**
 * The header's Remove button for a placed body, or null when the selection is
 * not one. Schematic only — deleting a formboard dot raises segment and route
 * questions that view does not answer. The tooltip names the wires that go
 * with it, so the cascade is visible before it happens.
 */
export function bodyRemoval(
  doc: HarnessDocument,
  selection: Selection,
  viewMode: 'schematic' | 'formboard'
): { label: string; title: string } | null {
  if (viewMode !== 'schematic' || selection.kind !== 'node') return null
  const id = selection.id
  const conn = doc.connectors.find((c) => c.id === id)
  const ft = conn ? undefined : doc.freeTerminals.find((f) => f.id === id)
  const sp = conn || ft ? undefined : doc.splices.find((x) => x.id === id)
  const [label, name] = conn
    ? ['Remove connector', conn.designator || 'the connector']
    : ft
      ? ['Remove terminal', ft.designator]
      : sp
        ? ['Remove splice', sp.designator]
        : [null, null]
  if (!label) return null
  const n = wiresOnBodies(doc, [id]).length
  const title = n === 0 ? `Removes ${name}` : `Removes ${name} and ${n} wire${n === 1 ? '' : 's'}`
  return { label, title }
}

export function PropertiesPanel({
  selection,
  viewMode,
  theme,
  parts,
  library,
  onSaveToLibrary,
  onSelectTreatment,
  onClearSelection
}: {
  selection: Selection
  viewMode: 'schematic' | 'formboard'
  /**
   * The current UI theme, PROP-THREADED rather than read from `<html>`.
   * `useTheme` writes `data-theme` in an effect, i.e. AFTER the render that the
   * toggle causes, so a `currentTheme()` call in a render body here returns the
   * OUTGOING theme and nothing re-renders this panel afterwards — a selected
   * black wire's swatch would sit at the old colour until an unrelated click.
   * Same reason the canvas gets it through the projection.
   */
  theme: ThemeName
  /** The parts image library (`usePartImages`) — owned by `App.tsx`, which also
      hands the same map to the canvas projection, so panel and board agree. */
  parts: PartImageLibrary
  /** The parts library (`usePartsLibrary`) — backs every `PartPicker` field and
      the Apply-cavity-template / Save-to-library controls below. */
  library: PartsLibrary
  /** Opens the library dialog in edit mode, pre-filled from a document entity
      (Task 10 supplies the dialog). */
  onSaveToLibrary: (part: LibraryPart) => void
  onSelectTreatment: (kind: 'sleeving' | 'twist' | 'label', id: string) => void
  /**
   * Clears the shell's selection — the card's × button, and the only control
   * this restyle adds. Optional so the panel can render with no
   * shell around it; with no handler the × simply isn't rendered.
   */
  onClearSelection?: () => void
}): React.JSX.Element {
  const doc = useHarnessStore((s) => s.doc)
  const applyEdit = useHarnessStore((s) => s.applyEdit)
  const setExitSide = useHarnessStore((s) => s.setExitSide)
  const removeElements = useHarnessStore((s) => s.removeElements)
  // Collapsed to its header, like a closed drop-down, so the card stops
  // covering the canvas. The header still names what is selected.
  const [collapsed, setCollapsed] = useState(false)

  let body: React.ReactNode
  if (selection.kind === 'none') {
    body = (
      <>
        <p className="panel__hint">Select a connector, wire, or terminal to edit it.</p>
        <DocumentProperties doc={doc} />
      </>
    )
  } else if (selection.kind === 'multi') {
    body = <p className="panel__hint">{selection.count} items selected.</p>
  } else if (selection.kind === 'edge') {
    // Schematic edges are wires (edge id = wire id); formboard edges are routing
    // segments (edge id = segment id). Resolve whichever it is.
    const wire = doc.wires.find((w) => w.id === selection.id)
    const seg = doc.segments.find((s) => s.id === selection.id)
    body = wire ? (
      <WireEditor
        doc={doc}
        wire={wire}
        edit={applyEdit}
        viewMode={viewMode}
        theme={theme}
        library={library}
      />
    ) : seg ? (
      <SegmentInfo doc={doc} seg={seg} theme={theme} library={library} />
    ) : (
      <p className="panel__hint">Item not found.</p>
    )
  } else if (selection.kind === 'sleeving') {
    const sl = doc.sleeving.find((x) => x.id === selection.id)
    body = sl ? (
      <SleevingEditor sl={sl} doc={doc} edit={applyEdit} />
    ) : (
      <p className="panel__hint">Item not found.</p>
    )
  } else if (selection.kind === 'twist') {
    const tw = doc.twists.find((x) => x.id === selection.id)
    body = tw ? (
      <TwistEditor tw={tw} doc={doc} edit={applyEdit} />
    ) : (
      <p className="panel__hint">Item not found.</p>
    )
  } else if (selection.kind === 'label') {
    const lb = doc.labels.find((x) => x.id === selection.id)
    body = lb ? (
      <LabelEditor lb={lb} edit={applyEdit} doc={doc} />
    ) : (
      <p className="panel__hint">Item not found.</p>
    )
  } else {
    const conn = doc.connectors.find((c) => c.id === selection.id)
    if (conn) {
      body = (
        <ConnectorEditor
          conn={conn}
          doc={doc}
          edit={applyEdit}
          setExitSide={setExitSide}
          viewMode={viewMode}
          parts={parts}
          library={library}
          onSaveToLibrary={onSaveToLibrary}
        />
      )
    } else {
      const ft = doc.freeTerminals.find((f) => f.id === selection.id)
      if (ft) {
        body = (
          <FreeTerminalEditor
            ft={ft}
            doc={doc}
            edit={applyEdit}
            parts={parts}
            library={library}
            onSaveToLibrary={onSaveToLibrary}
          />
        )
      } else {
        const sp = doc.splices.find((s) => s.id === selection.id)
        if (sp) {
          body = (
            <SpliceEditor
              sp={sp}
              doc={doc}
              edit={applyEdit}
              parts={parts}
              library={library}
              onSaveToLibrary={onSaveToLibrary}
            />
          )
        } else {
          // A label is a draggable formboard node; clicking it selects as 'node'.
          const lb = doc.labels.find((l) => l.id === selection.id)
          body = lb ? (
            <LabelEditor lb={lb} edit={applyEdit} doc={doc} />
          ) : (
            <p className="panel__hint">Item not found.</p>
          )
        }
      }
    }
  }

  const head = inspectorHeader(doc, selection)
  const removal = bodyRemoval(doc, selection, viewMode)

  return (
    <aside className={`panel${collapsed ? ' panel--collapsed' : ''}`}>
      <div className="panel__head">
        <button
          className="panel__toggle"
          title={collapsed ? 'Expand properties' : 'Minimise properties'}
          aria-label={collapsed ? 'Expand properties' : 'Minimise properties'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <div className="panel__head-text">
          <div className="panel__head-title" title={head.title}>
            {head.title}
          </div>
          <div className="panel__head-sub" title={head.subtitle}>
            {head.subtitle}
          </div>
        </div>
        {removal && selection.kind === 'node' && (
          <button
            className="panel__remove"
            title={removal.title}
            onClick={() => {
              // The same store action as Delete/Backspace, so the two cannot diverge.
              removeElements({ bodyIds: [selection.id], wireIds: [] })
              onClearSelection?.()
            }}
          >
            {removal.label}
          </button>
        )}
        {onClearSelection && selection.kind !== 'none' && (
          <button
            className="panel__close"
            title="Clear selection"
            aria-label="Clear selection"
            onClick={onClearSelection}
          >
            ×
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="panel__scroll">
          <CreateActions doc={doc} selection={selection} viewMode={viewMode} onCreated={onSelectTreatment} />
          {body}
          <TreatmentsList doc={doc} selectedId={'id' in selection ? selection.id : null} onSelect={onSelectTreatment} />
        </div>
      )}
    </aside>
  )
}

// ──────────────────────────────── Segment ────────────────────────────────

/** Info for a routing segment (selected in the formboard view): its drawn
 *  length, its typed (manufacturing) length — the one editable field — and the
 *  wire(s) routed through it. Add/remove branch points via right-click; wire
 *  properties via the schematic. */
function SegmentInfo({
  doc,
  seg,
  theme,
  library
}: {
  doc: HarnessDocument
  seg: Segment
  theme: ThemeName
  library: PartsLibrary
}): React.JSX.Element {
  const len = segmentLengthMm(doc, seg.id)
  const broken = segmentLengthBroken(doc, seg.id)
  const setSegmentLength = useHarnessStore((s) => s.setSegmentLength)
  const wireIds = doc.wireRoutes.filter((r) => r.path.includes(seg.id)).map((r) => r.wireId)
  // A shared limb belongs to a bundle (syncBundles derives them) — offer its
  // loom-tape part here; the bundle has no node of its own to select.
  const bundle = doc.bundles.find((b) => b.segmentIds.includes(seg.id))
  return (
    <div className="panel__section">
      <div className="panel__kind">Segment</div>
      <Field label="Drawn length">
        <span className="pf__ro">{len == null ? 'unknown' : `${Math.round(len)} mm`}</span>
      </Field>
      <Field label="Typed length (mm)">
        <NumberEdit
          value={seg.specifiedLengthMm === undefined ? undefined : Math.round(seg.specifiedLengthMm * 10) / 10}
          optional
          step={1}
          min={0}
          minExclusive
          placeholder="= drawn"
          onCommit={(v) => setSegmentLength(seg.id, v ?? null)}
        />
      </Field>
      {broken && (
        <p className="panel__hint">
          Drawn length no longer matches the typed one — press an arrow beside the red label on the
          formboard to rescale.
        </p>
      )}
      <div className="panel__subhead">Carries ({wireIds.length})</div>
      {wireIds.length === 0 ? (
        <p className="panel__hint">No wire routed through this segment.</p>
      ) : (
        <table className="cavtable">
          <tbody>
            {wireIds.map((wid) => {
              const i = doc.wires.findIndex((w) => w.id === wid)
              const w = doc.wires[i]
              const colour = w
                ? `${w.color.base}${w.color.stripes?.length ? '/' + w.color.stripes.join('/') : ''}`
                : '?'
              return (
                <tr key={wid}>
                  <td>W{i + 1}</td>
                  <td>{w ? `${w.gauge.value} ${w.gauge.unit}` : ''}</td>
                  <td>
                    <span
                      className="pf__swatch"
                      style={{ background: screenStroke(w?.color.base ?? 'GY', theme) }}
                    />{' '}
                    {colour}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {bundle && <BundleEditor doc={doc} bundle={bundle} library={library} />}
    </div>
  )
}

/** Bundle properties for the bundle this segment belongs to. Members and run are
 *  derived (syncBundles owns them); the only authored field is the loom tape /
 *  spiral wrap part, which becomes one length-based BOM line over the whole run. */
function BundleEditor({
  doc,
  bundle,
  library
}: {
  doc: HarnessDocument
  bundle: Bundle
  library: PartsLibrary
}): React.JSX.Element {
  const setBundlePart = useHarnessStore((s) => s.setBundlePart)
  const len = bundleLengthMm(doc, bundle)
  return (
    <>
      <div className="panel__subhead">Bundle</div>
      <Field label="Run">
        <span className="pf__ro">
          {bundle.segmentIds.length} seg{len != null ? ` · ${Math.round(len)} mm` : ''} ·{' '}
          {bundle.memberWireIds.length} wires
        </span>
      </Field>
      <Field label="Loom tape part">
        <PartPicker
          value={bundle.part}
          kinds={['tape']}
          library={library}
          onCommit={(ref) => setBundlePart(bundle.id, ref)}
        />
      </Field>
      <p className="panel__hint">Tape/wrap over the whole bundle run — one BOM line, length from the run. Clear the field to remove it.</p>
    </>
  )
}

// ──────────────────────────────── Wire ────────────────────────────────

const UNIT_OPTS: { value: GaugeUnit; label: string }[] = [
  { value: 'mm2', label: 'mm²' },
  { value: 'AWG', label: 'AWG' }
]

function WireEditor({
  doc,
  wire,
  edit,
  viewMode,
  theme,
  library
}: {
  doc: HarnessDocument
  wire: Wire
  edit: Edit
  viewMode: 'schematic' | 'formboard'
  theme: ThemeName
  library: PartsLibrary
}): React.JSX.Element {
  const set = (fn: (w: Wire) => void): void =>
    edit((d) => {
      const w = d.wires.find((x) => x.id === wire.id)
      if (w) fn(w)
    })
  // The two mm overrides go through validating store actions, not `set`.
  const setWireLengthOverride = useHarnessStore((st) => st.setWireLengthOverride)
  const setWireAllowance = useHarnessStore((st) => st.setWireAllowance)

  const stripes = wire.color.stripes ?? []

  return (
    <div className="panel__section">
      <div className="panel__kind">Wire</div>

      <Field label="From">
        <span className="pf__ro">{describeEndpoint(doc, wire.ends[0])}</span>
      </Field>
      <Field label="To">
        <span className="pf__ro">{describeEndpoint(doc, wire.ends[1])}</span>
      </Field>

      <Field label="Colour (IEC)">
        <span className="pf__colorrow">
          <span className="pf__swatch" style={{ background: screenStroke(wire.color.base, theme) }} />
          <ColorPicker
            value={wire.color.base}
            theme={theme}
            placeholder="RD, BK, BU…"
            onCommit={(code) => set((w) => (w.color.base = code))}
          />
        </span>
      </Field>
      {/* The picker comes FIRST in the <label>: clicking the row's label text
          activates the label's first control, which must not be a chip's ×. */}
      <Field label="Stripes">
        <span className="pf__stripes">
          <ColorPicker
            value=""
            adder
            theme={theme}
            placeholder={stripes.length ? 'add a stripe…' : 'none: pick to add'}
            onCommit={(code) =>
              set((w) => {
                const cur = w.color.stripes ?? []
                if (!cur.includes(code)) w.color.stripes = [...cur, code]
              })
            }
          />
          {stripes.length > 0 && (
            <span className="pf__chips">
              {stripes.map((code, i) => (
                <span key={code} className="pf__chip" title={colorName(code)}>
                  <span className="pf__swatch" style={{ background: screenStroke(code, theme) }} />
                  {code}
                  <button
                    className="pf__chip-del"
                    title={`Remove the ${colorName(code)} stripe`}
                    onClick={() =>
                      set((w) => {
                        const rest = (w.color.stripes ?? []).filter((_, j) => j !== i)
                        w.color.stripes = rest.length ? rest : undefined
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </span>
          )}
        </span>
      </Field>

      <Field label="Gauge">
        <span className="pf__gauge">
          <NumberEdit
            value={wire.gauge.value}
            step={0.1}
            onCommit={(v) => v !== undefined && set((w) => (w.gauge.value = v))}
          />
          <SelectEdit
            value={wire.gauge.unit}
            options={UNIT_OPTS}
            onCommit={(u) => set((w) => (w.gauge.unit = u))}
          />
        </span>
      </Field>

      <Field label="Length">
        <span className="pf__ro">
          {(() => {
            const len = wireLength(doc, wire.id)
            return len.mm === null
              ? 'unknown'
              : `${Math.round(len.mm)} mm${len.source === 'specified' ? ' (specified)' : ''}`
          })()}
        </span>
      </Field>

      <Field label="Length override (mm)">
        {viewMode === 'schematic' ? (
          <span className="pf__ro">
            {wire.specifiedLengthMm != null ? `${wire.specifiedLengthMm} mm` : '—'}
          </span>
        ) : (
          <NumberEdit
            value={wire.specifiedLengthMm}
            optional
            min={0}
            placeholder="from route"
            // Validating store action: negative / NaN / non-finite is rejected
            // outright (no write, no undo entry). 0 is legal. Empty clears it.
            onCommit={(v) => setWireLengthOverride(wire.id, v)}
          />
        )}
      </Field>

      <Field label="Allowance (mm)">
        {viewMode === 'schematic' ? (
          <span className="pf__ro">{wire.addLengthMm != null ? `${wire.addLengthMm} mm` : '—'}</span>
        ) : (
          <NumberEdit
            value={wire.addLengthMm}
            optional
            min={0}
            placeholder="strip/loop"
            onCommit={(v) => setWireAllowance(wire.id, v)}
          />
        )}
      </Field>

      <Field label="Wire part">
        <PartPicker
          value={wire.spec}
          kinds={['wire']}
          library={library}
          onCommit={(ref) => set((w) => (w.spec = ref))}
        />
      </Field>

      <Field label="Notes">
        <TextEdit
          multiline
          value={wire.notes ?? ''}
          onCommit={(v) => set((w) => (w.notes = v.trim() || undefined))}
        />
      </Field>
    </div>
  )
}

// ────────────────────────────── Connector ──────────────────────────────

const GENDER_OPTS = [
  { value: '', label: '—' },
  { value: 'male', label: 'male' },
  { value: 'female', label: 'female' },
  { value: 'hybrid', label: 'hybrid' }
] as const

const STATUS_OPTS: { value: CavityStatus; label: string }[] = [
  { value: 'populated', label: 'populated' },
  { value: 'plugged', label: 'plugged' },
  { value: 'empty', label: 'empty' }
]

/**
 * `PictureRow` bound to one body: the picture is keyed by the body's PRIMARY
 * part (housing / terminal part / splice part), which is exactly what the
 * picture planner draws, so all three editors share one adapter rather than
 * three copies of the same lookup.
 */
function BodyPictureRow({
  doc,
  id,
  parts
}: {
  doc: HarnessDocument
  id: string
  parts: PartImageLibrary
}): React.JSX.Element {
  const pn = primaryPartNumber(doc, id)
  // Orientation is per DOCUMENT and per BODY (`drawing.blocks.pictureView`),
  // not per part — turning X1's photo must not turn X2's, which shows the same
  // housing.
  const setPictureView = useHarnessStore((s) => s.setPictureView)
  const flipPicture = useHarnessStore((s) => s.flipPicture)
  return (
    <PictureRow
      partNumber={pn}
      image={pn ? parts.images[pn] : undefined}
      dir={parts.dir}
      onChoose={() => pn && void parts.importFor(pn)}
      onRemove={() => pn && void parts.remove(pn)}
      onChooseDir={() => void parts.chooseDir()}
      view={doc.drawing.blocks?.pictureView?.[id]}
      onRotation={(deg) => setPictureView(id, { rotationDeg: deg })}
      onFlip={(axis) => flipPicture(id, axis)}
    />
  )
}

// 'nearest': each wire leaves its pin row on the side facing its other end —
// for inline parts (a fuse, a diode, a relay) wired from both sides.
const EXIT_SIDE_SCHEMATIC_OPTS: { value: 'left' | 'right' | 'nearest'; label: string }[] = [
  { value: 'left', label: 'left' },
  { value: 'right', label: 'right' },
  { value: 'nearest', label: 'nearest (inline parts)' }
]

function ConnectorEditor({
  conn,
  doc,
  edit,
  setExitSide,
  viewMode,
  parts,
  library,
  onSaveToLibrary
}: {
  conn: Connector
  doc: HarnessDocument
  edit: Edit
  setExitSide: (connectorId: string, side: 'left' | 'right' | 'top' | 'bottom' | 'nearest') => void
  viewMode: 'schematic' | 'formboard'
  parts: PartImageLibrary
  library: PartsLibrary
  onSaveToLibrary: (part: LibraryPart) => void
}): React.JSX.Element {
  const set = (fn: (c: Connector) => void): void =>
    edit((d) => {
      const c = d.connectors.find((x) => x.id === conn.id)
      if (c) fn(c)
    })
  const applyCavityTemplate = useHarnessStore((s) => s.applyCavityTemplate)
  const setPinOrderReversed = useHarnessStore((s) => s.setPinOrderReversed)

  const placement = doc.placements.find((p) => p.refId === conn.id)

  const cavityWired = (cavityId: string): boolean =>
    doc.wires.some((w) => w.ends.some((e) => e.type === 'cavity' && e.cavityId === cavityId))

  const addCavity = (): void =>
    set((c) => {
      const used = new Set(c.cavities.map((cv) => cv.position))
      let n = 1
      while (used.has(String(n))) n++
      c.cavities.push({ id: newId(), position: String(n), status: 'populated' })
    })

  return (
    <div className="panel__section">
      <div className="panel__kind">Connector</div>

      <Field label="Designator">
        <TextEdit
          value={conn.designator}
          normalize={commitDesignator}
          onCommit={(v) => set((c) => (c.designator = v))}
        />
      </Field>
      <Field label="Gender">
        <SelectEdit
          value={conn.gender ?? ''}
          options={GENDER_OPTS as unknown as { value: string; label: string }[]}
          onCommit={(v) =>
            set((c) => (c.gender = v ? (v as Connector['gender']) : undefined))
          }
        />
      </Field>
      <Field label="Housing part">
        <PartPicker
          value={conn.housing}
          kinds={['connector']}
          library={library}
          onCommit={(ref) => set((c) => (c.housing = ref))}
        />
      </Field>
      {(() => {
        const lp = conn.housing ? library.resolve(conn.housing.partNumber) : undefined
        const wired = conn.cavities.some((cv) => cavityWired(cv.id))
        // Compare in the same natural-sorted order `sortedCavities` gives the
        // connector's own cavities — otherwise a library record whose cavities
        // happen to be listed "2, 1" reports a spurious difference against an
        // identical connector.
        const libraryCavitiesSorted =
          lp?.kind === 'connector' ? [...lp.connector!.cavities].sort((a, b) => natCompare(a.position, b.position)) : undefined
        const tplDiffers =
          lp?.kind === 'connector' &&
          (libraryCavitiesSorted!.length !== conn.cavities.length ||
            libraryCavitiesSorted!.some((c, i) => c.position !== sortedCavities(conn)[i]?.position))
        return lp?.kind === 'connector' && tplDiffers ? (
          <Field label="Template">
            <button
              className="panel__add"
              disabled={wired}
              title={
                wired
                  ? 'Cavities have wires — delete them first'
                  : `Replace cavities with the ${lp.connector!.cavities.length} in the library record`
              }
              onClick={() => applyCavityTemplate(conn.id, lp, library.resolve)}
            >
              Apply cavity template ({lp.connector!.cavities.length})
            </button>
          </Field>
        ) : null
      })()}
      <BodyPictureRow doc={doc} id={conn.id} parts={parts} />
      <Field label="Notes">
        <TextEdit
          multiline
          value={conn.notes ?? ''}
          onCommit={(v) => set((c) => (c.notes = v.trim() || undefined))}
        />
      </Field>
      {/* Schematic-only: on the formboard a connector is ONE dot, so there is
          no per-cavity exit side to choose. */}
      {viewMode === 'schematic' && (
        <Field label="Pin exit side">
          <SelectEdit
            value={placement?.schematicExitSide ?? 'right'}
            options={EXIT_SIDE_SCHEMATIC_OPTS}
            onCommit={(side) => setExitSide(conn.id, side)}
          />
        </Field>
      )}
      {viewMode === 'schematic' && (
        <Field label="Reverse pin order">
          <input
            type="checkbox"
            title="Mirror the symbol top↔bottom: last pin on top"
            checked={placement?.schematicPinOrderReversed === true}
            onChange={(e) => setPinOrderReversed(conn.id, e.target.checked)}
          />
        </Field>
      )}

      <div className="panel__subhead">
        Cavities ({conn.cavities.length})
        <button className="panel__add" onClick={addCavity}>
          + Add
        </button>
      </div>
      {/* `--cavities` carries BOTH the five-column width budget and the
          `table-layout: fixed` that enforces it. The other three `.cavtable`s
          (the segment's "Carries" list, the library dialog's detail table,
          LibraryPartForm's) share only the plate and keep auto widths — fixed
          layout with no declared widths splits the row equally, which is wrong
          for all three. */}
      <table className="cavtable cavtable--cavities">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Status</th>
            <th>Pin</th>
            <th>Seal</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortedCavities(conn).map((cv) => {
            const setCav = (fn: (c: Connector['cavities'][number]) => void): void =>
              set((c) => {
                const target = c.cavities.find((x) => x.id === cv.id)
                if (target) fn(target)
              })
            const wired = cavityWired(cv.id)
            return (
              <tr key={cv.id}>
                <td>
                  <TextEdit value={cv.position} onCommit={(v) => setCav((c) => (c.position = v))} />
                </td>
                <td>
                  <SelectEdit
                    value={cv.status}
                    options={STATUS_OPTS}
                    onCommit={(s) => setCav((c) => (c.status = s))}
                  />
                </td>
                <td>
                  {/* A short placeholder: the default "search or type a part
                      number" truncates to "search o…" in a table cell. */}
                  <PartPicker
                    value={cv.pin}
                    kinds={['pin']}
                    library={library}
                    placeholder="pin…"
                    onCommit={(ref) => setCav((c) => (c.pin = ref))}
                  />
                </td>
                <td>
                  <PartPicker
                    value={cv.seal}
                    kinds={['seal']}
                    library={library}
                    placeholder="seal…"
                    onCommit={(ref) => setCav((c) => (c.seal = ref))}
                  />
                </td>
                <td>
                  <button
                    className="cavtable__del"
                    disabled={wired}
                    title={wired ? 'Cavity has wires — delete them first' : 'Remove cavity'}
                    onClick={() => set((c) => (c.cavities = c.cavities.filter((x) => x.id !== cv.id)))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Field label="Library">
        <button
          className="panel__add"
          disabled={!library.dir || !partFromConnector(conn)}
          title={
            !library.dir
              ? 'Set the parts library folder first'
              : !conn.housing?.partNumber
                ? 'Set a housing part number first'
                : 'Save this connector as a library part'
          }
          onClick={() => {
            const p = partFromConnector(conn)
            if (p) onSaveToLibrary(p)
          }}
        >
          Save to library…
        </button>
      </Field>
    </div>
  )
}

// ───────────────────────────── Free terminal ────────────────────────────

const FT_KINDS: { value: FreeTerminalKind; label: string }[] = [
  { value: 'ring', label: 'ring' },
  { value: 'ferrule', label: 'ferrule' },
  { value: 'eyelet', label: 'eyelet' },
  { value: 'blade', label: 'blade' },
  { value: 'fork', label: 'fork' },
  { value: 'bare', label: 'bare' },
  { value: 'tinned', label: 'tinned' }
]

function FreeTerminalEditor({
  ft,
  doc,
  edit,
  parts,
  library,
  onSaveToLibrary
}: {
  ft: FreeTerminal
  doc: HarnessDocument
  edit: Edit
  parts: PartImageLibrary
  library: PartsLibrary
  onSaveToLibrary: (part: LibraryPart) => void
}): React.JSX.Element {
  const set = (fn: (t: FreeTerminal) => void): void =>
    edit((d) => {
      const t = d.freeTerminals.find((x) => x.id === ft.id)
      if (t) fn(t)
    })

  return (
    <div className="panel__section">
      <div className="panel__kind">Free terminal</div>
      <Field label="Designator">
        <TextEdit
          value={ft.designator}
          normalize={commitDesignator}
          onCommit={(d) => set((t) => (t.designator = d))}
        />
      </Field>
      <Field label="Kind">
        <SelectEdit value={ft.kind} options={FT_KINDS} onCommit={(k) => set((t) => (t.kind = k))} />
      </Field>
      <Field label="Lands on">
        <TextEdit
          value={ft.landsOn ?? ''}
          placeholder="B+ stud, M6 GND…"
          onCommit={(v) => set((t) => (t.landsOn = v.trim() || undefined))}
        />
      </Field>
      <Field label="Part">
        <PartPicker
          value={ft.part}
          kinds={['terminal']}
          library={library}
          onCommit={(ref) => set((t) => (t.part = ref))}
        />
      </Field>
      <BodyPictureRow doc={doc} id={ft.id} parts={parts} />
      <Field label="Library">
        <button
          className="panel__add"
          disabled={!library.dir || !partFromFreeTerminal(ft)}
          title={
            !library.dir
              ? 'Set the parts library folder first'
              : !ft.part?.partNumber
                ? 'Set a part number first'
                : 'Save this terminal as a library part'
          }
          onClick={() => {
            const p = partFromFreeTerminal(ft)
            if (p) onSaveToLibrary(p)
          }}
        >
          Save to library…
        </button>
      </Field>
    </div>
  )
}

// ───────────────────────────────── Splice ──────────────────────────────────

const SPLICE_KINDS: { value: SpliceKind; label: string }[] = [
  { value: 'butt', label: 'butt' },
  { value: 'solder_sleeve', label: 'solder sleeve' },
  { value: 'clip', label: 'clip' },
  { value: 'weld', label: 'weld' },
  { value: 'ultrasonic', label: 'ultrasonic' }
]

function SpliceEditor({
  sp,
  doc,
  edit,
  parts,
  library,
  onSaveToLibrary
}: {
  sp: Splice
  doc: HarnessDocument
  edit: Edit
  parts: PartImageLibrary
  library: PartsLibrary
  onSaveToLibrary: (part: LibraryPart) => void
}): React.JSX.Element {
  const set = (fn: (s: Splice) => void): void =>
    edit((d) => {
      const s = d.splices.find((x) => x.id === sp.id)
      if (s) fn(s)
    })

  return (
    <div className="panel__section">
      <div className="panel__kind">Splice</div>
      <Field label="Designator">
        <TextEdit
          value={sp.designator}
          normalize={commitDesignator}
          onCommit={(d) => set((s) => (s.designator = d))}
        />
      </Field>
      <Field label="Kind">
        <SelectEdit
          value={sp.kind}
          options={SPLICE_KINDS}
          onCommit={(k) => set((s) => (s.kind = k))}
        />
      </Field>
      <Field label="Part">
        <PartPicker
          value={sp.part}
          kinds={['splice']}
          library={library}
          onCommit={(ref) => set((s) => (s.part = ref))}
        />
      </Field>
      <BodyPictureRow doc={doc} id={sp.id} parts={parts} />
      <Field label="Library">
        <button
          className="panel__add"
          disabled={!library.dir || !partFromSplice(sp)}
          title={
            !library.dir
              ? 'Set the parts library folder first'
              : !sp.part?.partNumber
                ? 'Set a part number first'
                : 'Save this splice as a library part'
          }
          onClick={() => {
            const p = partFromSplice(sp)
            if (p) onSaveToLibrary(p)
          }}
        >
          Save to library…
        </button>
      </Field>
    </div>
  )
}

// ──────────────────────── Create treatments from selection ───────────────────

/** Contextual + Twist / + Sleeving / + Label buttons, gated by the live selection. */
function CreateActions({
  doc,
  selection,
  viewMode,
  onCreated
}: {
  doc: HarnessDocument
  selection: Selection
  viewMode: 'schematic' | 'formboard'
  onCreated: (kind: 'sleeving' | 'twist' | 'label', id: string) => void
}): React.JSX.Element | null {
  const addTwist = useHarnessStore((s) => s.addTwist)
  const addSleeving = useHarnessStore((s) => s.addSleeving)
  const addLabel = useHarnessStore((s) => s.addLabel)

  const edgeIds =
    selection.kind === 'multi' ? selection.edgeIds : selection.kind === 'edge' ? [selection.id] : []
  const nodeIds =
    selection.kind === 'multi' ? selection.nodeIds : selection.kind === 'node' ? [selection.id] : []

  const btns: React.JSX.Element[] = []
  if (viewMode === 'schematic') {
    const wireIds = edgeIds.filter((id) => doc.wires.some((w) => w.id === id))
    if (wireIds.length >= 2) {
      const span = twistSpanSegments(doc, wireIds)
      btns.push(
        <button
          key="twist"
          title={
            span.length === 0
              ? 'Twist selected wires (no shared routed run yet — span fills in once they are bundled in the formboard)'
              : 'Twist selected wires over their shared run'
          }
          onClick={() => {
            // addTwist/addSleeving return null when the span is not one
            // contiguous run (R2) — select only what actually got created.
            const id = addTwist(wireIds, span)
            if (id) onCreated('twist', id)
          }}
        >
          + Twist
        </button>
      )
    }
    if (wireIds.length === 1) {
      const wid = wireIds[0]
      btns.push(
        <button
          key="sleeve"
          onClick={() => {
            const id = addSleeving({ type: 'wire', wireId: wid }, wireRoutePath(doc, wid))
            if (id) onCreated('sleeving', id)
          }}
        >
          + Sleeving
        </button>,
        <button
          key="label"
          onClick={() => {
            const t = { type: 'wire', wireId: wid } as const
            onCreated('label', addLabel(t, 'wireMarker', '', labelDefaultPos(doc, t)))
          }}
        >
          + Label
        </button>
      )
    }
  } else {
    const segIds = edgeIds.filter((id) => doc.segments.some((s) => s.id === id))
    const branchIds = nodeIds.filter((id) => doc.branchPoints.some((b) => b.id === id))
    if (segIds.length >= 1) {
      // A run carrying exactly one wire → sleeve that wire; a run inside one
      // bundle (≥2 wires) → sleeve the bundle. Wire target takes precedence.
      const wireRes = sleevingFromSegments(doc, segIds)
      const bundleRes = wireRes ? null : sleevingBundleFromSegments(doc, segIds)
      const can = wireRes ?? bundleRes
      btns.push(
        <button
          key="sleeve"
          disabled={!can}
          title={
            wireRes
              ? 'Sleeve this wire run'
              : bundleRes
                ? 'Sleeve this bundle run'
                : 'select a contiguous run of one wire or one bundle'
          }
          onClick={() => {
            const id = wireRes
              ? addSleeving({ type: 'wire', wireId: wireRes.wireId }, wireRes.orderedSegmentIds)
              : bundleRes
                ? addSleeving({ type: 'bundle', bundleId: bundleRes.bundleId }, bundleRes.orderedSegmentIds)
                : null
            if (id) onCreated('sleeving', id)
          }}
        >
          + Sleeving
        </button>
      )
      if (segIds.length === 1) {
        const t = { type: 'branch', segmentId: segIds[0] } as const
        btns.push(
          <button key="label" onClick={() => onCreated('label', addLabel(t, 'callout', '', labelDefaultPos(doc, t)))}>
            + Label
          </button>
        )
      }
    }
    if (branchIds.length === 1) {
      const t = { type: 'branchPoint', branchId: branchIds[0] } as const
      btns.push(
        <button key="blabel" onClick={() => onCreated('label', addLabel(t, 'flag', '', labelDefaultPos(doc, t)))}>
          + Label
        </button>
      )
    }
  }
  return btns.length ? <div className="panel__create">{btns}</div> : null
}

// ──────────────────────────── Sleeving / Twist / Label ───────────────────────

const SLEEVING_TYPES: { value: SleevingType; label: string }[] = [
  { value: 'braided', label: 'Braided' },
  { value: 'convoluted', label: 'Convoluted' },
  { value: 'heatshrink', label: 'Heatshrink' },
  { value: 'pvc', label: 'PVC' },
  { value: 'tape', label: 'Tape' }
]

function SleevingEditor({
  sl,
  doc,
  edit
}: {
  sl: Sleeving
  doc: HarnessDocument
  edit: Edit
}): React.JSX.Element {
  const len = spanLengthMm(doc, sl.span)
  let covers = 'wire'
  if (sl.target.type === 'bundle') {
    const bundleId = sl.target.bundleId
    covers = `bundle (${doc.bundles.find((b) => b.id === bundleId)?.memberWireIds.length ?? 0} wires)`
  } else if (sl.target.type === 'cable') {
    const cableId = sl.target.cableId
    covers = `cable ${doc.cables.find((c) => c.id === cableId)?.name ?? ''}`
  }
  return (
    <>
      <div className="panel__kind">Sleeving</div>
      <Field label="Type">
        <SelectEdit
          value={sl.sleevingType}
          options={SLEEVING_TYPES}
          onCommit={(v) =>
            edit((d) => {
              const x = d.sleeving.find((s) => s.id === sl.id)
              if (x) x.sleevingType = v
            })
          }
        />
      </Field>
      <Field label="Size">
        <TextEdit
          value={sl.size ?? ''}
          onCommit={(v) =>
            edit((d) => {
              const x = d.sleeving.find((s) => s.id === sl.id)
              if (x) x.size = v || undefined
            })
          }
        />
      </Field>
      <Field label="Colour">
        <TextEdit
          value={sl.color ?? ''}
          onCommit={(v) =>
            edit((d) => {
              const x = d.sleeving.find((s) => s.id === sl.id)
              if (x) x.color = v || undefined
            })
          }
        />
      </Field>
      <Field label="Covers">
        <span className="pf__ro">{covers}</span>
      </Field>
      <Field label="Span">
        <span className="pf__ro">
          {sl.span.segmentIds.length} seg{len != null ? ` · ${len.toFixed(1)} mm` : ''}
        </span>
      </Field>
      <p className="panel__hint">To change the covered run, delete and re-create from a new selection.</p>
    </>
  )
}

function TwistEditor({
  tw,
  doc,
  edit
}: {
  tw: Twist
  doc: HarnessDocument
  edit: Edit
}): React.JSX.Element {
  const len = spanLengthMm(doc, tw.span)
  return (
    <>
      <div className="panel__kind">Twist</div>
      <Field label="Wires">
        <span className="pf__ro">{tw.wireIds.length}</span>
      </Field>
      <Field label="Span">
        <span className="pf__ro">
          {tw.span.segmentIds.length} seg{len != null ? ` · ${len.toFixed(1)} mm` : ''}
        </span>
      </Field>
      <Field label="Lay length (mm)">
        <NumberEdit
          value={tw.layLengthMm}
          optional
          onCommit={(v) =>
            edit((d) => {
              const x = d.twists.find((t) => t.id === tw.id)
              if (x) x.layLengthMm = v
            })
          }
        />
      </Field>
      {tw.span.segmentIds.length === 0 && (
        <p className="panel__hint">
          No shared run yet — the span fills in once these wires are co-routed through a common
          loom limb (add branch points in the formboard). Lay length is recorded for the build.
        </p>
      )}
    </>
  )
}

const LABEL_KINDS: { value: LabelKind; label: string }[] = (
  Object.keys(LABEL_KIND_LABELS) as LabelKind[]
).map((value) => ({ value, label: LABEL_KIND_LABELS[value] }))

function LabelEditor({ lb, edit, doc }: { lb: Label; edit: Edit; doc: HarnessDocument }): React.JSX.Element {
  const anchor = lb.anchor
  const segLen = anchor ? segmentLengthMm(doc, anchor.segmentId) : null
  return (
    <>
      <div className="panel__kind">Label</div>
      <Field label="Kind">
        <SelectEdit
          value={lb.kind}
          options={LABEL_KINDS}
          onCommit={(v) =>
            edit((d) => {
              const x = d.labels.find((l) => l.id === lb.id)
              if (x) x.kind = v
            })
          }
        />
      </Field>
      <Field label="Text">
        <TextEdit
          value={lb.text}
          onCommit={(v) =>
            edit((d) => {
              const x = d.labels.find((l) => l.id === lb.id)
              if (x) x.text = v
            })
          }
        />
      </Field>
      {anchor ? (
        segLen != null && segLen > 0 ? (
          <Field label="mm from nearest end">
            <NumberEdit
              value={Math.round(anchorMmFromNearestEnd(anchor.fraction, segLen))}
              onCommit={(v) =>
                edit((d) => {
                  const x = d.labels.find((l) => l.id === lb.id)
                  if (x && x.anchor && v != null)
                    x.anchor.fraction = anchorFractionFromNearestEnd(anchor.fraction, v, segLen)
                })
              }
            />
          </Field>
        ) : (
          <Field label="Position (%)">
            <NumberEdit
              value={Math.round(anchor.fraction * 100)}
              onCommit={(v) =>
                edit((d) => {
                  const x = d.labels.find((l) => l.id === lb.id)
                  if (x && x.anchor && v != null) x.anchor.fraction = Math.min(1, Math.max(0, v / 100))
                })
              }
            />
          </Field>
        )
      ) : (
        <>
          <Field label="Leader">
            <input
              type="checkbox"
              checked={!!lb.leader}
              onChange={(e) =>
                edit((d) => {
                  const x = d.labels.find((l) => l.id === lb.id)
                  if (x) x.leader = e.target.checked
                })
              }
            />
          </Field>
          <Field label="X (mm)">
            <NumberEdit
              value={lb.pos.x}
              onCommit={(v) =>
                edit((d) => {
                  const x = d.labels.find((l) => l.id === lb.id)
                  if (x && v != null) x.pos.x = v
                })
              }
            />
          </Field>
          <Field label="Y (mm)">
            <NumberEdit
              value={lb.pos.y}
              onCommit={(v) =>
                edit((d) => {
                  const x = d.labels.find((l) => l.id === lb.id)
                  if (x && v != null) x.pos.y = v
                })
              }
            />
          </Field>
        </>
      )}
    </>
  )
}

// ──────────────────────── Treatments & Labels list ───────────────────────────

/** Always-on list of every sleeving/twist/label: click to select+edit, × to delete. */
function TreatmentsList({
  doc,
  selectedId,
  onSelect
}: {
  doc: HarnessDocument
  selectedId: string | null
  onSelect: (kind: 'sleeving' | 'twist' | 'label', id: string) => void
}): React.JSX.Element | null {
  const removeSleeving = useHarnessStore((s) => s.removeSleeving)
  const removeTwist = useHarnessStore((s) => s.removeTwist)
  const removeLabel = useHarnessStore((s) => s.removeLabel)
  if (doc.sleeving.length + doc.twists.length + doc.labels.length === 0) return null

  const row = (
    id: string,
    label: string,
    onPick: () => void,
    onDelete: () => void
  ): React.JSX.Element => (
    <div key={id} className={`panel__list-row${selectedId === id ? ' panel__list-row--sel' : ''}`}>
      <button className="panel__list-pick" onClick={onPick}>
        {label}
      </button>
      <button className="panel__list-del" title="Delete" onClick={onDelete}>
        ×
      </button>
    </div>
  )

  return (
    <div className="panel__list">
      <div className="panel__list-title">Treatments &amp; Labels</div>
      {doc.sleeving.map((sl) =>
        row(sl.id, `${sl.sleevingType} · ${sl.span.segmentIds.length} seg`, () => onSelect('sleeving', sl.id), () => removeSleeving(sl.id))
      )}
      {doc.twists.map((tw) =>
        row(tw.id, `Twist · ${tw.wireIds.length} wires`, () => onSelect('twist', tw.id), () => removeTwist(tw.id))
      )}
      {doc.labels.map((lb) =>
        row(lb.id, `${lb.kind}: "${lb.text || '—'}"`, () => onSelect('label', lb.id), () => removeLabel(lb.id))
      )}
    </div>
  )
}
