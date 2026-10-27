import { useLayoutEffect, useRef, useState } from 'react'
import { EdgeLabelRenderer, getStraightPath, type EdgeProps } from '@xyflow/react'
import type { Id } from '@shared/model/schema'
import type { RescaleEnd, RescaleResult } from '@shared/model/rescale'
import { strokeForColor } from './toFlow'
import { lengthLabel } from '@shared/model/formboard'
import { useHarnessStore } from '../store'
import { resolveLengthCommit } from './lengthInput'

/** Formboard light literals — this projection never reads a theme token (docs/ARCHITECTURE.md "Theming"). */
const LABEL_INK = '#444'
const BROKEN_RED = '#d32f2f'
/** Arrow triangle size in flow px (≈ mm on the formboard). */
const ARROW_PX = 8
/** Clearance between the label box and an arrow, along the limb. */
const ARROW_GAP_PX = 1.5

const RESCALE_REFUSAL: Partial<Record<RescaleResult, string>> = {
  loop: "Can't rescale: this limb is part of a loop, so moving one side would stretch other limbs.",
  unresolved: "Can't rescale: one end of this limb has no position."
}

export interface FormboardSegmentEdgeData extends Record<string, unknown> {
  /** IEC colour abbreviation or `#hex`; omitted when `bundle` is true. */
  colour?: string
  /** Additional stripe colours (dashed overlay, same as WireEdge). */
  stripes?: string[]
  /** True when two or more wires share this segment → draw as grey bundle band. */
  bundle: boolean
  /**
   * EFFECTIVE run length in mm — the typed `specifiedLengthMm` when set, else
   * the drawn one — or null if untyped and unresolved. What the label shows.
   */
  lengthMm?: number | null
  /** The typed manufacturing length, when the segment carries one. */
  specifiedLengthMm?: number
  /** Typed length no longer matches the drawing → red label + rescale arrows. */
  broken: boolean
  /** Broken AND the typed length is shorter than the drawn one → the arrows point inward, at the label. */
  shrink: boolean
  /** The segment this edge draws (= edge id). Source = segment `from`, target = `to`. */
  segmentId: Id
  /** True when this segment is a member of the selected treatment. */
  highlighted?: boolean
}

/**
 * Formboard segment edge: straight (`getStraightPath`), coloured by the
 * wire(s) routed through the segment.
 *
 * - Bundle (2+ wires): grey `#999`, width 3.
 * - Single wire: `strokeForColor(colour)` width 1.5, plus a dashed overlay
 *   per stripe (mirrors `WireEdge` candy-stripe rendering but straight).
 * - Optional length label (no wire size) at the midpoint via `EdgeLabelRenderer`;
 *   see `SegmentLengthLabel` for its click-to-type and rescale arrows.
 *
 * Keeps the `react-flow__edge-path` class on the primary path so React Flow's
 * built-in selection / hover CSS still apply.
 */
export function FormboardSegmentEdge(props: EdgeProps): React.JSX.Element {
  const { sourceX, sourceY, targetX, targetY, data, selected } = props

  const [path, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY
  })

  const d = (data ?? { bundle: false, broken: false, segmentId: props.id }) as FormboardSegmentEdgeData
  const isBundle = d.bundle
  const stripes = d.stripes ?? []

  // Bundle: thick grey band. Single wire: conductor colour, thinner.
  const stroke = isBundle ? '#999' : strokeForColor(d.colour ?? 'GY')
  const strokeWidth = selected ? (isBundle ? 5 : 3) : isBundle ? 3 : 1.5

  return (
    <>
      {d.highlighted && (
        <path
          d={path}
          style={{ stroke: '#fb8c00', strokeWidth: strokeWidth + 6, fill: 'none', opacity: 0.4 }}
        />
      )}
      {/* Primary path — keeps the React Flow class so selection halo applies */}
      <path
        className="react-flow__edge-path"
        d={path}
        style={{ stroke, strokeWidth, fill: 'none' }}
      />

      {/* Candy-stripe dashed overlay for single-wire stripes (same as WireEdge) */}
      {!isBundle &&
        stripes.map((s, i) => (
          <path
            key={`${s}-${i}`}
            d={path}
            style={{
              stroke: strokeForColor(s),
              strokeWidth,
              fill: 'none',
              strokeDasharray: '7 7',
              strokeDashoffset: i * 7
            }}
          />
        ))}

      {/* Length label at the midpoint (click to type a length) */}
      <SegmentLengthLabel
        d={d}
        labelX={labelX}
        labelY={labelY}
        angleRad={Math.atan2(targetY - sourceY, targetX - sourceX)}
      />
    </>
  )
}

