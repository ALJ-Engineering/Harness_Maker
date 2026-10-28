import type { PaneView } from '../../store'

/**
 * The views a pane can show, in toggle order. Two today; branch 2 widens
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
 * What one pane shows, as a segmented toggle like Single / Split: every view is
 * a button and the current one is pressed, so switching is one click, not a
 * menu. One instance per VISIBLE pane, so in the split view there are two and
 * each writes only its own side.
 */
export function ViewPicker({ view, onChange, side }: ViewPickerProps): React.JSX.Element {
  return (
    <div className="seg" role="group" aria-label={side ? `${side} pane view` : 'Pane view'}>
      {side && <span className="seg__side">{side}</span>}
      {VIEWS.map((v) => (
        <button
          key={v.view}
          className={`seg__btn${v.view === view ? ' seg__btn--on' : ''}`}
          aria-pressed={v.view === view}
          onClick={() => v.view !== view && onChange(v.view)}
          title={side ? `Show the ${v.label.toLowerCase()} in the ${side.toLowerCase()} pane` : `Show the ${v.label.toLowerCase()}`}
        >
          <span className="chip__dot" style={{ background: v.dot }} />
          {v.label}
        </button>
      ))}
    </div>
  )
}
