import type { PaneView } from '../../store'
import { ViewPicker } from './ViewPicker'

export interface TopChromeProps {
  /** The document's title-block part number, or the file's base name when it has none. */
  fileLabel: string
  /** Unsaved changes — shown as the `•` on the file chip. */
  dirty: boolean
  /** Title-block revision; the `REV x` badge is omitted when absent. */
  revision?: string
  /** Open the parts library browser (the same dialog as ⌘L). */
  onSearchParts: () => void
  /** Pane state. One picker per VISIBLE pane, so one chip when `split` is off. */
  panes: { split: boolean; left: PaneView; right: PaneView }
  setPaneView: (side: 'left' | 'right', view: PaneView) => void
}

/**
 * The floating top strip: what document this is, and what each pane is showing.
 *
 * The strip itself is `pointer-events: none` so the canvas underneath keeps
 * every pan, marquee and right-click it had when a solid header sat above it;
 * each control turns them back on for itself.
 *
 * The file chip is INERT here — its dropdown (recent files, document
 * properties) is branch 2. New/Open/Save/Save As live on the native File menu
 * with their accelerators, which is why deleting the docked header strands
 * nothing.
 */
export function TopChrome({
  fileLabel,
  dirty,
  revision,
  onSearchParts,
  panes,
  setPaneView
}: TopChromeProps): React.JSX.Element {
  return (
    <div className="chrome chrome--top">
      <div className="chrome__group">
        <span className="chip chip--file" title={dirty ? 'Unsaved changes' : undefined}>
          {dirty && <span className="chip__dirty">•</span>}
          {fileLabel}
        </span>
        {revision && <span className="chip chip--rev">REV {revision}</span>}
        <button
          className="chip chip--btn"
          onClick={onSearchParts}
          title={`Search the parts library (${window.api.platform === 'darwin' ? '⌘L' : 'Ctrl+L'})`}
        >
          <span className="chip__glyph">⌕</span>
          Parts
        </button>
      </div>
      <div className="chrome__group">
        <ViewPicker
          view={panes.left}
          onChange={(v) => setPaneView('left', v)}
          side={panes.split ? 'Left' : undefined}
        />
        {panes.split && (
          <ViewPicker view={panes.right} onChange={(v) => setPaneView('right', v)} side="Right" />
        )}
      </div>
    </div>
  )
}
