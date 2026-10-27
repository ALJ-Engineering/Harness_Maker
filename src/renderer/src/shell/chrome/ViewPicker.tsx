import { useEffect, useRef, useState } from 'react'
import type { PaneView } from '../../store'

/**
 * The views a pane can show, in menu order. Two today; branch 2 widens
 * `PaneView` to four (Parts table, Connections table) and they land here.
 *
 * The dots are the design's per-view signal colours: the schematic takes the
 * accent, the formboard a green of its own. Both are deliberate chrome
 * literals, not print colours — nothing here reaches `shared/print/`.
 */
const VIEWS: { view: PaneView; label: string; dot: string }[] = [
  { view: 'schematic', label: 'Schematic', dot: 'var(--accent)' },
  { view: 'formboard', label: 'Formboard', dot: '#3ec26b' }
]

export interface ViewPickerProps {
  /** The view this pane is showing. */
  view: PaneView
  /** Chosen view. Only ever changes the ONE pane this picker belongs to. */
  onChange: (v: PaneView) => void
  /** "Left"/"Right" while the canvas is split; omitted when there is one pane. */
  side?: string
}

/**
 * A chrome chip naming what one pane shows, opening a menu of the alternatives
 * with a `✓` on the current one. One instance per VISIBLE pane, so in the split
 * view there are two and each writes only its own side.
 */
export function ViewPicker({ view, onChange, side }: ViewPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = VIEWS.find((v) => v.view === view) ?? VIEWS[0]

  // Close on a click anywhere else, or on Escape. Capture phase: React Flow
  // stops propagation on some pointer events, and a menu that only closes on a
  // bubbled click would be left hanging over the canvas.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node | null)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="vp" ref={rootRef}>
      <button
        className={`chip chip--btn${open ? ' chip--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={side ? `${side} pane — choose what it shows` : 'Choose what this pane shows'}
      >
        <span className="chip__dot" style={{ background: current.dot }} />
        {side && <span className="chip__mute">{side}</span>}
        {current.label}
        <span className="chip__caret">▾</span>
      </button>
      {open && (
        <div className="vp__menu" role="menu">
          {VIEWS.map((v) => (
            <button
              key={v.view}
              className="vp__item"
              role="menuitem"
              onClick={() => {
                onChange(v.view)
                setOpen(false)
              }}
            >
              <span className="chip__dot" style={{ background: v.dot }} />
              {v.label}
              <span className="vp__tick">{v.view === view ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