/**
 * The limb's `lengthLabel` text. A single click turns it into a number
 * input prefilled with the effective length (rounded): Enter commits through
 * `setSegmentLength` (empty → clears the typed length; a partial entry such as
 * "-" or "1e", zero or a negative cancels — `parseLengthInput`), Esc cancels,
 * blur commits only a changed value. While `broken` the text is red and two ▶ buttons sit on
 * the limb's own axis either side of the label, each pointing
 * away from the label when the limb must grow and toward it when it must shrink; each moves the end on its side (`rescaleSegment(id, 'to' | 'from')`; source = `from`, target = `to`,
 * as `toFormboard.ts` builds the edge).
 *
 * Every interactive element is `nodrag nopan` and stops pointerdown so a press
 * here never starts a selection box, a pan or a node drag; the input also stops
 * key events so nothing above it sees Enter / Backspace / Delete.
 */
function SegmentLengthLabel({
  d,
  labelX,
  labelY,
  angleRad
}: {
  d: FormboardSegmentEdgeData
  labelX: number
  labelY: number
  angleRad: number
}): React.JSX.Element | null {
  const setSegmentLength = useHarnessStore((s) => s.setSegmentLength)
  const rescaleSegment = useHarnessStore((s) => s.rescaleSegment)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const done = useRef(false) // Enter/Esc already resolved this edit; ignore the unmount blur
  const labelRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  const labelText = lengthLabel(d.lengthMm)
  const prefill = d.lengthMm == null ? '' : String(Math.round(d.lengthMm))

  // The box size only places the rescale arrows, so measure only while they
  // show, and again only when the label's text (hence its width) changes.
  const showArrows = d.broken && !editing
  useLayoutEffect(() => {
    if (!showArrows) return
    const el = labelRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
  }, [showArrows, labelText])

  if (!labelText && !editing) return null

  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  const begin = (): void => {
    if (editing) return
    done.current = false
    setDraft(prefill)
    setEditing(true)
  }
  const finish = (commit: boolean, badInput = false): void => {
    if (done.current) return
    done.current = true
    setEditing(false)
    if (!commit) return
    const v = resolveLengthCommit(draft, prefill, badInput)
    if (v !== 'cancel' && v !== 'skip') setSegmentLength(d.segmentId, v)
  }
  const press = (toward: RescaleEnd): void => {
    const r = rescaleSegment(d.segmentId, toward)
    const msg = RESCALE_REFUSAL[r]
    if (msg) window.alert(msg)
  }

  const colour = d.broken ? BROKEN_RED : LABEL_INK
  const ux = Math.cos(angleRad)
  const uy = Math.sin(angleRad)
  // Half the label box's extent along the limb, so the arrows clear it at any angle.
  // Each arrow sits on its own side of the label and points away from it when
  // the limb must grow, toward it when it must shrink.
  const reach = (Math.abs(ux) * box.w) / 2 + (Math.abs(uy) * box.h) / 2 + ARROW_GAP_PX + ARROW_PX / 2
  const deg = (angleRad * 180) / Math.PI

  const arrow = (toward: RescaleEnd, sign: 1 | -1): React.JSX.Element => (
    <button
      type="button"
      className="segment-rescale-arrow nodrag nopan"
      data-segment-id={d.segmentId}
      data-toward={toward}
      title={`Rescale: move the ${toward === 'to' ? 'target' : 'source'} side to the typed length`}
      onPointerDown={stop}
      onClick={(e) => {
        e.stopPropagation()
        press(toward)
      }}
      style={{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${labelX + sign * ux * reach}px, ${labelY + sign * uy * reach}px) rotate(${(sign === 1) !== d.shrink ? deg : deg + 180}deg)`,
        width: ARROW_PX,
        height: ARROW_PX,
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        pointerEvents: 'all'
      }}
    >
      <svg width={ARROW_PX} height={ARROW_PX} viewBox="0 0 8 8" style={{ display: 'block' }}>
        <polygon points="0,0 8,4 0,8" fill={BROKEN_RED} />
      </svg>
    </button>
  )

  return (
    <EdgeLabelRenderer>
      <div
        ref={labelRef}
        className="segment-gauge-label nodrag nopan"
        data-segment-id={d.segmentId}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation()
          begin()
        }}
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          fontSize: 6,
          background: 'rgba(255,255,255,0.85)',
          padding: '0 2px',
          borderRadius: 2,
          pointerEvents: 'all',
          cursor: editing ? 'auto' : 'text',
          color: colour,
          whiteSpace: 'nowrap'
        }}
      >
        {editing ? (
          <>
            <input
              className="segment-length-input nodrag nopan"
              type="number"
              step="1"
              autoFocus
              value={draft}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onPointerDown={stop}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') finish(true, e.currentTarget.validity.badInput)
                else if (e.key === 'Escape') finish(false)
              }}
              onKeyUp={stop}
              onBlur={(e) => {
                const badInput = e.currentTarget.validity.badInput
                finish(true, badInput)
              }}
              style={{
                width: '4em',
                font: 'inherit',
                color: LABEL_INK,
                background: '#fff',
                border: '1px solid #999',
                borderRadius: 1,
                padding: 0,
                margin: 0
              }}
            />{' '}
            mm
          </>
        ) : (
          labelText
        )}
      </div>
      {showArrows && (
        <>
          {arrow('to', 1)}
          {arrow('from', -1)}
        </>
      )}
    </EdgeLabelRenderer>
  )
}
